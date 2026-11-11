'use strict';
// Free/busy, for suggesting a project's meeting time (#323, 2026-11-11). Each person may give a
// free/busy calendar link (an iCal address: Google's public address shared as "See only free/busy",
// Outlook's published "Can view when I'm busy", or a secret address); only when they're busy is
// read, never what. Pure, apart from fetchIcs.
//
// parseIcs(text) → { events, freebusy }; busyFrom(text, from, to) → busy [start, end] ms, merged;
// suggest({ people, minutes, every, today }) → the best weekly times; okFeedUrl(url) → https URL or ''.

const DAY = 86400000;
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const LONDON = 'Europe/London';
// Outlook writes Windows zone names.
const WINDOWS_ZONES = {
  'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik', 'UTC': 'UTC', 'Coordinated Universal Time': 'UTC',
  'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris', 'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw', 'E. Europe Standard Time': 'Europe/Chisinau', 'FLE Standard Time': 'Europe/Kiev', 'GTB Standard Time': 'Europe/Bucharest',
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver', 'Pacific Standard Time': 'America/Los_Angeles',
  'Arabian Standard Time': 'Asia/Dubai', 'India Standard Time': 'Asia/Kolkata', 'China Standard Time': 'Asia/Shanghai', 'Tokyo Standard Time': 'Asia/Tokyo',
  'Singapore Standard Time': 'Asia/Singapore', 'AUS Eastern Standard Time': 'Australia/Sydney'
};

function zone(tz){
  if (!tz) return '';
  tz = String(tz).replace(/^"|"$/g, '');
  if (WINDOWS_ZONES[tz]) return WINDOWS_ZONES[tz];
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e){ return LONDON; }
}
// How far `tz` is ahead of UTC at `ms`.
const fmts = {};
function offset(ms, tz){
  const f = fmts[tz] || (fmts[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  const p = {};
  f.formatToParts(new Date(ms)).forEach(function(x){ p[x.type] = x.value; });
  return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
}
// A wall-clock time in `tz` (month 0-based) → ms.
function wallToMs(y, mo, d, h, mi, s, tz){
  const guess = Date.UTC(y, mo, d, h, mi, s);
  if (!tz || tz === 'UTC') return guess;
  const t = guess - offset(guess, tz);
  return guess - offset(t, tz);
}
function londonMs(iso, hm){
  const a = iso.split('-').map(Number), b = hm.split(':').map(Number);
  return wallToMs(a[0], a[1] - 1, a[2], b[0], b[1], 0, LONDON);
}

// ---------- reading a calendar ----------
function lines(text){
  return String(text || '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}
function prop(line){
  const c = line.indexOf(':');
  if (c < 0) return null;
  const head = line.slice(0, c).split(';'), params = {};
  head.slice(1).forEach(function(p){ const e = p.indexOf('='); if (e > 0) params[p.slice(0, e).toUpperCase()] = p.slice(e + 1); });
  return { name: head[0].toUpperCase(), params: params, value: line.slice(c + 1) };
}
// A DATE or DATE-TIME → { y, mo, d, h, mi, s, tz, date } (tz '' for floating: London's, the lab's).
function when(p){
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(p.value).trim());
  if (!m) return null;
  return { y: +m[1], mo: m[2] - 1, d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0),
    tz: m[7] ? 'UTC' : zone(p.params.TZID) || LONDON, date: !m[4] || p.params.VALUE === 'DATE' };
}
const ms = function(w){ return wallToMs(w.y, w.mo, w.d, w.h, w.mi, w.s, w.tz); };
function duration(v){
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v).trim());
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * ((+m[2] || 0) * 7 * DAY + (+m[3] || 0) * DAY + (+m[4] || 0) * 3600000 + (+m[5] || 0) * 60000 + (+m[6] || 0) * 1000);
}
function rrule(v){
  const r = {};
  String(v).split(';').forEach(function(kv){ const e = kv.indexOf('='); if (e > 0) r[kv.slice(0, e).toUpperCase()] = kv.slice(e + 1); });
  return {
    freq: r.FREQ || '', interval: Math.max(1, +r.INTERVAL || 1), count: +r.COUNT || 0,
    until: r.UNTIL ? when({ value: r.UNTIL, params: {} }) : null,
    byday: r.BYDAY ? r.BYDAY.split(',').map(function(x){ const m = /^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(x.trim()); return m ? { n: +(m[1] || 0), day: WEEKDAYS.indexOf(m[2]) } : null; }).filter(Boolean) : [],
    bymonthday: r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number).filter(Boolean) : [],
    bymonth: r.BYMONTH ? r.BYMONTH.split(',').map(Number).filter(Boolean) : []
  };
}

