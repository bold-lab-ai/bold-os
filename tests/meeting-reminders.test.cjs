// Meetings about to start (functions/index.js meetingReminders): 1–5 minutes before, on its day and week.
const test = require('node:test');
const assert = require('node:assert');
const { meetingStartsSoon } = require('../functions/index.js')._internal;
const m = { day: 'TH', time: '11:00', minutes: 60, every: 1 };   // 2026-11-05 is a Thursday

test('5 minutes before, and not 10 or after it started', () => {
  assert.strictEqual(meetingStartsSoon(m, '', '2026-11-05', '10:55'), 5);
  assert.strictEqual(meetingStartsSoon(m, '', '2026-11-05', '10:59'), 1);
  assert.strictEqual(meetingStartsSoon(m, '', '2026-11-05', '10:50'), 0);
  assert.strictEqual(meetingStartsSoon(m, '', '2026-11-05', '11:00'), 0);
});

test('only on its day, before its end date, and on its weeks', () => {
  assert.strictEqual(meetingStartsSoon(m, '', '2026-11-06', '10:55'), 0);
  assert.strictEqual(meetingStartsSoon(Object.assign({}, m, { until: '2026-11-04' }), '', '2026-11-05', '10:55'), 0);
  const fortnightly = Object.assign({}, m, { every: 2 });
  assert.strictEqual(meetingStartsSoon(fortnightly, '2026-10-29', '2026-11-05', '10:55'), 0);
  assert.strictEqual(meetingStartsSoon(fortnightly, '2026-10-22', '2026-11-05', '10:55'), 5);
  assert.strictEqual(meetingStartsSoon(m, '2026-11-12', '2026-11-05', '10:55'), 0);
});
