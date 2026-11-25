// Firestore rules for problem drafts (problemDrafts/{id}: only their owner), against the demo emulator.
// npx firebase emulators:exec --only firestore --project demo-bold-os "node tests/problem-drafts.emulator.cjs"
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
  if (Array.isArray(v)) return {arrayValue:{values:v.map(value)}};
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
  const me = 'internal@example.com', other = 'associate@example.com', id = 'draft-' + Date.now();
  const seeded = [];
  for (const [path, data] of [['roles/pis', { emails: [] }], ['roles/admins', { emails: [] }], ['members/' + me, { category: 'internal' }], ['members/' + other, { category: 'internal' }]]) {
    const ref = db.doc(path);
    if (!(await ref.get()).exists) { await ref.create(data); seeded.push(ref); }
  }
  const row = (email, extra = {}) => ({ email, turns: [{ role: 'assistant', content: 'Describe it' }, { role: 'user', content: 'Runs diverge' }],
    draft: { title: 'T' }, done: false, title: 'T', me: null, createdAt: Date.now(), updatedAt: Date.now(), ...extra });
  try {
    assert.equal(await req('problemDrafts?documentId=' + id, 'POST', jwt(me), row(me)), 200, 'their own');
    assert.equal(await req('problemDrafts/' + id, 'GET', jwt(me)), 200, 'they read it');
    assert.equal(await req('problemDrafts/' + id, 'GET', jwt(other)), 403, 'nobody else reads it');
    assert.equal(await req('problemDrafts/' + id, 'PATCH', jwt(other), row(other)), 403, 'nor takes it over');
    assert.equal(await req('problemDrafts/' + id, 'PATCH', jwt(me), row(me, { done: true, title: 'Better' })), 200, 'they update it');
    assert.equal(await req('problemDrafts?documentId=' + id + 'x', 'POST', jwt(me), row(other)), 403, 'not in someone else’s name');
    assert.equal(await req('problemDrafts?documentId=' + id + 'y', 'POST', jwt(me), row(me, { secret: 1 })), 403, 'no other fields');
    assert.equal(await req('problemDrafts?documentId=' + id + 'z', 'POST', jwt(me, false), row(me)), 403, 'Slack accounts only');
    assert.equal(await req('problemDrafts/' + id, 'DELETE', jwt(other)), 403, 'nobody else deletes it');
    assert.equal(await req('problemDrafts/' + id, 'DELETE', jwt(me)), 200, 'they delete it');
    console.log('problem draft rules: ok');
  } finally {
    await Promise.all([db.doc('problemDrafts/' + id), ...seeded].map((ref) => ref.delete()));
    await admin.app().delete();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
