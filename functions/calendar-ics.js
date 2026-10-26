'use strict';

// The Calendar as an iCalendar feed (RFC 5545), for subscribing to it from Google
// Calendar, Apple Calendar or Outlook (calendarFeed and boldApi's /calendar/… in
// functions/api.js). Pure: data in, text out.
//   events:   [{ id, title, start, end (YYYY-MM-DD, inclusive), place, description, url }]
//   meetings: [{ id, title, meeting { day, time, minutes, every, until }, start (YYYY-MM-DD:
//              the series' first day), pausedAt (ms), description, url }]
// Meetings repeat weekly in London time, as BOLD.OS makes them in Google Calendar; a
// paused one ends when it was paused, as it does there.

const TZ = 'Europe/London';
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const VTIMEZONE = [
  'BEGIN:VTIMEZONE', 'TZID:' + TZ,
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0000', 'TZOFFSETTO:+0100', 'TZNAME:BST', 'DTSTART:19700329T010000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0000', 'TZNAME:GMT', 'DTSTART:19701025T020000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

const text = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const day = (iso) => iso.replace(/-/g, '');
const utc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
const isoDay = /^\d{4}-\d{2}-\d{2}$/;

// Lines longer than 75 bytes go on as continuation lines (a space first), never inside a character.
function fold(line){
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function nextDay(iso){
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// The first day on or after `from` that falls on the meeting's weekday.
function firstOn(weekday, from){
  const d = new Date(from + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + (WEEKDAYS.indexOf(weekday) - (d.getUTCDay() + 6) % 7 + 7) % 7);
  return d.toISOString().slice(0, 10);
}

function local(iso, hm, addMinutes){
  const [h, m] = hm.split(':').map(Number);
  const t = new Date(iso + 'T00:00:00Z').getTime() + (h * 60 + m + (addMinutes || 0)) * 60000;
  return utc(t).replace(/Z$/, '');
}

function eventLines(e, stamp){
  if (!isoDay.test(e.start || '')) return [];
  const end = isoDay.test(e.end || '') && e.end >= e.start ? e.end : e.start;
  return ['BEGIN:VEVENT', 'UID:event-' + e.id + '@bold-os', 'DTSTAMP:' + stamp,
    'DTSTART;VALUE=DATE:' + day(e.start), 'DTEND;VALUE=DATE:' + day(nextDay(end)),
    'SUMMARY:' + text(e.title)]
    .concat(e.place ? ['LOCATION:' + text(e.place)] : [])
    .concat(['DESCRIPTION:' + text([e.description, e.url].filter(Boolean).join('\n\n'))])
    .concat(e.url ? ['URL:' + e.url] : [])
    .concat(['TRANSP:TRANSPARENT', 'END:VEVENT']);
}

function meetingLines(x, stamp, today){
  const m = x.meeting || {};
  if (WEEKDAYS.indexOf(m.day) < 0 || !/^\d\d:\d\d$/.test(m.time || '')) return [];
  const first = firstOn(m.day, isoDay.test(x.start || '') ? x.start : today);
  const ends = [x.pausedAt || 0, isoDay.test(m.until || '') ? Date.parse(m.until + 'T23:59:59Z') : 0].filter(Boolean);
  const rule = 'RRULE:FREQ=WEEKLY' + (m.every > 1 ? ';INTERVAL=' + m.every : '') + ';BYDAY=' + m.day +
    (ends.length ? ';UNTIL=' + utc(Math.min.apply(null, ends)) : '');
  return ['BEGIN:VEVENT', 'UID:' + x.id + '@bold-os', 'DTSTAMP:' + stamp,
    'DTSTART;TZID=' + TZ + ':' + local(first, m.time), 'DTEND;TZID=' + TZ + ':' + local(first, m.time, m.minutes || 60),
    rule, 'SUMMARY:' + text(x.title),
    'DESCRIPTION:' + text([x.description, x.url].filter(Boolean).join('\n\n'))]
    .concat(x.url ? ['URL:' + x.url] : [])
    .concat(['TRANSP:TRANSPARENT', 'END:VEVENT']);
}

function buildCalendar({ name, events, meetings, now }){
  now = now || Date.now();
  const stamp = utc(now), today = new Date(now).toISOString().slice(0, 10);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BOLD Lab//BOLD.OS//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + text(name || 'BOLD Lab'), 'X-WR-TIMEZONE:' + TZ, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H']
    .concat(VTIMEZONE)
    .concat([].concat.apply([], (events || []).map((e) => eventLines(e, stamp))))
    .concat([].concat.apply([], (meetings || []).map((x) => meetingLines(x, stamp, today))))
    .concat(['END:VCALENDAR']);
  return lines.map(fold).join('\r\n') + '\r\n';
}

module.exports = { buildCalendar, fold, firstOn };
