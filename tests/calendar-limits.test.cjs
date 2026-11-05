// Google's limit on the lab's calendar (functions/index.js): guests are emailed only for what they
// need to know, and a sync the limit stopped is recognised (and retried every hour).
const test = require('node:test');
const assert = require('node:assert');
const { calendarUpdates, isCalendarLimit } = require('../functions/index.js')._internal;

test('a new time, recurrence or guest list emails the guests; a title, description or Meet link doesn’t', () => {
  assert.strictEqual(calendarUpdates({ attendees: [] }), 'all');
  assert.strictEqual(calendarUpdates({ start: {}, end: {} }), 'all');
  assert.strictEqual(calendarUpdates({ recurrence: [] }), 'all');
  assert.strictEqual(calendarUpdates({ summary: 'P', description: 'd', conferenceData: {} }), 'none');
  assert.strictEqual(calendarUpdates({}), 'none');
});

test('the calendar limit is told apart from other Google errors', () => {
  assert.ok(isCalendarLimit({ reason: 'quotaExceeded', message: 'Calendar usage limits exceeded.' }));
  assert.ok(isCalendarLimit({ reason: 'rateLimitExceeded' }));
  assert.ok(isCalendarLimit({ message: 'Calendar usage limits exceeded.' }));
  assert.ok(!isCalendarLimit({ reason: 'notFound', status: 404 }));
  assert.ok(!isCalendarLimit(null));
});
