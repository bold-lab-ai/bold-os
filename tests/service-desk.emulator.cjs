// Firestore rules for the Service desk's cards (serviceDesk), against the demo emulator.
// npx firebase emulators:exec --only firestore --project demo-bold-os "node tests/service-desk.emulator.cjs"
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
  if (typeof v === 'number') return { integerValue: String(v) };
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
  const card = by => ({ title: 'Preprint template', text: 'The lab’s LaTeX template.', href: '', order: 1, updatedBy: by, updatedAt: 1 });

  // Creating: PIs and admins only, with the card's fields and nothing else.
  assert.equal(await req('serviceDesk?documentId=c1', 'POST', jwt(MEMBER), card(MEMBER)), 403, 'a member adds a card');
  assert.equal(await req('serviceDesk?documentId=c1', 'POST', jwt(PI, false), card(PI)), 403, 'a non-Slack account adds a card');
  assert.equal(await req('serviceDesk?documentId=c1', 'POST', jwt(PI), Object.assign(card(PI), { file: { path: 'x' } })), 403, 'a PI sets a file');
  assert.equal(await req('serviceDesk?documentId=c1', 'POST', jwt(PI), Object.assign(card(PI), { href: 'javascript:alert(1)' })), 403, 'a bad link');
  assert.equal(await req('serviceDesk?documentId=c1', 'POST', jwt(PI), Object.assign(card(PI), { updatedBy: MEMBER })), 403, 'someone else as updatedBy');
  assert.equal(await req('serviceDesk?documentId=c1', 'POST', jwt(PI), card(PI)), 200, 'a PI adds a card');
  assert.equal(await req('serviceDesk?documentId=c2', 'POST', jwt(PI), Object.assign(card(PI), { href: 'letters.html' })), 200, 'a page of the site');
  assert.equal(await req('serviceDesk?documentId=c3', 'POST', jwt(PI), Object.assign(card(PI), { href: 'https://example.org/x' })), 200, 'an https link');

  // Reading: whoever sees the Service desk.
  assert.equal(await req('serviceDesk/c1', 'GET', jwt(MEMBER)), 200, 'a member reads a card');
  assert.equal(await req('serviceDesk/c1', 'GET', jwt(MEMBER, false)), 403, 'a non-Slack account reads a card');
  assert.equal(await req('serviceDesk/c1', 'GET'), 403, 'signed out');

  // Editing: PIs and admins, never the file.
  await db.doc('serviceDesk/c1').update({ file: { path: 'service-desk/c1/1-a.zip', name: 'a.zip' } });
  const edit = { title: 'Preprint template', text: 'Changed.', href: '', order: 1, updatedBy: PI, updatedAt: 2 };
  assert.equal(await req('serviceDesk/c1', 'PATCH', jwt(MEMBER), Object.assign({}, edit, { updatedBy: MEMBER }), Object.keys(edit)), 403, 'a member edits');
  assert.equal(await req('serviceDesk/c1', 'PATCH', jwt(PI), edit, Object.keys(edit)), 200, 'a PI edits');
  assert.equal(await req('serviceDesk/c1', 'PATCH', jwt(PI), Object.assign({}, edit, { file: { path: 'elsewhere' } }), Object.keys(edit).concat('file')), 403, 'a PI changes the file');
  assert.equal(await req('serviceDesk/c1', 'PATCH', jwt(PI), Object.assign({}, edit, { file: null }), Object.keys(edit).concat('file')), 403, 'a PI clears the file');

  // Removing: PIs and admins.
  assert.equal(await req('serviceDesk/c2', 'DELETE', jwt(MEMBER)), 403, 'a member removes');
  assert.equal(await req('serviceDesk/c2', 'DELETE', jwt(PI)), 200, 'a PI removes');

  console.log('serviceDesk rules: all checks passed.');
  await admin.app().delete();
})().catch(e => { console.error(e); process.exitCode = 1; });
