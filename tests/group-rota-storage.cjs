const assert = require('node:assert/strict');

const projectId = 'demo-test';
const host = process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199';
const base = `http://${host}/v0/b/${projectId}.appspot.com/o`;
const path = 'rota-profiles/U1/portrait';
const objectUrl = base + '/' + encodeURIComponent(path);
const uploadUrl = base + '?uploadType=media&name=' + encodeURIComponent(path);
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (email, slackId) => {
  const now = Math.floor(Date.now() / 1000);
  return b64({ alg: 'none', typ: 'JWT' }) + '.' + b64({ iss: `https://securetoken.google.com/${projectId}`, aud: projectId, auth_time: now, iat: now, exp: now + 3600, sub: slackId, user_id: slackId, email, firebase: { identities: { 'oidc.slack': [slackId] }, sign_in_provider: 'oidc.slack' } }) + '.';
};
const auth = token => ({ Authorization: 'Bearer ' + token });
const expectDenied = async (label, response) => assert.equal(response.status, 403, `${label}: ${response.status} ${await response.text()}`);

(async () => {
  const owner = jwt('one@example.org', 'U1'), member = jwt('two@example.org', 'U2');
  await expectDenied('old portrait upload', await fetch(uploadUrl, { method: 'POST', headers: { ...auth(owner), 'Content-Type': 'image/png' }, body: Buffer.from([137, 80, 78, 71]) }));
  await expectDenied('old portrait owner read', await fetch(objectUrl + '?alt=media', { headers: auth(owner) }));
  await expectDenied('old portrait member read', await fetch(objectUrl + '?alt=media', { headers: auth(member) }));
  await expectDenied('old portrait delete', await fetch(objectUrl, { method: 'DELETE', headers: auth(owner) }));
  console.log('Legacy rota portrait Storage rules: 4 denied cases passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
