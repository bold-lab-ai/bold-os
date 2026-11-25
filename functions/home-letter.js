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
// Pure: what a letter written now covers: since their last visit (visits/{email}: seenAt, the latest moment they were on
// BOLD.OS, kept by bold.js; lastVisitEnd, the end of the visit before, kept by onVisit). If they're on now (seen in the
// last 30 minutes, as when they open the page and it's written for them), since that visit before. Without times
// (before 2026-11-15), the start of the last day they came before today; without that, the last 24 hours. Never more
// than 14 days back. Not from their previous letter: one they never opened mustn't hide what it said. → ms.
const ON_NOW = 30 * 60000, SINCE_MAX = 14 * 24 * 3600000;
function sinceFor(prev, visit, now){
  const v = visit || {}, ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : Number(t) || 0);
  const seen = ms(v.seenAt), before = ms(v.lastVisitEnd);
  let at = 0;
  if (seen && now - seen > ON_NOW) at = seen;
  else if (seen && before) at = before;
  if (!at) {
    const today = londonDate(now), days = (v.days || []).filter((d) => typeof d === 'string' && d < today).sort();
    if (days.length) at = Date.parse(days[days.length - 1] + 'T00:00:00Z') - (londonOffset(days[days.length - 1]) * 60000);
  }
  if (!at || at >= now) at = now - 24 * 3600000;
  return Math.max(at, now - SINCE_MAX);
}
// Pure: London's offset from UTC on a date, in minutes (0 or 60).
function londonOffset(date){
  const t = Date.parse(date + 'T12:00:00Z');
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(new Date(t)));
  return (h - 12) * 60;
}
// Pure: how long ago a time was, in words, from now (London): "2 hours", "since yesterday 18:40", "3 days".
function agoText(at, now){
  const mins = Math.round((now - at) / 60000), today = londonDate(now), d = londonDate(at);
  const hm = londonNow(at).time.slice(0, 5);
  if (d === today) return mins < 90 ? mins + ' minutes, since ' + hm + ' today' : Math.round(mins / 60) + ' hours, since ' + hm + ' today';
  if (d === londonDate(now - 24 * 3600000)) return 'since yesterday ' + hm;
  const days = Math.round((Date.parse(today + 'T12:00:00Z') - Date.parse(d + 'T12:00:00Z')) / (24 * 3600000));
  return days + ' days, since ' + londonNow(at).weekday + ' ' + d + ' ' + hm;
}
// Pure: the lab as the letter sees it, trimmed to what bears on them (who they could help, who could help them):
// projects not completed, with their open cards, and people but them, each ranked by how much it shares with them
// (`you`: their interests and projects; sharing nothing, left out): a project they're in, then shared words in keywords, title and abstract (one
// with open cards ahead of one without); a person on a project of theirs, then shared words in their interests. Kept
// best first until the two come to `max` characters. projects: [{ title, stage, venue, keywords, abstract, members,
// you_are_in_it, open_cards: { count, titles }, url }]; people: [{ name, role, group, interests, projects, profile }].
const STOP = new Set('and the for with from into that this their about learning based using towards via incl other'.split(' '));
function wordsOf(s){ return new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w))); }
function directoryOf(projects, people, max, you){
  max = max || 25000;
  const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
  const mine = wordsOf([(you || {}).interests, (you || {}).role].join(' ')), theirs = new Set(((you || {}).projects || []).map(String));
  const shared = (text) => { let n = 0; wordsOf(text).forEach((w) => { if (mine.has(w)) n++; }); return n; };
  const ps = (projects || []).map((p, i) => ({ score: (p.you_are_in_it ? 100 : 0) + 2 * shared((p.keywords || []).join(' ') + ' ' + p.title) + shared(p.abstract)
      + (p.open_cards && p.open_cards.count ? 1 : 0) - i / 1000,
    row: { title: p.title, stage: p.stage, venue: p.venue || undefined, keywords: (p.keywords || []).slice(0, 8),
      abstract: cut(p.abstract, 300) || undefined, members: (p.members || []).slice(0, 15), you_are_in_it: !!p.you_are_in_it || undefined,
      open_cards: p.open_cards && p.open_cards.count ? { count: p.open_cards.count, titles: (p.open_cards.titles || []).slice(0, 3).map((t) => cut(t, 90)) } : undefined,
      url: p.url } }));
  const qs = (people || []).map((m, i) => ({ score: 10 * (m.projects || []).filter((t) => theirs.has(String(t))).length + shared(m.interests) + ((m.interests || (m.projects || []).length) ? 0.5 : 0) - i / 1000,
    row: { name: m.name, pronouns: m.pronouns || undefined, role: cut(m.role, 80) || undefined, group: m.group || undefined, interests: cut(m.interests, 200) || undefined,
      projects: (m.projects || []).slice(0, 6), profile: m.profile } }));
  // Best first, the two lists in turn, until the next one wouldn't fit.
  // Nothing shared: no use to the letter.
  const near = (x) => x.score >= 1;
  const P = ps.filter(near).sort((a, b) => b.score - a.score), Q = qs.filter(near).sort((a, b) => b.score - a.score);
  const out = { projects: [], people: [] };
  let size = 30, i = 0, j = 0;
  while (i < P.length || j < Q.length) {
    const takeP = i < P.length && (j >= Q.length || P[i].score >= Q[j].score || out.projects.length * 2 < out.people.length);
    const x = takeP ? P[i++] : Q[j++], n = JSON.stringify(x.row).length + 1;
    if (size + n > max) continue;
    size += n; (takeP ? out.projects : out.people).push(x.row);
  }
  return out;
}
const LONG_MAX = 40000;

