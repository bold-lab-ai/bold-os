// create_project_proposal with levels (#248): a stepping stone explores its open problem and has a
// verifier plan; a northstar or moonshot has neither and is part of projects one level up.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {createProposal} = require('../functions/project-verification-plan');

const PROBLEM = 'ak-' + 'a'.repeat(24);
function fakeDb(docs){
  const store = new Map(Object.entries(docs));
  const ref = (path) => ({path, get: async () => snap(path)});
  const snap = (path) => ({exists: store.has(path), data: () => store.get(path)});
  const db = {
    store,
    collection: (c) => ({doc: (id) => ref(c + '/' + id)}),
    runTransaction: async (fn) => {
      const writes = [];
      const out = await fn({get: async (r) => snap(r.path), set: (r, v) => writes.push([r.path, v])});
      writes.forEach(([p, v]) => store.set(p, v));
      return out;
    }
  };
  return db;
}
const error = (code, message) => Object.assign(new Error(message), {code});
const fingerprint = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const ME = 'me@example.com';
function card(extra){
  return Object.assign({title: 'T', abstractText: 'A', submittedBy: {email: ME}, proposal: {status: 'proposed', more: false}}, extra);
}
const world = () => fakeDb({
  ['problemBank/' + PROBLEM]: {title: 'P', archived: false},
  'projects/north': {title: 'N', level: 'northstar'},
  'projects/moon': {title: 'M', level: 'moonshot', parents: ['north']},
  'projects/stone': {title: 'S'}
});
const propose = (db, c, id = 'card-x') => createProposal({db, error, fingerprint}, {project_id: id, card: c}, ME, 'Me');

test('a stepping stone explores its open problem, with its verifier plan and moonshots', async () => {
  const db = world();
  await propose(db, card({openProblemId: PROBLEM, verificationPlan: {mode: 'benchmark'}, parents: ['moon'], connection: 'how'}));
  const saved = db.store.get('projects/card-x');
  assert.equal(saved.level, undefined);
  assert.deepEqual(saved.parents, ['moon']);
  assert.deepEqual(saved.problems, [PROBLEM]);
  assert.equal(saved.openProblemId, PROBLEM);
  assert.equal(saved.connection, 'how');
});

test('a moonshot is part of northstars and has no problem or verifier', async () => {
  const db = world();
  await propose(db, card({level: 'moonshot', parents: ['north']}));
  const saved = db.store.get('projects/card-x');
  assert.equal(saved.level, 'moonshot');
  assert.deepEqual(saved.parents, ['north']);
  assert.equal(saved.openProblemId, undefined);
  assert.equal(saved.verificationPlan, undefined);
  assert.equal(saved.proposal.more, false);
});

test('a northstar needs nothing above it', async () => {
  const db = world();
  await propose(db, card({level: 'northstar'}));
  assert.equal(db.store.get('projects/card-x').level, 'northstar');
});

test('what is refused', async () => {
  const cases = [
    [card({level: 'moonshot'}), 'invalid-argument', 'a moonshot part of nothing'],
    [card({level: 'moonshot', parents: ['moon']}), 'failed-precondition', 'a moonshot part of a moonshot'],
    [card({level: 'moonshot', parents: ['nowhere']}), 'failed-precondition', 'a parent that is not there'],
    [card({level: 'moonshot', parents: ['north'], openProblemId: PROBLEM}), 'invalid-argument', 'a moonshot with an open problem'],
    [card({level: 'moonshot', parents: ['north'], proposal: {status: 'proposed', more: true, gpuHours: 10}}), 'invalid-argument', 'a moonshot asking for compute'],
    [card({level: 'galaxy'}), 'invalid-argument', 'no such level'],
    [card({parents: ['moon'], verificationPlan: {mode: 'benchmark'}}), 'invalid-argument', 'a stepping stone without its problem'],
    [card({openProblemId: PROBLEM, verificationPlan: {mode: 'benchmark'}, parents: ['north']}), 'failed-precondition', 'a stepping stone part of a northstar']
  ];
  for (const [c, code, what] of cases) await assert.rejects(propose(world(), c), (e) => e.code === code, what);
});
