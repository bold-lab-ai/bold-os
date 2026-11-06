const assert = require('node:assert/strict');
const admin = require('../functions/node_modules/firebase-admin');
const { createPhotoService, slackImage } = require('../functions/profile-photos');

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
  throw new Error('Run with the demo-test Firestore and Storage emulators.');
}
admin.initializeApp({ projectId: 'demo-test', storageBucket: 'demo-test.appspot.com' });
const db = admin.firestore();
const files = new Map();
const metadata = new Map();
let signOptions;
const bucket = { file: path => ({
  save: async (bytes, options) => { files.set(path, Buffer.from(bytes)); metadata.set(path, options.metadata); },
  download: async () => { if (!files.has(path)) throw new Error('Missing file'); return [files.get(path)]; },
  delete: async () => { files.delete(path); },
  getSignedUrl: async options => { signOptions = options; return ['https://storage.googleapis.com/demo-test/' + path + '?signed=day']; },
}) };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
let mode = 'ok', calls = 0, releaseImage, imageStarted;
function mockFetch(url) {
  calls++;
  if (url.includes('users.info')) return Promise.resolve(new Response(JSON.stringify({ ok: true, user: { profile: {
    is_custom_image: mode !== 'default', image_192: 'https://avatars.slack-edge.com/photo.jpg',
  } } }), { headers: { 'content-type': 'application/json' } }));
  if (mode === 'fail') throw new Error('Network failed');
  if (mode === 'large') return Promise.resolve(new Response(jpeg, { headers: { 'content-type': 'image/jpeg', 'content-length': '999999' } }));
  if (mode === 'wrong') return Promise.resolve(new Response(jpeg, { headers: { 'content-type': 'text/html' } }));
  if (mode === 'paused') return new Promise(resolve => {
    releaseImage = () => resolve(new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }));
    imageStarted();
  });
  return Promise.resolve(new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }));
}
const service = createPhotoService({ db, bucket, fetcher: mockFetch, token: () => 'synthetic', FieldValue: admin.firestore.FieldValue });
const root = 'http://127.0.0.1:8080/v1/projects/demo-test/databases/(default)/documents';
function jwt(email, slack) {
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b64({ alg: 'none', typ: 'JWT' }) + '.' + b64({
    aud: 'demo-test', iss: 'https://securetoken.google.com/demo-test', sub: email, user_id: email,
    iat: now, exp: now + 3600, email,
    firebase: { identities: slack ? { 'oidc.slack': ['UOWNER'] } : { 'google.com': [email] }, sign_in_provider: slack ? 'oidc.slack' : 'google.com' },
  }) + '.';
}
async function ruleRequest(path, method, auth, body) {
  return fetch(root + '/' + path, { method, headers: {
    ...(auth ? { Authorization: 'Bearer ' + auth } : {}),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  }, body: body && JSON.stringify(body) });
}

