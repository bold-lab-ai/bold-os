// Google's limit on the lab's calendar (functions/index.js): guests are emailed only for what they
// need to know, and a sync the limit stopped is recognised (and retried every hour).
const test = require('node:test');
const assert = require('node:assert');
const { calendarUpdates, isCalendarLimit, meetCodeOf, ensureMeetOpen } = require('../functions/index.js')._internal;

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

test('a Calendar-created Google Meet is recognised by its conference id or join URL', () => {
  assert.strictEqual(meetCodeOf({ conferenceData: { conferenceId: 'ABC-Defg-Hij' } }), 'abc-defg-hij');
  assert.strictEqual(meetCodeOf({ hangoutLink: 'https://meet.google.com/abc-defg-hij?authuser=0' }), 'abc-defg-hij');
  assert.strictEqual(meetCodeOf({ hangoutLink: 'https://example.org/abc-defg-hij' }), '');
  assert.strictEqual(meetCodeOf({ conferenceData: { conferenceId: '../not-a-space' } }), '');
  assert.strictEqual(meetCodeOf(null), '');
});

test('a Calendar-created Google Meet is made open to anyone with its link', async () => {
  const calls = [];
  const googleFetch = async (method, url, body) => {
    calls.push({ method, url, body });
    if (method === 'GET') return { name: 'spaces/Space_1', config: { accessType: 'TRUSTED' } };
    return { name: 'spaces/Space_1', config: { accessType: 'OPEN' } };
  };
  await ensureMeetOpen({ conferenceData: { conferenceId: 'abc-defg-hij' } }, 'event-1', { googleFetch, wait: async () => {} });
  assert.deepStrictEqual(calls, [
    { method: 'GET', url: 'https://meet.googleapis.com/v2/spaces/abc-defg-hij', body: undefined },
    { method: 'PATCH', url: 'https://meet.googleapis.com/v2/spaces/Space_1?updateMask=config.accessType', body: { config: { accessType: 'OPEN' } } },
  ]);
});

test('a pending Meet is read back from Calendar before its access is checked', async () => {
  const calls = [], waits = [];
  const googleFetch = async (method, url) => {
    calls.push([method, url]);
    if (url.includes('calendar')) return { hangoutLink: 'https://meet.google.com/abc-defg-hij' };
    return { name: 'spaces/Space_1', config: { accessType: 'OPEN' } };
  };
  const ev = await ensureMeetOpen({ conferenceData: { createRequest: { status: { statusCode: 'pending' } } } }, 'event/1', {
    googleFetch, wait: async (ms) => { waits.push(ms); },
  });
  assert.strictEqual(ev.hangoutLink, 'https://meet.google.com/abc-defg-hij');
  assert.deepStrictEqual(waits, [250]);
  assert.deepStrictEqual(calls, [
    ['GET', 'https://www.googleapis.com/calendar/v3/calendars/primary/events/event%2F1'],
    ['GET', 'https://meet.googleapis.com/v2/spaces/abc-defg-hij'],
  ]);
});