function parseIcs(text){
  const events = [], freebusy = [];
  let ev = null, inFb = false;
  lines(text).forEach(function(line){
    if (line === 'BEGIN:VEVENT') { ev = { exdates: [] }; return; }
    if (line === 'END:VEVENT') { if (ev && ev.start) events.push(ev); ev = null; return; }
    if (line === 'BEGIN:VFREEBUSY') { inFb = true; return; }
    if (line === 'END:VFREEBUSY') { inFb = false; return; }
    const p = prop(line);
    if (!p) return;
    if (inFb && p.name === 'FREEBUSY') {
      if (/^FREE$/i.test(p.params.FBTYPE || '')) return;
      p.value.split(',').forEach(function(per){
        const ab = per.split('/'), a = when({ value: ab[0], params: {} });
        if (!a) return;
        const b = /^[+-]?P/.test(ab[1] || '') ? ms(a) + duration(ab[1]) : (when({ value: ab[1] || '', params: {} }) ? ms(when({ value: ab[1], params: {} })) : 0);
        if (b > ms(a)) freebusy.push([ms(a), b]);
      });
      return;
    }
    if (!ev) return;
    if (p.name === 'DTSTART') ev.start = when(p);
    else if (p.name === 'DTEND') ev.end = when(p);
    else if (p.name === 'DURATION') ev.duration = duration(p.value);
    else if (p.name === 'RRULE') ev.rrule = rrule(p.value);
    else if (p.name === 'EXDATE') p.value.split(',').forEach(function(v){ const w = when({ value: v, params: p.params }); if (w) ev.exdates.push(ms(w)); });
    else if (p.name === 'RECURRENCE-ID') { const w = when(p); if (w) ev.recurrenceId = ms(w); }
    else if (p.name === 'UID') ev.uid = p.value;
    else if (p.name === 'TRANSP') ev.free = /TRANSPARENT/i.test(p.value);
    else if (p.name === 'STATUS') ev.cancelled = /CANCELLED/i.test(p.value);
  });
  // A changed occurrence (RECURRENCE-ID) stands in for the one its series would have had.
  const moved = {};
  events.forEach(function(e){ if (e.recurrenceId && e.uid) (moved[e.uid] = moved[e.uid] || []).push(e.recurrenceId); });
  events.forEach(function(e){ if (e.rrule && !e.recurrenceId && moved[e.uid]) e.exdates = e.exdates.concat(moved[e.uid]); });
  return { events: events, freebusy: freebusy };
}

