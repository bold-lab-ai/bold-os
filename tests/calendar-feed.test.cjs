// The Calendar feed's events: functions/calendar-ics.js.
const test = require('node:test');
const assert = require('node:assert');
const { buildCalendar } = require('../functions/calendar-ics.js');

const now = Date.UTC(2026, 10, 19);

test('a one-day event with a start time is timed, in London time', () => {
  const ics = buildCalendar({ events: [{ id: 'gm', title: 'Group Meetings', start: '2026-11-23', end: '2026-11-23', time: '11:00', minutes: 60 }], now });
  assert.match(ics, /DTSTART;TZID=Europe\/London:20261123T110000/);
  assert.match(ics, /DTEND;TZID=Europe\/London:20261123T120000/);
  assert.doesNotMatch(ics, /VALUE=DATE/);
});

test('an event without a start time, or over several days, lasts all day', () => {
  const ics = buildCalendar({ events: [
    { id: 'a', title: 'Workshop', start: '2026-11-23', end: '2026-11-24', time: '10:00' },
    { id: 'b', title: 'Pitch Day', start: '2026-11-25', end: '2026-11-25' }], now });
  assert.match(ics, /DTSTART;VALUE=DATE:20261123\r\nDTEND;VALUE=DATE:20261125/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261125\r\nDTEND;VALUE=DATE:20261126/);
  assert.doesNotMatch(ics, /TZID=Europe\/London:2026112/);
});
