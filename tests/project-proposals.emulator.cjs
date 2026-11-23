// Firestore rules for proposing a project (projects/{id} proposal), against the demo emulator.
// npx firebase emulators:exec --only firestore --project demo-bold-os "node tests/project-proposals.emulator.cjs"
const assert = require('node:assert/strict');
if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8080' || process.env.GCLOUD_PROJECT !== 'demo-bold-os') throw Error('Use the local demo-bold-os emulators.');
const admin = require('../functions/node_modules/firebase-admin');
admin.initializeApp({ projectId: 'demo-bold-os' }); const db = admin.firestore();

function jwt(email, slack = true) {
  const b = x => Buffer.from(JSON.stringify(x)).toString('base64url'), now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({ aud: 'demo-bold-os', iss: 'https://securetoken.google.com/demo-bold-os', sub: email, user_id: email, email, iat: now, exp: now + 3600,
    firebase: { identities: { [slack ? 'oidc.slack' : 'google.com']: [email] }, sign_in_provider: slack ? 'oidc.slack' : 'google.com' } }) + '.';
}
function value(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return { integerValue: String(v) };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(value) } };
  if (typeof v === 'object') return { mapValue: { fields: fields(v) } };
  return { stringValue: v };
}
function fields(o) { return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, value(v)])); }
const base = 'http://127.0.0.1:8080/v1/projects/demo-bold-os/databases/(default)/documents/';
async function req(path, method, token, body, mask) {
  const q = mask ? '?' + mask.map(f => 'updateMask.fieldPaths=' + f).join('&') : '';
  const r = await fetch(base + path + q, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify({ fields: fields(body) }) : undefined });
  return r.status;
}

(async () => {
  const PI = 'pi@example.com', MEMBER = 'member@example.com';
  await db.doc('roles/pis').set({ emails: [PI] });
  await db.doc('roles/admins').set({ emails: [] });
  await db.doc('members/' + MEMBER).set({ category: 'internal' });
  let n = 0;
  // A stepping stone, part of a moonshot (#248: required).
  const make = (proposal, by = MEMBER, extra = { parents: ['m1'] }) => req('projects?documentId=p' + (++n), 'POST', jwt(by), Object.assign({ title: 'P', submittedBy: { email: by }, proposal }, extra));
  const at = Date.now();

  assert.equal(await make({ status: 'proposed', more: false, at, by: MEMBER }), 200, 'within the standard allowance');
  assert.equal(await make({ status: 'proposed', more: true, gpuHours: 2000, at, by: MEMBER }), 200, 'asking for more, with its hours');
  assert.equal(await make({ status: 'proposed', gpuHours: 2000, at, by: MEMBER }), 200, 'as before the tickbox: hours, so more');
  assert.equal(await make({ status: 'proposed', more: true, at, by: MEMBER }), 403, 'asking for more, no hours');
  assert.equal(await make({ status: 'proposed', more: true, gpuHours: 0, at, by: MEMBER }), 403, 'asking for more, no hours (0)');
  assert.equal(await make({ status: 'proposed', more: false, gpuHours: 2000, at, by: MEMBER }), 403, 'hours without asking for more');
  assert.equal(await make({ status: 'proposed', at, by: MEMBER }), 403, 'neither');
  assert.equal(await make({ status: 'approved', more: false, at, by: MEMBER }), 403, 'approved by its proposer');
  assert.equal(await make({ status: 'proposed', more: true, gpuHours: 2000, dueAt: at, at, by: MEMBER }), 403, 'its own deadline');

  // Its level and what it's part of (#248).
  const std = { status: 'proposed', more: false, at, by: MEMBER };
  assert.equal(await make(std, MEMBER, {}), 403, 'a stepping stone part of nothing');
  assert.equal(await make(std, MEMBER, { parents: [] }), 403, 'a stepping stone part of nothing (empty)');
  assert.equal(await make(std, MEMBER, { problems: ['q1'] }), 200, 'a stepping stone exploring a problem');
  assert.equal(await make(std, MEMBER, { level: 'northstar' }), 200, 'a northstar');
  assert.equal(await make(std, MEMBER, { level: 'moonshot' }), 403, 'a moonshot part of nothing');
  assert.equal(await make(std, MEMBER, { level: 'moonshot', problems: ['q1'] }), 403, 'a moonshot with only problems');
  assert.equal(await make(std, MEMBER, { level: 'moonshot', parents: ['n1'], connection: 'how' }), 200, 'a moonshot part of a northstar');
  assert.equal(await make(std, MEMBER, { level: 'galaxy', parents: ['n1'] }), 403, 'no such level');
  assert.equal(await make({ status: 'proposed', more: true, gpuHours: 10, at, by: MEMBER }, MEMBER, { level: 'moonshot', parents: ['n1'] }), 403, 'a moonshot asking for compute');
  assert.equal(await make(std, MEMBER, { parents: 'm1' }), 403, 'parents not a list');
  // Older projects (no links) stay editable; changing their links needs them linked.
  await db.doc('projects/old').set({ title: 'Old', submittedBy: { email: MEMBER }, proposal: { status: 'approved' } });
  assert.equal(await req('projects/old', 'PATCH', jwt(MEMBER), { title: 'Older' }, ['title']), 200, 'an unlinked project, its title changed');
  assert.equal(await req('projects/old', 'PATCH', jwt(MEMBER), { parents: [] }, ['parents']), 403, 'its links changed to nothing');
  assert.equal(await req('projects/old', 'PATCH', jwt(MEMBER), { parents: ['m1'], connection: 'how' }, ['parents', 'connection']), 200, 'linked up');
  assert.equal(await req('projects/old', 'PATCH', jwt(MEMBER), { level: 'northstar', parents: [] }, ['level', 'parents']), 200, 'made a northstar');
  assert.equal(await req('projects/old', 'PATCH', jwt(MEMBER), { level: 'moonshot' }, ['level']), 403, 'a moonshot part of nothing');
  console.log('project proposal rules: ok');
})().catch((e) => { console.error(e); process.exit(1); });