// The day `k` days after a date, with its weekday (0 = Monday).
function dayAfter(y, mo, d, k){
  const t = new Date(Date.UTC(y, mo, d + k));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth(), d: t.getUTCDate(), wd: (t.getUTCDay() + 6) % 7, t: t.getTime() };
}
function daysInMonth(y, mo){ return new Date(Date.UTC(y, mo + 1, 0)).getUTCDate(); }
function matches(r, s0, day){
  const dd = Math.round((day.t - Date.UTC(s0.y, s0.mo, s0.d)) / DAY);
  const md = (day.y - s0.y) * 12 + day.mo - s0.mo;
  if (r.bymonth.length && r.bymonth.indexOf(day.mo + 1) < 0) return false;
  const onDay = function(){
    if (!r.byday.length) return null;
    return r.byday.some(function(b){
      if (b.day !== day.wd) return false;
      if (!b.n) return true;
      const nth = b.n > 0 ? Math.ceil(day.d / 7) : -Math.ceil((daysInMonth(day.y, day.mo) - day.d + 1) / 7);
      return nth === b.n;
    });
  };
  const dim = daysInMonth(day.y, day.mo);
  const onMonthDay = function(){ return r.bymonthday.some(function(n){ return (n > 0 ? n : dim + n + 1) === day.d; }); };
  if (r.freq === 'DAILY') return dd % r.interval === 0 && (onDay() !== false);
  if (r.freq === 'WEEKLY') {
    const s0wd = dayAfter(s0.y, s0.mo, s0.d, 0).wd, week = Math.floor((dd + s0wd) / 7);
    return week % r.interval === 0 && (r.byday.length ? onDay() : day.wd === s0wd);
  }
  if (r.freq === 'MONTHLY') {
    if (md % r.interval) return false;
    if (r.byday.length) return onDay();
    if (r.bymonthday.length) return onMonthDay();
    return day.d === s0.d;
  }
  if (r.freq === 'YEARLY') {
    if ((day.y - s0.y) % r.interval) return false;
    if (r.byday.length && r.bymonth.length) return onDay();
    if (r.bymonthday.length) return (r.bymonth.length || day.mo === s0.mo) && onMonthDay();
    return (r.bymonth.length || day.mo === s0.mo) && day.d === s0.d;
  }
  return false;
}
// An event's times in [from, to): [start, end] pairs.
function occurrences(ev, from, to){
  const s0 = ev.start, start = ms(s0);
  const end = ev.end ? ms(ev.end) : ev.duration ? start + ev.duration : s0.date ? start + DAY : start;
  const len = Math.max(0, end - start), out = [];
  const add = function(s){ if (s < to && s + len > from && ev.exdates.indexOf(s) < 0) out.push([s, s + len]); };
  const r = ev.rrule;
  if (!r || !r.freq) { add(start); return out; }
  const until = r.until ? (r.until.date ? ms(Object.assign({}, r.until, { tz: s0.tz, h: 23, mi: 59, s: 59 })) : ms(r.until)) : Infinity;
  // Without COUNT, start a little before the window (whole days; matching is by date).
  let k = r.count ? 0 : Math.max(0, Math.floor((from - start) / DAY) - 2), n = 0, steps = 0;
  for (; steps < 40000; k++, steps++) {
    const day = dayAfter(s0.y, s0.mo, s0.d, k);
    const s = wallToMs(day.y, day.mo, day.d, s0.h, s0.mi, s0.s, s0.tz);
    if (s > until || s >= to) break;
    if (!matches(r, s0, day)) continue;
    n++;
    if (r.count && n > r.count) break;
    add(s);
  }
  return out;
}
function merge(list){
  const s = list.filter(function(x){ return x[1] > x[0]; }).sort(function(a, b){ return a[0] - b[0]; }), out = [];
  s.forEach(function(x){ const last = out[out.length - 1]; if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]); else out.push([x[0], x[1]]); });
  return out;
}
// When someone is busy in [from, to), from their calendar's text.
function busyFrom(text, from, to){
  const cal = parseIcs(text), all = [];
  cal.events.forEach(function(e){ if (!e.free && !e.cancelled) occurrences(e, from, to).forEach(function(x){ all.push(x); }); });
  cal.freebusy.forEach(function(x){ if (x[0] < to && x[1] > from) all.push(x); });
  return merge(all);
}

// A weekly meeting BOLD.OS knows of ({ day, time, minutes, every }, `phase`: one of its dates,
// YYYY-MM-DD, to tell which weeks it falls on when it's not every week) → busy in [from, to).
function meetingBusy(m, from, to, phase){
  const out = [], wd = WEEKDAYS.indexOf(m.day);
  if (wd < 0 || !/^\d\d:\d\d$/.test(m.time || '')) return out;
  const every = Math.max(1, +m.every || 1), len = (+m.minutes || 60) * 60000;
  const first = new Date(from - 2 * DAY), base = phase ? Date.parse(phase + 'T00:00:00Z') : NaN;
  for (let k = 0; k < 400; k++) {
    const d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate() + k));
    if ((d.getUTCDay() + 6) % 7 !== wd) continue;
    if (every > 1 && !isNaN(base) && Math.round((d.getTime() - base) / (7 * DAY)) % every !== 0) continue;
    const s = londonMs(d.toISOString().slice(0, 10), m.time);
    if (s >= to) break;
    if (m.until && d.toISOString().slice(0, 10) > m.until) break;
    if (s + len > from) out.push([s, s + len]);
  }
  return out;
}

