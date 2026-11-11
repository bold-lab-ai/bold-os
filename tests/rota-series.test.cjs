const test = require('node:test');
const assert = require('node:assert/strict');

const series = require('../functions/series')({
  onCall: (options, handler) => handler || options,
  onDocumentWritten: (options, handler) => handler,
  onSchedule: (options, handler) => handler,
  normalizeMeeting: () => ({}),
});
const normalize = series._internal.normalizeSeries;
const base = { kind: 'editions', title: 'Group meetings', description: '', visibleTo: 'internal',
  cadence: { every: 1, unit: 'week' }, inviteGroup: 'none', organisers: ['organiser@example.org'] };

test('a weekly editions series can use the rota page without Calendar invitations', () => {
  const result = normalize({ ...base, page: 'group-meetings.html' });
  assert.equal(result.error, undefined);
  assert.equal(result.page, 'group-meetings.html');
  assert.equal(result.inviteGroup, 'none');
  assert.deepEqual(result.cadence, { every: 1, unit: 'week' });
});

test('the rota page rejects a different cadence or invitation group', () => {
  assert.match(normalize({ ...base, page: 'group-meetings.html', cadence: { every: 2, unit: 'week' } }).error, /weekly/);
  assert.match(normalize({ ...base, page: 'group-meetings.html', inviteGroup: 'internal' }).error, /without invitations/);
  assert.match(normalize({ ...base, page: 'another.html' }).error, /custom event page/);
});

test('ordinary editions keep their existing series shape', () => {
  const result = normalize(base);
  assert.equal(result.error, undefined);
  assert.equal(result.page, undefined);
});
