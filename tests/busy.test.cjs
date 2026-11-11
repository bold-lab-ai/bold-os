// functions/busy.js: reading free/busy calendars and suggesting a project's meeting time (#323).
const test = require('node:test');
const assert = require('node:assert');
const B = require('../functions/busy.js');

const cal = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0'].concat(...events.map((e) => ['BEGIN:VEVENT'].concat(e, 'END:VEVENT')), 'END:VCALENDAR').join('\r\n');
const iso = (t) => new Date(t).toISOString().slice(0, 16);
const NOV = Date.UTC(2026, 10, 1), DEC = Date.UTC(2026, 11, 1);

test('a single event in UTC, and one in a zone, across the clocks changing', () => {
  const b = B.busyFrom(cal(['DTSTART:20261110T140000Z', 'DTEND:20261110T150000Z'],
    ['DTSTART;TZID=Europe/London:20261020T100000', 'DTEND;TZID=Europe/London:20261020T110000'],
    ['DTSTART;TZID=Europe/London:20261103T100000', 'DTEND;TZID=Europe/London:20261103T110000']), Date.UTC(2026, 9, 1), DEC);
  // London: BST (UTC+1) on 20 Oct, GMT on 3 Nov.
  assert.deepStrictEqual(b.map((x) => iso(x[0])), ['2026-10-20T09:00', '2026-11-03T10:00', '2026-11-10T14:00']);
});

test('a weekly series with an exception and a moved date', () => {
  const b = B.busyFrom(cal(
    ['UID:a', 'DTSTART;TZID=Europe/Berlin:20260105T090000', 'DTEND;TZID=Europe/Berlin:20260105T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE', 'EXDATE;TZID=Europe/Berlin:20261104T090000'],
    ['UID:a', 'RECURRENCE-ID;TZID=Europe/Berlin:20261109T090000', 'DTSTART;TZID=Europe/Berlin:20261109T150000', 'DTEND;TZID=Europe/Berlin:20261109T160000']),
  NOV, Date.UTC(2026, 10, 12));
  // Berlin is UTC+1 in November: Mon 2 Nov, (Wed 4 Nov out), Mon 9 Nov moved to 15:00, Wed 11 Nov.
  assert.deepStrictEqual(b.map((x) => iso(x[0])), ['2026-11-02T08:00', '2026-11-09T14:00', '2026-11-11T08:00']);
});

test('INTERVAL, COUNT and UNTIL', () => {
  const two = B.busyFrom(cal(['DTSTART:20261102T120000Z', 'DURATION:PT30M', 'RRULE:FREQ=WEEKLY;INTERVAL=2']), NOV, DEC);
  assert.deepStrictEqual(two.map((x) => iso(x[0]).slice(0, 10)), ['2026-11-02', '2026-11-16', '2026-11-30']);
  assert.strictEqual(two[0][1] - two[0][0], 30 * 60000);
  const count = B.busyFrom(cal(['DTSTART:20261102T120000Z', 'DTEND:20261102T130000Z', 'RRULE:FREQ=DAILY;COUNT=3']), NOV, DEC);
  assert.strictEqual(count.length, 3);
  const until = B.busyFrom(cal(['DTSTART:20261102T120000Z', 'DTEND:20261102T130000Z', 'RRULE:FREQ=DAILY;UNTIL=20261104T120000Z']), NOV, DEC);
  assert.strictEqual(until.length, 3);
});

