// One date of a recurring meeting moved (2026-11-11): a project's, a supervision or an event series' meeting
// is weekly (or every few weeks) at its day and time; one of its dates can be moved to another day, time or
// length, the rest staying. Kept on the meeting's doc as `meetingMoved: { <its own date>: { date, time, minutes } }`
// (YYYY-MM-DD, HH:MM London, minutes) and `movedTo` (the dates moved to, for the reminders' query); what's in
// Google Calendar as `eventMoved` (the same shape). Pure.
'use strict';

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const DAY = 86400000;
const MAX = 30;
const isoDay = /^\d{4}-\d{2}-\d{2}$/;
const hm = /^([01]\d|2[0-3]):[0-5]\d$/;

const weekdayOf = (iso) => WEEKDAYS[(new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7];
const okMinutes = (m) => m >= 15 && m <= 240 && m % 15 === 0;

// Pure: whether `iso` is one of the meeting's own dates: its weekday, on or after its first (`start`), in its
// weeks when it's every few, not after its end.
function isOccurrence(meeting, start, iso){
  if (!meeting || !isoDay.test(iso || '') || weekdayOf(iso) !== meeting.day) return false;
  if (meeting.until && iso > meeting.until) return false;
  if (start && isoDay.test(start)) {
    if (iso < start) return false;
    const weeks = Math.round((Date.parse(iso) - Date.parse(start)) / (7 * DAY));
    if (weeks % (meeting.every || 1) !== 0) return false;
  }
  return true;
}

// Pure: a move asked for → { date, time, minutes } or { error }. `orig`: the date it moves from; `today` (London).
function normalizeMove(meeting, start, orig, to, today){
  if (!isOccurrence(meeting, start, orig)) return { error: 'That isn’t one of its dates.' };
  to = to || {};
  const date = String(to.date || ''), time = String(to.time || ''), minutes = Number(to.minutes || meeting.minutes);
  if (!isoDay.test(date) || isNaN(Date.parse(date))) return { error: 'Choose a day.' };
  if (!hm.test(time)) return { error: 'Choose a time.' };
  if (!okMinutes(minutes)) return { error: 'Choose how long it lasts (15 minutes to 4 hours).' };
  if (orig < today || date < today) return { error: 'That’s in the past.' };
  if (Math.abs(Date.parse(date) - Date.parse(orig)) > 60 * DAY) return { error: 'Move it by two months at most.' };
  return { date, time, minutes };
}

// Pure: the moves with `orig` moved to `move` (back to its own time, or null: no longer moved), the past ones
// (both dates before `today`) dropped, the latest MAX kept.
function withMove(moved, meeting, orig, move, today){
  const out = {};
  Object.keys(moved || {}).forEach(function(k){ const x = moved[k]; if (x && (k >= today || x.date >= today)) out[k] = x; });
  const back = !move || (move.date === orig && move.time === meeting.time && Number(move.minutes) === Number(meeting.minutes));
  if (back) delete out[orig]; else out[orig] = { date: move.date, time: move.time, minutes: Number(move.minutes) };
  const keys = Object.keys(out).sort();
  keys.slice(0, Math.max(0, keys.length - MAX)).forEach(function(k){ delete out[k]; });
  return out;
}

// Pure: the dates its moved dates went to, sorted, once each.
function movedTo(moved){
  return Object.keys(moved || {}).map(function(k){ return moved[k].date; }).filter(function(d, i, a){ return a.indexOf(d) === i; }).sort();
}

// Pure: its dates from `from` to `to` (YYYY-MM-DD, inclusive), moves applied → [{ orig, date, time, minutes, moved }],
// by date and time. A date moved into the range from outside it is in; one moved out isn't.
function occurrences(meeting, start, moved, from, to){
  const out = [];
  if (!meeting || WEEKDAYS.indexOf(meeting.day) < 0 || !hm.test(meeting.time || '')) return out;
  moved = moved || {};
  const lo = new Date(Date.parse(from) - 62 * DAY), hi = Date.parse(to) + 62 * DAY;
  for (let t = Date.UTC(lo.getUTCFullYear(), lo.getUTCMonth(), lo.getUTCDate()); t <= hi; t += DAY) {
    const iso = new Date(t).toISOString().slice(0, 10);
    if (!isOccurrence(meeting, start, iso)) continue;
    const mv = moved[iso];
    const x = mv ? { orig: iso, date: mv.date, time: mv.time, minutes: Number(mv.minutes), moved: true }
      : { orig: iso, date: iso, time: meeting.time, minutes: Number(meeting.minutes) || 60, moved: false };
    if (x.date >= from && x.date <= to) out.push(x);
  }
  return out.sort(function(a, b){ return a.date < b.date ? -1 : a.date > b.date ? 1 : a.time < b.time ? -1 : a.time > b.time ? 1 : 0; });
}

// Pure: the Google Calendar id of one date of a recurring event: its id, then its own start in UTC.
// `startMs`: that date at the meeting's time, in London (busy.londonMs).
function instanceId(eventId, startMs){
  return eventId + '_' + new Date(startMs).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
}

// Pure: what Google Calendar needs changing to match the moves: [{ orig, to: { date, time, minutes } }], `to`
// being its own date and time again for one no longer moved.
function movesToSync(meeting, moved, applied){
  const out = [], keys = Object.keys(Object.assign({}, applied || {}, moved || {})).sort();
  keys.forEach(function(k){
    const want = (moved || {})[k] || null, had = (applied || {})[k] || null;
    if (JSON.stringify(want) === JSON.stringify(had)) return;
    out.push({ orig: k, to: want || { date: k, time: meeting.time, minutes: Number(meeting.minutes) || 60 } });
  });
  return out;
}

module.exports = { WEEKDAYS, MAX, weekdayOf, isOccurrence, normalizeMove, withMove, movedTo, occurrences, instanceId, movesToSync };