(async () => {
  await db.collection('people').doc('UOWNER').set({ email: 'owner@example.test', name: 'Owner', slackId: 'UOWNER' });
  await db.collection('people').doc('UOTHER').set({ email: 'other@example.test', name: 'Other', slackId: 'UOTHER' });
  await db.collection('roles').doc('pis').set({ emails: [] });
  await db.collection('roles').doc('admins').set({ emails: [] });
  await db.collection('settings').doc('access').set({ pages: { people: { view: 'everyone' } } });
  assert.equal(await service.owner('OWNER@example.test'), 'UOWNER');
  assert.equal((await service.importSlack('UOWNER')).state, 'active');
  const firstPhoto = await service.read('UOWNER');
  assert.match(firstPhoto.url, /^https:\/\/storage\.googleapis\.com\//);
  assert.equal((await service.read('UOWNER')).url, firstPhoto.url);
  assert.equal(signOptions.version, 'v4');
  assert.equal(signOptions.accessibleAt.getUTCHours(), 0);
  assert.equal(signOptions.expires - signOptions.accessibleAt, 2 * 24 * 60 * 60 * 1000);
  assert.equal((await service.batch(['UOWNER', 'UOWNER'])).UOWNER.url, firstPhoto.url);
  // An odd id is only without a photo; the others still come back.
  const mixed = await service.batch(['invalid/id', 'UOWNER']);
  assert.equal(mixed['invalid/id'].state, 'missing');
  assert.equal(mixed.UOWNER.url, firstPhoto.url);
  await assert.rejects(service.batch(new Array(501).fill('UOWNER')));
  assert.equal(Array.from(metadata.values())[0].cacheControl, 'public, max-age=31536000, immutable');
  await service.remove('UOWNER');
  assert.equal((await service.read('UOWNER')).state, 'removed');
  // Choosing Slack's photo when Slack has only its default: nothing imported, and the opt-out stays.
  mode = 'default';
  assert.equal((await service.importSlack('UOWNER')).state, 'no-slack-photo');
  assert.equal((await service.read('UOWNER')).state, 'removed');
  // A failed import leaves it too.
  mode = 'fail';
  await assert.rejects(service.importSlack('UOWNER'));
  assert.equal((await service.read('UOWNER')).state, 'removed');
  mode = 'ok';
  assert.equal((await service.importSlack('UOWNER')).state, 'active');
  await service.replace('UOWNER', jpeg.toString('base64'));
  assert.equal((await service.read('UOWNER')).source, 'manual');
  mode = 'default';
  assert.equal((await service.importSlack('UOWNER')).state, 'no-slack-photo');
  assert.equal((await service.read('UOWNER')).source, 'manual');

  mode = 'fail';
  await assert.rejects(service.importSlack('UOWNER'));
  assert.equal((await service.read('UOWNER')).source, 'manual');
  // What the member can act on carries a callable code (shown to them); the rest is internal.
  mode = 'large'; await assert.rejects(service.importSlack('UOTHER'), err => err.photoCode === 'failed-precondition');
  mode = 'wrong'; await assert.rejects(service.importSlack('UOTHER'), err => !!err.photoCode);
  mode = 'default'; assert.equal((await service.importSlack('UOTHER')).state, 'no-slack-photo');
  mode = 'ok'; assert.equal((await service.importSlack('UOTHER')).state, 'active');
  await assert.rejects(service.replace('UOTHER', Buffer.alloc(257 * 1024).toString('base64')), err => err.photoCode === 'invalid-argument');
  await assert.rejects(slackImage(mockFetch, 'http://127.0.0.1/photo'));
  const gif = Buffer.from('GIF89a' + 'synthetic');
  const gravatar = await slackImage(() => Promise.resolve(new Response(gif, { headers: { 'content-type': 'image/gif' } })), 'https://secure.gravatar.com/avatar/synthetic');
  assert.equal(gravatar.type, 'image/gif');
  await assert.rejects(service.replace('UOTHER', gif.toString('base64')));
  await db.collection('profilePhotos').doc('UOTHER').delete();
  const beforeRace = files.size;
  const race = await Promise.all([service.importSlack('UOTHER'), service.importSlack('UOTHER')]);
  assert.equal(race.filter(x => x.state === 'active').length, 1);
  assert.equal(files.size, beforeRace + 1);
  await db.collection('profilePhotos').doc('UOTHER').delete();
  mode = 'paused';
  const started = new Promise(resolve => { imageStarted = resolve; });
  const importing = service.importSlack('UOTHER');
  await started;
  await service.replace('UOTHER', jpeg.toString('base64'));
  releaseImage();
  assert.equal((await importing).state, 'unchanged');
  assert.equal((await service.read('UOTHER')).source, 'manual');
  mode = 'ok';

  // By default: a member who never chose gets their Slack picture the first time it's needed.
  await db.collection('people').doc('UAUTO').set({ email: 'auto@example.test', name: 'Auto', slackId: 'UAUTO' });
  await db.collection('people').doc('UDEF').set({ email: 'def@example.test', name: 'Def', slackId: 'UDEF' });
  mode = 'ok';
  const auto = await service.batch(['UAUTO', 'UNOTONROSTER']);
  assert.equal(auto.UAUTO.state, 'active');
  assert.equal((await db.collection('profilePhotos').doc('UAUTO').get()).data().source, 'slack');
  assert.equal(auto.UNOTONROSTER.state, 'missing');
  assert.equal((await db.collection('profilePhotos').doc('UNOTONROSTER').get()).exists, false);
  // Removed: initials, never imported again by default.
  await service.remove('UAUTO');
  const afterRemove = calls;
  assert.equal((await service.batch(['UAUTO'])).UAUTO.state, 'removed');
  assert.equal(calls, afterRemove);
  // Slack's default picture: initials, and not asked again for a day.
  mode = 'default';
  assert.equal((await service.batch(['UDEF'])).UDEF.state, 'missing');
  assert.ok((await db.collection('profilePhotos').doc('UDEF').get()).data().checkedAt);
  const afterDefault = calls;
  await service.batch(['UDEF']); await service.read('UDEF');
  assert.equal(calls, afterDefault);
  mode = 'ok';

  const owner = jwt('owner@example.test', true), other = jwt('other@example.test', true), google = jwt('owner@example.test', false);
  const path = 'profilePhotos/UOWNER';
  assert.equal((await ruleRequest(path, 'GET')).status, 403);
  assert.equal((await ruleRequest(path, 'GET', google)).status, 403);
  assert.equal((await ruleRequest(path, 'GET', owner)).status, 200);
  assert.equal((await ruleRequest(path, 'GET', other)).status, 200);
  await db.collection('settings').doc('access').set({ pages: { people: { view: 'exec' } } });
  assert.equal((await ruleRequest(path, 'GET', owner)).status, 403);
  assert.equal((await ruleRequest(path, 'GET', other)).status, 403);
  await db.collection('settings').doc('access').set({ pages: { people: { view: 'everyone' } } });
  const writeBody = { fields: { state: { stringValue: 'removed' } } };
  assert.equal((await ruleRequest(path, 'PATCH', owner, writeBody)).status, 403);
  assert.equal((await ruleRequest(path, 'PATCH', other, writeBody)).status, 403);
  await db.collection('profilePhotos').doc('USERVER').set({ state: 'active' });
  assert.equal((await ruleRequest('profilePhotos/USERVER', 'GET', owner)).status, 200);

  const storageRoot = 'http://127.0.0.1:9199/v0/b/demo-test.appspot.com/o/';
  const object = encodeURIComponent('profile-photos/UOWNER/example');
  // The Admin SDK writes to the emulator even though every client path is
  // denied. This is the same server-only route as the callable uses.
  await admin.storage().bucket().file('profile-photos/UOWNER/example').save(jpeg, { metadata: { contentType: 'image/jpeg' } });
  const upload = auth => fetch(storageRoot + '?name=' + object + '&uploadType=media', { method: 'POST', headers: {
    'Content-Type': 'image/jpeg', ...(auth ? { Authorization: 'Bearer ' + auth } : {}),
  }, body: jpeg });
  assert.equal((await upload(owner)).status, 403);
  assert.equal((await upload(other)).status, 403);
  assert.equal((await upload(google)).status, 403);
  const storageGet = auth => fetch(storageRoot + object + '?alt=media', { headers: auth ? { Authorization: 'Bearer ' + auth } : {} });
  assert.equal((await storageGet(owner)).status, 403);
  assert.equal((await storageGet(other)).status, 403);
  assert.equal((await storageGet(google)).status, 403);
  assert.equal((await storageGet()).status, 403);
  await admin.storage().bucket().file('profile-photos/UOWNER/example').delete();
  console.log('profile photos: service behaviour and Firestore/Storage rules passed');
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => admin.app().delete());
