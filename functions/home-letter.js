// The home letter (docs/home-letter-prompt.md): its inputs, and checking a letter. Who writes it is the lab's
// switch (settings/homeLetter.writer: 'claude', BOLD LLM, functions/bold-llm.js, or 'rules'), for everyone.
// Pure, for bold-llm.js, the agents' API (letterInputs) and tests.
'use strict';

// How often BOLD LLM writes the letters (settings/homeLetter.refresh, Settings › BOLD Agent): the hours (London) it writes at.
const REFRESH = { daily: [6], twice: [6, 13], working: [6, 9, 12, 15, 18] };
const refreshHours = (r) => REFRESH[r] || REFRESH.daily;
// Pure: does BOLD LLM write the letters at this hour (0–23, London), with refresh r?
function writesAt(r, hour){ return refreshHours(r).indexOf(Number(hour)) >= 0; }
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

// Today's letter, written within the last 24 hours (what a morning letter covers).
function isFresh(doc, now){ return !!(doc && doc.at && (now || Date.now()) - doc.at < 24 * 3600000); }

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
function inputsOf(p){
  const cal = p.calendar || {}, mine = p.mine || {};
  const week = [].concat(
    (cal.project_meetings || []).filter((m) => m.you_are_in_it && !m.paused).map((m) => ({ kind: 'project', title: m.project, when: m.when, url: m.url })),
    (cal.supervision_meetings || []).filter((m) => m.you_are_in_it && !m.paused).map((m) => ({ kind: 'supervision', title: m.title || m.student, when: m.when })),
    (cal.lab_meetings || []).filter((m) => m.you_are_invited && !m.paused).map((m) => ({ kind: 'lab', title: m.title, when: m.when, url: m.url })));
  return {
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
}

module.exports = { REFRESH, refreshHours, writesAt, sinceFor, SHORT_MAX, LONG_MAX, checkLetter, isFresh, londonNow, inputsOf };