// A letter as the model writes it → { letter } or { error }. One letter, `long` (2026-11-24: the short one is gone;
// one still written beside it, by a prompt from before, is left out).
function checkLetter(a){
  const long = typeof (a || {}).long === 'string' ? a.long.trim() : '';
  if (!long) return { error: 'Give long: the letter, as Markdown.' };
  if (long.length > LONG_MAX) return { error: 'long is too long: at most ' + LONG_MAX + ' characters.' };
  return { letter: { long } };
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
    since: x.since ? { at: x.since, how_long_ago: agoText(Date.parse(x.since), now) } : null,
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
    you: p.you || undefined,
    since: new Date(p.since).toISOString(),
    waiting_on_you: (p.waiting || []).map((x) => ({ kind: x.kind, title: x.title, from: (x.by && x.by.name) || '', since: x.since ? new Date(x.since).toISOString() : '', url: x.url })),
    your_week: week,
    your_projects: mine.projects || [],
    your_letters: mine.letters || mine.recommendation_letters || [],
    notifications: (p.notes || []).map((n) => ({ text: n.text, at: n.at ? new Date(n.at).toISOString() : '', read: !!n.read, url: n.href || '' })),
    conversations: (p.conversations || []).map((c) => ({ title: c.title, by: c.name || '', replies: c.replies || 0,
      last_reply: c.lastAt ? new Date(c.lastAt).toISOString() : '', started_by_you: !!c.yours, waits_for_an_answer: !(c.replies > 0),
      new_since_last_visit: (c.at || 0) > p.since || undefined, active_since_last_visit: (c.lastAt || c.at || 0) > p.since, url: c.url })),
    lab: Object.assign({ events: (p.events || []).map((e) => ({ title: e.title, start: e.start, end: e.end, place: e.place, url: e.url })) },
      p.directory ? directoryOf(p.directory.projects, p.directory.people, p.directory.max, p.you) : {}),
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

module.exports = { WRITERS, ladderOf, modelsOf, REFRESH, refreshHours, writesAt, lastDue, londonDate, letterOrder, sinceFor, agoText, directoryOf, ON_NOW, LONG_MAX, checkLetter, isFresh, londonNow, inputsOf, factsOf, meetingOf };