// ---------- the best times ----------
// people: [{ name, busy: [[s, e]] }]; minutes; every (weeks); today (YYYY-MM-DD, London);
// weeks: how many of its dates are checked (4). Weekdays, 09:00 to 18:00 London, every half hour.
// → [{ day, time, free: n of people.length free every time, clash: [{ name, times }] }], best first:
// most people free every time, then fewest clashes, then inside 10:00–17:00, then earliest.
function suggest(o){
  const minutes = +o.minutes || 60, every = Math.max(1, +o.every || 1), weeks = o.weeks || 4, people = o.people || [];
  const startDay = Date.parse(o.today + 'T00:00:00Z'), out = [];
  for (let wd = 0; wd < 5; wd++) {
    const add = ((wd - (new Date(startDay).getUTCDay() + 6) % 7 + 7) % 7) || 7;   // its next date, after today
    const dates = [];
    for (let w = 0; w < weeks; w++) dates.push(new Date(startDay + (add + w * 7 * every) * DAY).toISOString().slice(0, 10));
    for (let t = 9 * 60; t + minutes <= 18 * 60; t += 30) {
      const hm = String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
      const slots = dates.map(function(d){ const s = londonMs(d, hm); return [s, s + minutes * 60000]; });
      const clash = [];
      people.forEach(function(p){
        const n = slots.filter(function(x){ return (p.busy || []).some(function(b){ return b[0] < x[1] && b[1] > x[0]; }); }).length;
        if (n) clash.push({ name: p.name, times: n });
      });
      out.push({ day: WEEKDAYS[wd], time: hm, free: people.length - clash.length, clash: clash, total: clash.reduce(function(s, c){ return s + c.times; }, 0),
        core: t >= 600 && t + minutes <= 1020 ? 0 : 1, order: wd * 1440 + t });
    }
  }
  out.sort(function(a, b){ return b.free - a.free || a.total - b.total || a.core - b.core || a.order - b.order; });
  // The best few, no more than two on a day.
  const perDay = {}, best = [];
  out.forEach(function(x){
    if (best.length >= (o.count || 5) || (perDay[x.day] || 0) >= 2) return;
    perDay[x.day] = (perDay[x.day] || 0) + 1;
    best.push({ day: x.day, time: x.time, free: x.free, clash: x.clash });
  });
  return best;
}