test('monthly on the second Tuesday, and on the last Friday', () => {
  const b = B.busyFrom(cal(['DTSTART:20260113T100000Z', 'DTEND:20260113T110000Z', 'RRULE:FREQ=MONTHLY;BYDAY=2TU'],
    ['DTSTART:20260130T100000Z', 'DTEND:20260130T110000Z', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR']), NOV, DEC);
  assert.deepStrictEqual(b.map((x) => iso(x[0]).slice(0, 10)), ['2026-11-10', '2026-11-27']);
});

test('free (transparent) and cancelled events, and an Outlook zone name', () => {
  const b = B.busyFrom(cal(['DTSTART:20261110T100000Z', 'DTEND:20261110T110000Z', 'TRANSP:TRANSPARENT'],
    ['DTSTART:20261111T100000Z', 'DTEND:20261111T110000Z', 'STATUS:CANCELLED'],
    ['DTSTART;TZID="GMT Standard Time":20261112T100000', 'DTEND;TZID="GMT Standard Time":20261112T110000']), NOV, DEC);
  assert.deepStrictEqual(b.map((x) => iso(x[0])), ['2026-11-12T10:00']);
});

test('VFREEBUSY periods, and long lines folded', () => {
  const text = 'BEGIN:VCALENDAR\r\nBEGIN:VFREEBUSY\r\nFREEBUSY:20261110T100000Z/20261110T110000Z,20261110T1\r\n 30000Z/PT1H\r\nFREEBUSY;FBTYPE=FREE:20261111T100000Z/20261111T110000Z\r\nEND:VFREEBUSY\r\nEND:VCALENDAR';
  assert.deepStrictEqual(B.busyFrom(text, NOV, DEC).map((x) => [iso(x[0]), iso(x[1])]), [['2026-11-10T10:00', '2026-11-10T11:00'], ['2026-11-10T13:00', '2026-11-10T14:00']]);
});

test('overlapping times merge', () => {
  assert.deepStrictEqual(B.merge([[5, 9], [1, 3], [2, 6], [10, 11]]), [[1, 9], [10, 11]]);
});

test('a BOLD.OS meeting every two weeks falls on its own weeks', () => {
  const b = B.meetingBusy({ day: 'TU', time: '14:00', minutes: 60, every: 2 }, NOV, DEC, '2026-11-03');
  assert.deepStrictEqual(b.map((x) => iso(x[0])), ['2026-11-03T14:00', '2026-11-17T14:00']);
});

test('suggest: everyone free first, then fewest clashes, inside core hours, two a day at most', () => {
  // Today Wed 11 Nov: the next Mondays are 16, 23, 30 Nov and 7 Dec.
  const mon = (d, hm, min) => { const s = B.londonMs(d, hm); return [s, s + min * 60000]; };
  const ana = { name: 'Ana', busy: ['2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07'].map((d) => mon(d, '10:00', 120)) };
  const ben = { name: 'Ben', busy: [mon('2026-11-16', '09:00', 540)] };   // all of one Monday
  const s = B.suggest({ people: [ana, ben], minutes: 60, every: 1, today: '2026-11-11' });
  assert.strictEqual(s.length, 5);
  assert.ok(s.every((x) => x.free === 2));
  assert.deepStrictEqual(s.slice(0, 2).map((x) => x.day + ' ' + x.time), ['TU 10:00', 'TU 10:30']);
  assert.ok(!s.some((x) => x.day === 'MO'));
  // Ana busy every Monday morning, Ben one Monday: on Mondays, Ana clashes 4 times.
  const monOnly = B.suggest({ people: [ana, ben], minutes: 60, every: 1, today: '2026-11-11', count: 200 }).filter((x) => x.day === 'MO');
  assert.ok(monOnly.length <= 2);
});

test('suggest counts the weeks the meeting falls on', () => {
  const s = B.londonMs('2026-11-23', '10:00');
  const p = [{ name: 'Ana', busy: [[s, s + 3600000]] }];
  // Every 2 weeks from 16 Nov: 16 Nov, 30 Nov… — 23 Nov isn't one of them.
  const all = B.suggest({ people: p, minutes: 60, every: 2, today: '2026-11-11', count: 200 });
  assert.ok(all.some((x) => x.day === 'MO'));
});

test('only Google, Outlook and iCloud calendar links', () => {
  assert.strictEqual(B.okFeedUrl('webcal://p52-caldav.icloud.com/published/2/abc'), 'https://p52-caldav.icloud.com/published/2/abc');
  assert.ok(B.okFeedUrl('https://calendar.google.com/calendar/ical/x%40gmail.com/public/basic.ics'));
  assert.ok(B.okFeedUrl('https://outlook.office365.com/owa/calendar/abc/def/calendar.ics'));
  assert.strictEqual(B.okFeedUrl('http://calendar.google.com/x.ics'), '');
  assert.strictEqual(B.okFeedUrl('https://169.254.169.254/latest'), '');
  assert.strictEqual(B.okFeedUrl('https://calendar.google.com.evil.example/x.ics'), '');
  assert.strictEqual(B.okFeedUrl('https://calendar.google.com:8443/x.ics'), '');
});

test('Google Calendar’s share and embed links become the calendar’s public iCal address', () => {
  const cid = Buffer.from('someone@example.org').toString('base64').replace(/=+$/, '');
  const ical = 'https://calendar.google.com/calendar/ical/someone%40example.org/public/basic.ics';
  assert.strictEqual(B.okFeedUrl('https://calendar.google.com/calendar/u/0?cid=' + cid), ical);
  assert.strictEqual(B.okFeedUrl('https://calendar.google.com/calendar/embed?src=someone%40example.org&ctz=Europe%2FLondon'), ical);
  assert.strictEqual(B.okFeedUrl('https://calendar.google.com/calendar/r?cid=someone@example.org'), ical);
  // An iCal address stays as it is; a link with no calendar in it too.
  assert.strictEqual(B.okFeedUrl('https://calendar.google.com/calendar/ical/x%40y.org/private-abc/basic.ics'), 'https://calendar.google.com/calendar/ical/x%40y.org/private-abc/basic.ics');
  assert.strictEqual(B.okFeedUrl('https://calendar.google.com/calendar/u/0/r'), 'https://calendar.google.com/calendar/u/0/r');
  assert.strictEqual(B.googleIcal('https://calendar.google.com/calendar/u/0?cid=bm90IGFuIGlk'), '');
});

test('several calendars a person, and the one link of before', () => {
  assert.deepStrictEqual(B.feedsOf({ url: 'https://a', at: 5, checkedAt: 6 }), [{ id: 'a', url: 'https://a', at: 5, checkedAt: 6 }]);
  assert.deepStrictEqual(B.feedsOf({ feeds: [{ id: 'x', url: 'https://g' }, null, { id: 'y', url: 'https://o' }] }).map((f) => f.id), ['x', 'y']);
  assert.deepStrictEqual(B.feedsOf(undefined), []);
});

test('a calendar’s own name, never an email address', () => {
  assert.strictEqual(B.calendarName('BEGIN:VCALENDAR\r\nX-WR-CALNAME:Holidays in the UK\r\nEND:VCALENDAR'), 'Holidays in the UK');
  assert.strictEqual(B.calendarName('X-WR-CALNAME:Lab\\, BOLD\n'), 'Lab, BOLD');
  assert.strictEqual(B.calendarName('X-WR-CALNAME:someone@example.org\n'), '');
  assert.strictEqual(B.calendarName('BEGIN:VCALENDAR\n'), '');
});

test('suggestOnce: a time everyone’s free, soonest first, two a day at most, an hour from now at the earliest', () => {
  const now = B.londonMs('2026-11-11', '14:10');   // Wednesday
  const ana = { name: 'Ana', busy: [[B.londonMs('2026-11-11', '15:00'), B.londonMs('2026-11-12', '18:00')]] };   // until Thursday's end
  const ben = { name: 'Ben', busy: [[B.londonMs('2026-11-13', '09:00'), B.londonMs('2026-11-13', '12:00')]] };
  const s = B.suggestOnce({ people: [ana, ben], minutes: 60, now });
  assert.strictEqual(s.length, 5);
  assert.ok(s.every((x) => x.free === 2 && x.of === 2));
  const at = s.map((x) => new Date(x.start).toISOString().slice(0, 16));
  assert.deepStrictEqual(at.slice(0, 2), ['2026-11-13T12:00', '2026-11-13T12:30']);   // Friday, after Ben's morning; in core hours
  assert.ok(!at.some((t) => t.startsWith('2026-11-14') || t.startsWith('2026-11-15')));   // no weekend
  // Nobody free: the times the most are, with who's busy.
  const all = { name: 'Cy', busy: [[now, now + 30 * 86400000]] };
  const t = B.suggestOnce({ people: [ana, all], minutes: 30, now });
  assert.ok(t.length && t.every((x) => x.free === 1 && x.busy[0] === 'Cy'));
});
