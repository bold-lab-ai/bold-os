// Run with FIRESTORE_EMULATOR_HOST=127.0.0.1:8080; never connects to production.
const test = require('node:test');
const assert = require('node:assert/strict');
test('buddy lifecycle, privacy, conflicts and retry safety', { skip: !process.env.FIRESTORE_EMULATOR_HOST }, async () => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST, /^(127\.0\.0\.1|localhost):\d+$/);
  const admin = require('../functions/node_modules/firebase-admin');
  const app = admin.initializeApp({ projectId: 'demo-bold-os' }, 'peer-test');
  const db = app.firestore(), prefix = 'peer-test-', member = prefix + 'member@example.com', ambassador = prefix + 'ambassador@example.com', outsider = prefix + 'other@example.com';
  class HttpsError extends Error { constructor(code, message){ super(message); this.code = code; } }
  const notices = [];
  const service = require('../functions/peer-support')({ db, HttpsError, onCall: f => f, onDocumentCreated: (_, f) => f,
    signedInEmail: r => { if (!r.auth?.token?.firebase?.identities?.['oidc.slack']) throw new HttpsError('unauthenticated', 'Slack required'); return r.auth.token.email; },
    access: { requireAccess: async () => {} }, isFullWrite: async () => false, viewingAs: () => false, numberFor: async () => 901,
    deliver: async (to, n) => notices.push({ to, n }), SITE_URL: 'https://example.com/' });
  const call = (email, data) => service.handle({ auth: { token: { email, name: 'Test member', firebase: { identities: { 'oidc.slack': ['test'] } } } }, data });
  const paths = ['peerAmbassadors/' + ambassador, 'peerBuddyRequests/' + member, 'peerBuddyRequests/' + outsider, 'studies/' + member, 'peerApplications/' + outsider];
  try {
    for (const p of paths) await db.doc(p).delete();
    await db.doc(paths[0]).set({ active: true, name: 'Test ambassador', bio: '', slackId: 'UTEST', notifyNewJoiners: true });
    assert.equal((await call(member, { action: 'request', notify: false })).created, true);
    assert.equal((await call(member, { action: 'request', notify: true })).created, false);
    assert.equal(notices.length, 0);
    const other = await call(outsider, { action: 'load' });
    assert.equal(other.mine, null); assert.equal(other.requests, undefined);
    await assert.rejects(call(outsider, { action: 'offer', email: member }), { code: 'permission-denied' });
    await assert.rejects(call(ambassador, { action: 'offer', email: member, ambassadorEmail: ambassador }), { code: 'failed-precondition' });
    await db.doc('studies/' + member).set({ people: [{ email: ambassador }] });
    const offer = { action: 'offer', email: member, ambassadorEmail: ambassador, conflictsChecked: true, notify: true };
    await assert.rejects(call(ambassador, offer), { code: 'failed-precondition' });
    await db.doc('studies/' + member).delete();
    await call(ambassador, offer);
    await assert.rejects(call(ambassador, offer), { code: 'failed-precondition' });
    assert.equal(notices.length, 1); assert.equal(notices[0].n.ping, false);
    await call(member, { action: 'accept' });
    assert.equal((await call(member, { action: 'load' })).mine.status, 'active');
    await call(member, { action: 'close' });
    assert.equal((await call(member, { action: 'request' })).created, true);
    await service.onPeerMemberJoined({ params: { email: outsider }, data: {} });
    await service.onPeerMemberJoined({ params: { email: outsider }, data: {} });
    assert.equal(notices.length, 2);
    await call(outsider, { action: 'apply' });
    await assert.rejects(call(outsider, { action: 'approveApplication', email: outsider }), { code: 'permission-denied' });
    await assert.rejects(service.handle({ auth: { token: { email: member } }, data: {} }), { code: 'unauthenticated' });
    // Direct clients, including the requester, must not bypass the callable.
    const encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
    const token = encode({ alg: 'none', typ: 'JWT' }) + '.' + encode({ sub: 'test', user_id: 'test', email: member, aud: 'demo-bold-os', iss: 'https://securetoken.google.com/demo-bold-os', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600, firebase: { sign_in_provider: 'oidc.slack', identities: { 'oidc.slack': ['test'] } } }) + '.';
    const endpoint = 'http://' + process.env.FIRESTORE_EMULATOR_HOST + '/v1/projects/demo-bold-os/databases/(default)/documents/peerBuddyRequests/' + member;
    assert.equal((await fetch(endpoint, { headers: { Authorization: 'Bearer ' + token } })).status, 403);
    assert.equal((await fetch(endpoint, { method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { status: { stringValue: 'active' } } }) })).status, 403);
  } finally { for (const p of paths) await db.doc(p).delete(); await app.delete(); }
});
