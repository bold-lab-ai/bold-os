const assert = require('node:assert/strict');
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
const admin = require('../functions/node_modules/firebase-admin');

const projectId = 'demo-test';
admin.initializeApp({ projectId });
const db = admin.firestore();
const host = process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199';
const base = `http://${host}/v0/b/${projectId}.appspot.com/o`;
const path = 'rota-profiles/U1/portrait';
const objectUrl = base + '/' + encodeURIComponent(path);
const uploadUrl = base + '?uploadType=media&name=' + encodeURIComponent(path);
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (email, slackId, provider = 'oidc.slack') => {
  const now = Math.floor(Date.now() / 1000);
  return b64({ alg: 'none', typ: 'JWT' }) + '.' + b64({ iss: `https://securetoken.google.com/${projectId}`, aud: projectId, auth_time: now, iat: now, exp: now + 3600, sub: slackId, user_id: slackId, email, firebase: { identities: { [provider]: [slackId] }, sign_in_provider: provider } }) + '.';
};
const auth = token => token ? { Authorization: 'Bearer ' + token } : {};
const read = token => fetch(objectUrl + '?alt=media', { headers: auth(token) });
const upload = (token, type, bytes) => fetch(uploadUrl, { method: 'POST', headers: { ...auth(token), 'Content-Type': type }, body: bytes });
const remove = token => fetch(objectUrl, { method: 'DELETE', headers: auth(token) });
const expect = async (label, response, status) => assert.equal(response.status, status, `${label}: ${response.status} ${await response.text()}`);

(async () => {
  await db.collection('people').doc('U1').set({ email: 'one@example.org', slackId: 'U1', name: 'One' });
  await db.collection('people').doc('U2').set({ email: 'two@example.org', slackId: 'U2', name: 'Two' });
  const one = jwt('one@example.org', 'U1'), two = jwt('two@example.org', 'U2'), wrongProvider = jwt('one@example.org', 'U1', 'github.com');
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await expect('signed-out upload', await upload(null, 'image/png', image), 403);
  await expect('wrong-provider upload', await upload(wrongProvider, 'image/png', image), 403);
  await expect('another person upload', await upload(two, 'image/png', image), 403);
  await expect('owner upload', await upload(one, 'image/png', image), 200);
  await expect('signed-out read', await read(null), 403);
  await expect('wrong-provider read', await read(wrongProvider), 403);
  await expect('lab-member read', await read(two), 200);
  await expect('wrong media type', await upload(one, 'text/plain', image), 403);
  await expect('oversized portrait', await upload(one, 'image/png', Buffer.alloc(2 * 1024 * 1024 + 1)), 403);
  await expect('another person delete', await remove(two), 403);
  await expect('owner delete', await remove(one), 204);
  console.log('Rota Storage rules: 11 cases passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
