const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeForm, validateAnswers } = require('../functions/forms');
const sample = () => ({ title: 'Test form', owners: [], targetEmails: [], targetGroups: [], questions: [
  { id: 'text', label: 'Comment', type: 'text', required: true },
  { id: 'choice', label: 'Choice', type: 'choice', options: ['Yes', 'No'] },
  { id: 'scale', label: 'Scale', type: 'scale' },
] });
test('forms validate questions, owners, groups and answers', () => {
  const f = normalizeForm(sample(), 'owner@example.com');
  assert.deepEqual(f.owners, ['owner@example.com']);
  assert.throws(() => normalizeForm({ ...sample(), targetGroups: ['all'] }, 'owner@example.com'));
  assert.throws(() => normalizeForm({ ...sample(), questions: [{ id: '__proto__', label: 'Bad' }] }, 'owner@example.com'));
  assert.throws(() => normalizeForm({ ...sample(), questions: [{ id: 'x', label: 'A' }, { id: 'x', label: 'B' }] }, 'owner@example.com'));
  assert.throws(() => validateAnswers(f.questions, { text: '' }));
  assert.throws(() => validateAnswers(f.questions, { text: 'Fine', scale: '6' }));
  assert.throws(() => validateAnswers(f.questions, { text: 'Fine', choice: 'Other' }));
  assert.throws(() => validateAnswers(f.questions, { text: 'Fine', injected: 'extra' }));
  assert.deepEqual(validateAnswers(f.questions, { text: ' Fine ', choice: 'Yes', scale: '2' }), { text: 'Fine', choice: 'Yes', scale: '2' });
});
test('forms preserve anonymous responses, restrict access, reveal only self, and remind only non-responders', { skip: !process.env.FIRESTORE_EMULATOR_HOST }, async () => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST, /^(127\.0\.0\.1|localhost):\d+$/);
  const admin = require('../functions/node_modules/firebase-admin');
  const app = admin.initializeApp({ projectId: 'demo-bold-os' }, 'forms-test'), db = app.firestore();
  class HttpsError extends Error { constructor(code, message){ super(message); this.code = code; } }
  const owner = 'forms-test-owner@example.com', coowner = 'forms-test-coowner@example.com', person = 'forms-test-person@example.com', other = 'forms-test-other@example.com';
  const notices = [], ids = [];
  let deny = false;
  const service = require('../functions/forms')({ db, HttpsError, onCall: f => f, onSchedule: (_, f) => f,
    signedInEmail: r => { if (!r.auth?.token?.firebase?.identities?.['oidc.slack']) throw new HttpsError('unauthenticated', 'Slack required'); return r.auth.token.email; },
    access: { requireAccess: async () => { if (deny) throw new HttpsError('permission-denied', 'Page closed'); } },
    deliver: async (to, n) => notices.push({ to, n }), SITE_URL: 'https://example.com/' });
  const call = (email, data) => service.handle({ auth: { token: { email, name: 'Demo respondent', firebase: { identities: { 'oidc.slack': ['test'] } } } }, data });
  const authToken = email => {
    const enc = x => Buffer.from(JSON.stringify(x)).toString('base64url'), now = Math.floor(Date.now()/1000);
    return enc({ alg: 'none', typ: 'JWT' }) + '.' + enc({ sub: 'forms-test', user_id: 'forms-test', email, aud: 'demo-bold-os', iss: 'https://securetoken.google.com/demo-bold-os', iat: now, exp: now + 3600, firebase: { identities: { 'oidc.slack': ['test'] }, sign_in_provider: 'oidc.slack' } }) + '.';
  };
  try {
    for (const email of [owner, coowner, person, other]) await db.doc('members/' + email).set({ name: 'Demo member', category: 'internal' });
    await assert.rejects(call(owner, { action: 'create', form: { ...sample(), owners: [coowner] } }), { code: 'failed-precondition' });
    const created = await call(owner, { action: 'create', confirmOwners: true, form: { ...sample(), owners: [coowner], targetEmails: [person, other], reminders: true, notifyOwners: true } });
    ids.push(created.id); const id = created.id, ref = db.doc('forms/' + id);
    await assert.rejects(call(person, { action: 'get', id }), { code: 'permission-denied' });
    assert.equal((await call(person, { action: 'list' })).forms.some(f => f.id === id), false);
    const initial = await call(coowner, { action: 'get', id }); assert.equal(initial.owner, true);
    await assert.rejects(call(coowner, { action: 'save', id, revision: 0, form: initial.form }), { code: 'aborted' });
    await assert.rejects(call(coowner, { action: 'publish', id, revision: 1 }), { code: 'failed-precondition' });
    await call(coowner, { action: 'publish', id, revision: 1, confirmPublish: true, notify: false });
    assert.equal(notices.length, 0);
    await assert.rejects(call(person, { action: 'close', id }), { code: 'permission-denied' });
    await assert.rejects(call(owner, { action: 'save', id, revision: 2, form: initial.form }), { code: 'failed-precondition' });
    const targeted = await call(person, { action: 'get', id });
    assert.equal(targeted.responses, undefined); assert.equal(targeted.form.recipientEmails, undefined); assert.equal(targeted.form.responseCount, undefined);
    await assert.rejects(call(person, { action: 'submit', id, answers: { text: 'Private answer' }, identify: true }), { code: 'failed-precondition' });
    const simultaneous = await Promise.allSettled([call(person, { action: 'submit', id, answers: { text: 'Private answer' } }), call(person, { action: 'submit', id, answers: { text: 'Private answer' } })]);
    assert.equal(simultaneous.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal((await ref.get()).data().responseCount, 1);
    const owned = await call(owner, { action: 'get', id });
    assert.deepEqual(owned.responses, [{ answers: { text: 'Private answer', choice: '', scale: '' }, identity: null }]);
    assert.equal(owned.completion, undefined); assert.equal(owned.myResponse, undefined);
    await ref.update({ openedAt: Date.now() - 8 * 86400000 });
    await service.reminders(); await service.reminders();
    assert.equal(notices.length, 2); assert.deepEqual(notices[0].to, [other]); assert.deepEqual(notices[1].to, [owner, coowner]);
    assert(notices.every(n => n.n.ping === false));
    await assert.rejects(call(other, { action: 'reveal', id, confirmIdentity: true }), { code: 'not-found' });
    await assert.rejects(call(person, { action: 'reveal', id }), { code: 'failed-precondition' });
    await call(person, { action: 'reveal', id, confirmIdentity: true });
    assert.equal((await call(owner, { action: 'get', id })).responses[0].identity.email, person);
    // A response owner cannot see receipt documents or query the anonymous response collection directly.
    const base = 'http://' + process.env.FIRESTORE_EMULATOR_HOST + '/v1/projects/demo-bold-os/databases/(default)/documents/forms/' + id;
    for (const suffix of ['', '/completion/' + person, '/responses']) {
      assert.equal((await fetch(base + suffix, { headers: { Authorization: 'Bearer ' + authToken(owner) } })).status, 403);
    }
    assert.equal((await fetch(base, { method: 'PATCH', headers: { Authorization: 'Bearer ' + authToken(other), 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { owners: { arrayValue: { values: [{ stringValue: other }] } } } }) })).status, 403);
    await call(owner, { action: 'close', id });
    await assert.rejects(call(other, { action: 'submit', id, answers: { text: 'Too late' } }), { code: 'failed-precondition' });
    const before = notices.length; await service.reminders(); assert.equal(notices.length, before);
    deny = true; await assert.rejects(call(person, { action: 'get', id }), { code: 'permission-denied' });
    await assert.rejects(service.handle({ auth: { token: { email: owner } }, data: {} }), { code: 'unauthenticated' });
  } finally {
    for (const id of ids) await db.recursiveDelete(db.doc('forms/' + id));
    for (const email of [owner, coowner, person, other]) await db.doc('members/' + email).delete();
    await app.delete();
  }
});
