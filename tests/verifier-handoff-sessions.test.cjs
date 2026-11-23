// Lite handoffs (#43): the member is told once when a session is linked, sees and unlinks it, and has
// their own request limit under the shared service token.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const HASH = 'f'.repeat(64);
process.env.BOLD_LINKED_VERIFIER_HANDOFF_ENABLED = 'true';
process.env.BOLD_LINKED_VERIFIER_SERVICE_TOKEN_SHA256 = HASH;
const {verifierHandoffs} = require('../functions/verifier-handoff');

function fakeDb(){
  const data = new Map();
  const snap = (path) => ({id: path.split('/').pop(), exists: data.has(path), data: () => structuredClone(data.get(path))});
  const doc = (path) => ({id: path.split('/').pop(), path, get: async () => snap(path)});
  const col = (name) => ({
    doc: (id) => doc(name + '/' + id),
    where: (field, op, value) => ({get: async () => ({docs: [...data.keys()]
      .filter((k) => k.startsWith(name + '/') && data.get(k)[field] === value).map(snap)})})
  });
  return {data, collection: col, runTransaction: async (fn) => {
    const writes = [];
    const out = await fn({get: async (r) => snap(r.path), set: (r, v) => writes.push(() => data.set(r.path, structuredClone(v))),
      update: (r, v) => writes.push(() => data.set(r.path, {...data.get(r.path), ...v})), delete: (r) => writes.push(() => data.delete(r.path))});
    writes.forEach((w) => w());
    return out;
  }};
}
const error = (code, message) => Object.assign(new Error(message), {code});
const PROBLEM = 'ak-' + 'a'.repeat(24);
const SESSION = '11111111-2222-3333-4444-555555555555';

async function linked(){
  const db = fakeDb(), told = [];
  const h = verifierHandoffs(db, error, async () => {}, async (x) => told.push(x));
  const {handoff} = await h.issue({problem_id: PROBLEM, project_id: '', project_board: ''}, 'me@example.com');
  const args = {handoff, email: 'Me@example.com', session_id: SESSION};
  return {db, h, told, args, first: await h.claim(args)};
}

test('the member is told once, on the first claim and not on a retry', async () => {
  const {h, told, args, first} = await linked();
  assert.deepEqual(first, {problem_id: PROBLEM, project_id: '', project_board: '', session_id: SESSION});
  assert.deepEqual(await h.claim(args), first);
  assert.equal(told.length, 1);
  assert.equal(told[0].email, 'me@example.com');
  assert.equal(told[0].problem_id, PROBLEM);
});

test('a failing notice leaves the link in place', async () => {
  const db = fakeDb();
  const h = verifierHandoffs(db, error, async () => {}, async () => { throw new Error('Slack is down'); });
  const {handoff} = await h.issue({problem_id: PROBLEM, project_id: '', project_board: ''}, 'me@example.com');
  await h.claim({handoff, email: 'me@example.com', session_id: SESSION});
  assert.ok(db.data.has('verifierSessionClaims/' + SESSION));
});

test('the problem page lists its sessions, and only the member, a PI or an admin unlinks one', async () => {
  const {db, h} = await linked();
  assert.deepEqual((await h.linkedTo(PROBLEM, 'me@example.com')).map((x) => [x.session_id, x.mine]), [[SESSION, true]]);
  assert.equal((await h.linkedTo(PROBLEM, 'other@example.com'))[0].mine, false);
  assert.deepEqual(await h.linkedTo('ak-' + 'b'.repeat(24), 'me@example.com'), []);
  await assert.rejects(h.unlink(PROBLEM, SESSION, 'other@example.com', false), (e) => e.code === 'permission-denied');
  await assert.rejects(h.unlink('ak-' + 'b'.repeat(24), SESSION, 'me@example.com', false), (e) => e.code === 'not-found');
  await assert.rejects(h.unlink(PROBLEM, 'nope', 'me@example.com', false), (e) => e.code === 'invalid-argument');
  await h.unlink(PROBLEM, SESSION, 'other@example.com', true);
  assert.equal(db.data.has('verifierSessionClaims/' + SESSION), false);
});

test('each member has their own limit a minute', async () => {
  const h = verifierHandoffs(fakeDb(), error, async () => {});
  for (let i = 0; i < 60; i++) await h.countFor('me@example.com');
  await assert.rejects(h.countFor('ME@example.com'), (e) => e.code === 'resource-exhausted');
  await h.countFor('other@example.com');
});

test('the handoff code is single-use and its digest is what is stored', async () => {
  const {db, args} = await linked();
  const stored = [...db.data.keys()].filter((k) => k.startsWith('verifierHandoffs/'));
  assert.deepEqual(stored, ['verifierHandoffs/' + crypto.createHash('sha256').update(args.handoff).digest('hex')]);
});