// Pure: one meeting, not a series (/meeting's Suggest a time): { people: [{ name, busy }], minutes, now, days = 14,
// count = 5 } → [{ start (ms), free, of, busy: [names] }]: weekdays 09:00–18:00 London in 30-minute steps, from an
// hour from now over the next `days` days; everyone free first, then the fewest busy, then inside 10:00–17:00,
// then the soonest; no more than two on a day.
function suggestOnce(o){
  const minutes = +o.minutes || 60, people = o.people || [], days = o.days || 14, earliest = o.now + 3600000, out = [];
  const today = new Date(o.now).toISOString().slice(0, 10), base = Date.parse(today + 'T00:00:00Z');
  for (let i = 0; i <= days; i++) {
    const date = new Date(base + i * DAY), iso = date.toISOString().slice(0, 10), dow = date.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    for (let t = 9 * 60; t + minutes <= 18 * 60; t += 30) {
      const start = londonMs(iso, String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'));
      if (start < earliest) continue;
      const end = start + minutes * 60000;
      const busy = people.filter(function(p){ return (p.busy || []).some(function(b){ return b[0] < end && b[1] > start; }); }).map(function(p){ return p.name; });
      out.push({ start, day: iso, free: people.length - busy.length, of: people.length, busy, core: t >= 600 && t + minutes <= 1020 ? 0 : 1 });
    }
  }
  out.sort(function(a, b){ return b.free - a.free || a.core - b.core || a.start - b.start; });
  const perDay = {}, best = [];
  out.forEach(function(x){
    if (best.length >= (o.count || 5) || (perDay[x.day] || 0) >= 2) return;
    perDay[x.day] = (perDay[x.day] || 0) + 1;
    best.push({ start: x.start, free: x.free, of: x.of, busy: x.busy });
  });
  return best.sort(function(a, b){ return a.start - b.start; });
}

// ---------- the link ----------
// Calendars it may read: Google's, Outlook's and iCloud's (the server fetches it: no other host).
const HOSTS = [/^calendar\.google\.com$/, /^outlook\.office365\.com$/, /^outlook\.office\.com$/, /^outlook\.live\.com$/, /^p\d+-(caldav|calendars)\.icloud\.com$/];
function okFeedUrl(u){
  u = String(u || '').trim().replace(/^webcals?:\/\//i, 'https://');
  if (u.length > 1000 || !/^https:\/\/[^\s"<>]+$/.test(u)) return '';
  let host;
  try { const x = new URL(u); if (x.port || x.username) return ''; host = x.hostname.toLowerCase(); } catch (e){ return ''; }
  if (!HOSTS.some(function(h){ return h.test(host); })) return '';
  return googleIcal(u) || u;
}
// Pure: Google Calendar's own links to a calendar (its "share" link, ?cid=, which is the calendar's id
// in base64, or an embed's ?src=) → its public iCal address, which works once the calendar is public
// (with "See only free/busy" or more); '' for any other link.
function googleIcal(u){
  let x;
  try { x = new URL(u); } catch (e){ return ''; }
  if (x.hostname.toLowerCase() !== 'calendar.google.com' || /^\/calendar\/ical\//.test(x.pathname)) return '';
  let id = x.searchParams.get('src') || '';
  const cid = x.searchParams.get('cid');
  if (!id && cid) {
    if (/@/.test(cid)) id = cid;
    else { try { id = Buffer.from(cid.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch (e){ id = ''; } }
  }
  id = id.trim();
  if (!/^[^\s@\/]+@[^\s@\/]+\.[^\s@\/]+$/.test(id)) return '';
  return 'https://calendar.google.com/calendar/ical/' + encodeURIComponent(id) + '/public/basic.ics';
}
// busyFeeds/{email} → its calendars, [{ id, url, at, checkedAt }]: `feeds`, or the one `url` from
// before there could be several (2026-11-11).
const MAX_FEEDS = 5;
// Pure: a calendar's own name (X-WR-CALNAME), to tell them apart on the profile; '' for none, or one that's
// an email address (Google names someone's main calendar after it).
function calendarName(text){
  const m = String(text || '').match(/^X-WR-CALNAME:(.*)$/m);
  const n = m ? m[1].replace(/\\([,;\\])/g, '$1').trim().slice(0, 80) : '';
  return /@/.test(n) ? '' : n;
}
function feedsOf(d){
  if (!d) return [];
  if (Array.isArray(d.feeds)) return d.feeds.filter(function(f){ return f && f.url; });
  return d.url ? [{ id: 'a', url: d.url, at: d.at || 0, checkedAt: d.checkedAt || 0 }] : [];
}
const PUBLIC_HOW = 'In Google Calendar: Settings › the calendar › Access permissions, tick “Make available to public” with “See only free/busy”, then add it again.';
// The calendar's text, or throws: only from those hosts (redirects too), at most 5 MB, 10 s.
async function fetchIcs(url){
  let u = okFeedUrl(url);
  for (let hop = 0; hop < 4; hop++) {
    if (!u) throw new Error('That isn’t a Google, Outlook or iCloud calendar link.');
    const ctl = new AbortController(), timer = setTimeout(function(){ ctl.abort(); }, 10000);
    try {
      const res = await fetch(u, { redirect: 'manual', signal: ctl.signal, headers: { Accept: 'text/calendar' } });
      const google = /^https:\/\/calendar\.google\.com\//i.test(u);
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location'), u).toString();
        // Google sending it to its sign-in: the calendar isn't public.
        if (google && /^https:\/\/accounts\.google\.com\//i.test(next)) throw new Error('Google keeps that calendar private. ' + PUBLIC_HOW);
        u = okFeedUrl(next); continue;
      }
      if (!res.ok) throw new Error(res.status === 404 || res.status === 403 ? (google ? 'Google keeps that calendar private. ' + PUBLIC_HOW : 'The calendar isn’t shared at that link.') : 'The calendar couldn’t be read (' + res.status + ').');
      const text = await res.text();
      if (text.length > 5e6) throw new Error('The calendar is too big to read.');
      if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('That link isn’t a calendar (iCal) address.');
      return text;
    } finally { clearTimeout(timer); }
  }
  throw new Error('The calendar link redirects too many times.');
}

module.exports = { suggestOnce, calendarName, feedsOf, MAX_FEEDS, googleIcal, parseIcs, busyFrom, occurrences, meetingBusy, suggest, okFeedUrl, fetchIcs, londonMs, wallToMs, merge, WEEKDAYS };
