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

test('an ordinary weekly editions series keeps its usual shape', () => {
  const result = normalize(base);
  assert.equal(result.error, undefined);
  assert.equal(result.page, undefined);
  assert.equal(result.inviteGroup, 'none');
  assert.deepEqual(result.cadence, { every: 1, unit: 'week' });
});

test('the shared series flow does not attach custom pages', () => {
  assert.match(normalize({ ...base, page: 'group-meetings.html' }).error, /custom event page/);
  assert.match(normalize({ ...base, page: 'another.html' }).error, /custom event page/);
});
