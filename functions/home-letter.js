// The home letter (docs/home-letter-prompt.md): its inputs, and checking a letter. Who writes it is the lab's
// switch (settings/homeLetter.writer: 'claude', BOLD LLM, functions/bold-llm.js, or 'rules'), for everyone.
// Pure, for bold-llm.js, the agents' API (letterInputs) and tests.
'use strict';

// How often BOLD LLM writes the letters, and which is current: letter-due.js (shared with the home page).
const { REFRESH, refreshHours, lastDue, isFresh } = require('./letter-due');
// Pure: does BOLD LLM write the letters at this hour (0–23, London), with refresh r?
function writesAt(r, hour){ return refreshHours(r).indexOf(Number(hour)) >= 0; }
// Pure: the London date (YYYY-MM-DD) of a time.
function londonDate(t){ return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t)); }
// Pure: whose letters the morning writes, in order (people: [{ email, name, lastSeen (ms, Firebase Auth), days (London
// dates they came, visits/{email}) }]). Only those on BOLD.OS in the past week (their last day, or Auth's last visit);
// those who came on most of the last 14 days first, then the latest visit, then by email (a fixed order).
function letterOrder(people, now){
  const week = londonDate(now - 7 * 24 * 3600000), fortnight = londonDate(now - 14 * 24 * 3600000);
  return (people || []).map((p) => {
    const days = (p.days || []).filter((d) => typeof d === 'string');
    const last = days.reduce((a, d) => (d > a ? d : a), '');
    const seen = Math.max(p.lastSeen || 0, last ? Date.parse(last + 'T12:00:00Z') : 0);
    return { p, often: new Set(days.filter((d) => d > fortnight)).size, seen, recent: (last && last > week) || (p.lastSeen && now - p.lastSeen <= 7 * 24 * 3600000) };
  }).filter((x) => x.recent && x.p.email)
    .sort((a, b) => b.often - a.often || b.seen - a.seen || (a.p.email < b.p.email ? -1 : 1))
    .map((x) => x.p);
}
// Pure: what a letter written now covers: since the previous one, if it's from the last day, else the last 24 hours.
function sinceFor(prev, now){ const day = now - 24 * 3600000; return prev && prev.at > day && prev.at < now ? prev.at : day; }
const SHORT_MAX = 4000, LONG_MAX = 40000;

// A letter as the model writes it → { letter } or { error }.
function checkLetter(a){
  const short = typeof (a || {}).short === 'string' ? a.short.trim() : '';
  const long = typeof (a || {}).long === 'string' ? a.long.trim() : '';
  if (!short) return { error: 'Give short: the short letter, as Markdown.' };
  if (!long) return { error: 'Give long: the long letter, as Markdown.' };
  if (short.length > SHORT_MAX) return { error: 'short is too long: at most ' + SHORT_MAX + ' characters.' };
  if (long.length > LONG_MAX) return { error: 'long is too long: at most ' + LONG_MAX + ' characters.' };
  return { letter: { short, long } };
}


// The date and time in London: { date, weekday, time, time_zone }.
function londonNow(now){
  const d = new Date(now || Date.now()), tz = 'Europe/London';
  const part = (o) => new Intl.DateTimeFormat('en-GB', Object.assign({ timeZone: tz }, o)).format(d);
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return { date: ymd, weekday: part({ weekday: 'long' }), time: part({ hour: '2-digit', minute: '2-digit', hour12: false }), time_zone: tz };
}

