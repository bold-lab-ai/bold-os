// serviceDeskFile against the demo emulators (Firestore, Functions, Storage). Never contacts production.
// npx firebase emulators:exec --only firestore,functions,storage --project demo-bold-os "node tests/service-desk.callable.emulator.cjs"
const assert = require('node:assert/strict');
if (process.env.GCLOUD_PROJECT !== 'demo-bold-os' || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) throw Error('Use the local demo-bold-os emulators.');
const admin = require('../functions/node_modules/firebase-admin');
admin.initializeApp({ projectId: 'demo-bold-os', storageBucket: 'demo-bold-os.appspot.com' });
const db = admin.firestore(), bucket = admin.storage().bucket();
const endpoint = 'http://127.0.0.1:5001/demo-bold-os/europe-west2/serviceDeskFile';
function jwt(email, slack = true) {
  const b = x => Buffer.from(JSON.stringify(x)).toString('base64url'), now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({ aud: 'demo-bold-os', iss: 'https://securetoken.google.com/demo-bold-os', sub: email, user_id: email, email, iat: now, exp: now + 3600,
    firebase: { identities: { [slack ? 'oidc.slack' : 'google.com']: [email] }, sign_in_provider: slack ? 'oidc.slack' : 'google.com' } }) + '.';
}
async function call(email, data, slack = true) {
  const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt(email, slack) }, body: JSON.stringify({ data }) });
  return { status: r.status, body: await r.json() };
}

(async () => {
  const PI = 'pi@example.com', MEMBER = 'member@example.com';
  await db.doc('roles/pis').set({ emails: [PI] });
  await db.doc('roles/admins').set({ emails: [] });
  await db.doc('members/' + MEMBER).set({ category: 'internal' });
  await db.doc('serviceDesk/c1').set({ title: 'Preprint template', text: '', href: '', order: 1, updatedBy: PI, updatedAt: 1 });
  const zip = Buffer.from('PK\u0003\u0004 a template').toString('base64');

  let r = await call(MEMBER, { action: 'upload', id: 'c1', name: 'template.zip', file: zip });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  r = await call(PI, { action: 'upload', id: 'c1', name: 'template.zip', file: zip }, false);
  assert.notEqual(r.status, 200, 'a non-Slack account uploads');
  r = await call(PI, { action: 'upload', id: 'c1', name: 'run.sh', file: zip });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  r = await call(PI, { action: 'upload', id: 'c1', name: 'BOLD template.zip', file: zip });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const file = (await db.doc('serviceDesk/c1').get()).data().file;
  assert.equal(file.name, 'BOLD-template.zip');
  assert.equal((await bucket.file(file.path).download())[0].toString(), 'PK\u0003\u0004 a template');

  // A second upload replaces the first, whose file is deleted.
  r = await call(PI, { action: 'upload', id: 'c1', name: 'v2.zip', file: zip });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await bucket.file(file.path).exists())[0], false, 'the old file is gone');

  r = await call(MEMBER, { action: 'link', id: 'c1' });
  // Signing needs real credentials, which the emulator hasn't: then it's internal (and the unit tests check the link).
  if (r.status === 200) { assert.match(r.body.result.url, /v2\.zip/); console.log('link: signed in the emulator'); }
  else { assert.equal(r.status, 500, JSON.stringify(r.body)); console.log('link: allowed, but the emulator can’t sign URLs'); }
  r = await call('outsider@example.com', { action: 'link', id: 'c1' });
  assert.equal(r.status, 403, 'someone without a group gets a link');
  r = await call(MEMBER, { action: 'link', id: 'nope' });
  assert.equal(r.status, 404, JSON.stringify(r.body));

  r = await call(MEMBER, { action: 'remove', id: 'c1' });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  const last = (await db.doc('serviceDesk/c1').get()).data().file.path;
  r = await call(PI, { action: 'remove', id: 'c1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await db.doc('serviceDesk/c1').get()).data().file, null);
  assert.equal((await bucket.file(last).exists())[0], false);

  console.log('serviceDeskFile: all checks passed.');
  await admin.app().delete();
})().catch(e => { console.error(e); process.exitCode = 1; });
