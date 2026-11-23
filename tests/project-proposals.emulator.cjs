// Firestore rules for proposing a project (projects/{id} proposal), against the demo emulator.
// npx firebase emulators:exec --only firestore --project demo-bold-os "node tests/project-proposals.emulator.cjs"
const assert = require('node:assert/strict');
if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '') || process.env.GCLOUD_PROJECT !== 'demo-bold-os') throw Error('Use the local demo-bold-os emulators.');
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
  if (typeof v === 'object') return { mapValue: { fields: fields(v) } };
  return { stringValue: v };
}
function fields(o) { return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, value(v)])); }
const base = 'http://'+process.env.FIRESTORE_EMULATOR_HOST+'/v1/projects/demo-bold-os/databases/(default)/documents/';
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
  const run = Date.now(), id='ak-'+'3'.repeat(24), closed='ak-'+'4'.repeat(24);
  await db.doc('problemBank/'+id).set({stage:'open',archived:false});
  await db.doc('problemBank/'+closed).set({stage:'open',archived:true});
  await db.doc('settings/access').set({projects:{view:'internal',edit:'internal'}},{merge:true});
  let n = 0;
  const make = (proposal, by = MEMBER, link = id) => req('projects?documentId=p' + run + '-' + (++n), 'POST', jwt(by), { title: 'P', ...(link ? {openProblemId:link} : {}), submittedBy: { email: by }, proposal });
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
  for (const link of [null, closed, 'ak-'+'5'.repeat(24)]) assert.equal(await make({status:'proposed',more:false,at,by:MEMBER},MEMBER,link),403);
  assert.equal(await req('projects/p'+run+'-1','PATCH',jwt(MEMBER),{openProblemId:closed},['openProblemId']),403);
  console.log('project proposal rules: ok');
})().catch((e) => { console.error(e); process.exit(1); });