// The inputs (the prompt's JSON) from what the API's tools read as the person. Every part is
// already only what they may see; this only shapes it. p: { now, since, person, waiting, calendar,
// events, mine, notes, conversations, changes }.
// Pure: worked out for the letter (2026-11-12: Sofya spent a third of its thinking re-deriving these, often wrongly), from
// the inputs below and now: how long each thing has waited and the GPU hours a proposal asks for; the waiting, grouped;
// deadlines in the next three weeks; today's meetings (done, on, later) and the next one. → facts.
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function meetingOf(when){
  const m = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)s, (\d\d:\d\d)–(\d\d:\d\d)/.exec(String(when || ''));
  return m ? { weekday: m[1], start: m[2], end: m[3], fortnightly: /every \d+ weeks/.test(when) } : null;
}
function factsOf(x, now){
  const day = 24 * 3600000, today = londonDate(now), time = londonNow(now).time.slice(0, 5), weekday = londonNow(now).weekday;
  const daysSince = (iso) => iso ? Math.max(0, Math.round((Date.parse(londonDate(Date.parse(iso)) + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / -day)) : null;
  const gpu = (title) => { const m = /\(([\d,]+) GPU hours\)/.exec(String(title || '')); return m ? Number(m[1].replace(/,/g, '')) : 0; };
  const waiting = (x.waiting_on_you || []).map((w) => ({ title: w.title, kind: w.kind, from: w.from, days_waiting: daysSince(w.since), gpu_hours: gpu(w.title) || undefined, url: w.url }))
    .sort((a, b) => (b.days_waiting || 0) - (a.days_waiting || 0));
  const kinds = {};
  waiting.forEach((w) => { const k = kinds[w.kind] || (kinds[w.kind] = { kind: w.kind, count: 0, gpu_hours: 0, longest_days: 0, largest: null }); k.count++; k.gpu_hours += w.gpu_hours || 0;
    k.longest_days = Math.max(k.longest_days, w.days_waiting || 0); if (w.gpu_hours && (!k.largest || w.gpu_hours > k.largest.gpu_hours)) k.largest = { title: w.title, from: w.from, gpu_hours: w.gpu_hours, url: w.url }; });
  const deadlines = [];
  // your_letters: { you_asked, you_write } (functions/api.js), or a list.
  const L = x.your_letters, letters = Array.isArray(L) ? L : L && typeof L === 'object' ? [].concat(L.you_write || [], L.you_asked || []) : [];
  letters.forEach((l) => (Array.isArray(l.recipients) ? l.recipients : []).forEach((r) => {
    if (!r.deadline || r.submitted) return;
    const left = Math.round((Date.parse(r.deadline + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / day);
    if (left >= 0 && left <= 21) deadlines.push({ what: 'letter for ' + (l.with || '') + ' to ' + r.name, deadline: r.deadline, days_left: left, url: l.url });
  }));
  deadlines.sort((a, b) => a.days_left - b.days_left);
  const meetings = (x.your_week || []).map((m) => Object.assign({ title: m.title, kind: m.kind, url: m.url }, meetingOf(m.when))).filter((m) => m.weekday);
  const todays = meetings.filter((m) => m.weekday === weekday).sort((a, b) => a.start < b.start ? -1 : 1)
    .map((m) => Object.assign({}, m, { state: m.end <= time ? 'done' : m.start <= time ? 'on now' : 'later today' }));
  const order = (m) => { let d = (WEEKDAYS.indexOf(m.weekday) - WEEKDAYS.indexOf(weekday) + 7) % 7; if (d === 0 && m.start <= time) d = 7; return d * 1440 + Number(m.start.slice(0, 2)) * 60 + Number(m.start.slice(3)); };
  const next = meetings.slice().sort((a, b) => order(a) - order(b))[0] || null;
  return {
    today: { date: today, weekday, time, meetings: todays, free_for_rest_of_today: !todays.some((m) => m.state !== 'done') },
    next_meeting: next && { title: next.title, weekday: next.weekday === weekday && order(next) < 1440 ? 'today' : next.weekday, start: next.start, url: next.url },
    waiting_longest_first: waiting,
    waiting_by_kind: Object.keys(kinds).map((k) => kinds[k]),
    deadlines_within_3_weeks: deadlines,
    os_changes_count: ((x.os_changes || {}).content || []).length,
  };
}

function inputsOf(p){
  const cal = p.calendar || {}, mine = p.mine || {};
  const week = [].concat(
    (cal.project_meetings || []).filter((m) => m.you_are_in_it && !m.paused).map((m) => ({ kind: 'project', title: m.project, when: m.when, url: m.url })),
    (cal.supervision_meetings || []).filter((m) => m.you_are_in_it && !m.paused).map((m) => ({ kind: 'supervision', title: m.title || m.student, when: m.when })),
    (cal.lab_meetings || []).filter((m) => m.you_are_invited && !m.paused).map((m) => ({ kind: 'lab', title: m.title, when: m.when, url: m.url })));
  const out = {
    now: londonNow(p.now),
    person: p.person,
    since: new Date(p.since).toISOString(),
    waiting_on_you: (p.waiting || []).map((x) => ({ kind: x.kind, title: x.title, from: (x.by && x.by.name) || '', since: x.since ? new Date(x.since).toISOString() : '', url: x.url })),
    your_week: week,
    your_projects: mine.projects || [],
    your_letters: mine.letters || mine.recommendation_letters || [],
    notifications: (p.notes || []).map((n) => ({ text: n.text, at: n.at ? new Date(n.at).toISOString() : '', read: !!n.read, url: n.href || '' })),
    conversations: (p.conversations || []).map((c) => ({ title: c.title, by: c.name || '', replies: c.replies || 0,
      last_reply: c.lastAt ? new Date(c.lastAt).toISOString() : '', started_by_you: !!c.yours, waits_for_an_answer: !(c.replies > 0), url: c.url })),
    lab: { events: (p.events || []).map((e) => ({ title: e.title, start: e.start, end: e.end, place: e.place, url: e.url })) },
    os_changes: { content: (p.changes || []).map((c) => ({ what: c.title, kind: c.collection, note: c.note || '', by: (c.by && c.by.name) || '',
      proposed_by: (c.proposedBy && c.proposedBy.name) || '', at: c.at ? new Date(c.at).toISOString() : '' })) },
  };
  // Worked out already (factsOf): the letter uses these numbers and doesn't recount them.
  try { out.facts = factsOf(out, p.now || Date.now()); } catch (e){ out.facts = { error: 'not worked out' }; }
  return out;
}

// Who writes the letters, as a ladder (settings/homeLetter.ladder, Settings › BOLD Agent): each tried in turn until one
// writes it; 'rules', the page's own letter, always does, so whatever is below it is never reached. Without a ladder (set
// before 2026-11-11), from writer and model. Pure. → e.g. ['sofya', 'claude', 'rules'].
const WRITERS = ['sofya', 'claude', 'rules'];
function ladderOf(x){
  x = x || {};
  let l = Array.isArray(x.ladder) ? x.ladder.filter((w, i, a) => WRITERS.indexOf(w) >= 0 && a.indexOf(w) === i) : null;
  if (!l || !l.length) l = x.writer !== 'claude' ? ['rules'] : x.model === 'sofya' ? ['sofya', 'claude', 'rules'] : ['claude', 'rules'];
  WRITERS.forEach((w) => { if (l.indexOf(w) < 0) l.push(w); });
  return l;
}
// Pure: the models above 'rules', in order (none: the rule-based letter for everyone).
function modelsOf(ladder){ return ladder.slice(0, ladder.indexOf('rules') < 0 ? ladder.length : ladder.indexOf('rules')); }

module.exports = { WRITERS, ladderOf, modelsOf, REFRESH, refreshHours, writesAt, lastDue, londonDate, letterOrder, sinceFor, SHORT_MAX, LONG_MAX, checkLetter, isFresh, londonNow, inputsOf, factsOf, meetingOf };
