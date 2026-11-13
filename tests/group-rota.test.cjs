const test = require('node:test');
const assert = require('node:assert/strict');
const create = require('../functions/group-rota');
const fake = create({ db: { collection: () => ({}) }, admin: {}, HttpsError: Error, onCall: (_, fn) => fn || _, onSchedule: (_, fn) => fn,
  signedInEmail: () => '', rolesEmails: () => [], slackFetch: () => {}, botToken: {}, logger: {} });
const { upcoming, sameFormat, packageOf, url } = fake._internal;

test('future scheduled meetings are actionable, skipped dates are not', () => {
  assert.equal(upcoming({ date: '2099-01-05', startTime: '11:00', status: 'scheduled' }), true);
  assert.equal(upcoming({ date: '2099-01-05', startTime: '11:00', status: 'skipped' }), false);
  assert.equal(upcoming({ date: '2000-01-03', startTime: '11:00', status: 'scheduled' }), false);
});
test('swap packages carry the presenter and their talk but not the slot outcome', () => {
  const p = packageOf({ presenterSlackId: 'U123', topic: 'Topic', projectId: 'abc', slidesUrl: 'https://example.org/slides', outcome: 'presented', revision: 4 });
  assert.deepEqual(p, { presenterSlackId: 'U123', legacyMemberId: '', legacyName: '', topic: 'Topic', projectId: 'abc', slidesUrl: 'https://example.org/slides' });
  assert.equal(sameFormat({ format: 'short' }, { format: 'short' }), true);
  assert.equal(sameFormat({ format: 'short' }, { format: 'long' }), false);
});
test('slides URL must be HTTPS or empty', () => {
  assert.equal(url(''), true);
  assert.equal(url('https://example.org/deck'), true);
  assert.equal(url('http://example.org/deck'), false);
  assert.equal(url('javascript:alert(1)'), false);
});
