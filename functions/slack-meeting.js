// /meeting in Slack (#325, 2026-11-11): a one-off meeting with everyone in the channel, invited from the
// lab's Google account. Pure: the form, reading it back, and the Calendar event. The I/O is in index.js
// (handleMeetingCommand, handleMeetingSubmit, onOneOffMeeting).
'use strict';

const TZ = 'Europe/London';
const LENGTHS = [15, 30, 45, 60, 90, 120, 180];
const MAX_GUESTS = 100;
const CALLBACK = 'one_off_meeting';
const SUGGEST = 'meeting_suggest', PICK = 'meeting_pick';
const { wallToMs } = require('./busy');
const okMinutes = (m) => m >= 5 && m <= 480 && m % 5 === 0;

// Pure: a channel's members' Slack ids and the roster (people/{slackId} → { email, name }) →
// { emails, names, others } of whom to invite (lowercase, once each); `others` counts the members with
// no BOLD.OS address (bots, apps, people from outside BOLD), who aren't invited.
function inviteesOf(ids, people){
  const emails = [], names = [];
  let others = 0;
  (ids || []).forEach(function(id){
    const p = people && people[id];
    const e = String((p && p.email) || '').trim().toLowerCase();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e)) { others++; return; }
    if (emails.indexOf(e) >= 0) return;
    emails.push(e); names.push(String(p.name || e.split('@')[0]));
  });
  return { emails, names, others };
}

// Pure: the next whole hour from `now` (ms), at least 30 minutes away, as Unix seconds.
function nextSlot(now){
  const h = 3600000;
  let t = Math.ceil(now / h) * h;
  if (t - now < 30 * 60000) t += h;
  return Math.floor(t / 1000);
}

// Pure: names as a sentence, cut short past `max` characters ("Ana, Ben and 12 others").
function namesText(names, max){
  const all = names.slice().sort(function(a, b){ return a.localeCompare(b); });
  const join = function(xs, rest){
    if (rest) return xs.join(', ') + ' and ' + rest + (rest === 1 ? ' other' : ' others');
    return xs.length > 1 ? xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1] : (xs[0] || '');
  };
  for (let n = all.length; n > 0; n--) {
    const s = join(all.slice(0, n), all.length - n);
    if (s.length <= (max || 2000)) return s;
  }
  return all.length + ' people';
}

// ---------- what's typed after /meeting: "Reading group tomorrow at 1pm for 30min" ----------
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
// Pure: the calendar date (y, m0, d) it is at `now` in `tz`.
function dateIn(now, tz){
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(now)).forEach((x) => { p[x.type] = Number(x.value); });
  return { y: p.year, m: p.month - 1, d: p.day, h: p.hour, mi: p.minute };
}
const addDays = (o, n) => { const t = new Date(Date.UTC(o.y, o.m, o.d + n)); return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() }; };
// Pure: the text → { title, start (ms) or null, minutes or null }, its times in `tz` (the person's own,
// from Slack; London if unknown). Understands today, tomorrow, a weekday ("monday", "next mon"), a date
// ("12 Nov", "Nov 12th", "12/11", "2026-11-12"), a time ("1pm", "1:30 pm", "13:00", "noon", "at 9") and a
// length ("for 30min", "for 1h", "for 1.5 hours", "for an hour", "for 1h30"). What's left is the title.
function parseText(text, now, tz){
  tz = tz || TZ;
  let t = ' ' + String(text || '').replace(/\s+/g, ' ').trim() + ' ';
  const take = (re) => { const m = t.match(re); if (m) t = t.replace(m[0], ' '); return m; };
  const today = dateIn(now, tz);
  let minutes = null, date = null, hm = null;
  // The length.
  let m = take(/ for (an?|one|\d+(?:\.\d+)?) ?(h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?)(?: ?(\d+) ?m(?:in(?:ute)?s?)?|(\d{2}))? /i);
  if (m) {
    const n = /^(an?|one)$/i.test(m[1]) ? 1 : Number(m[1]);
    minutes = Math.round(/^h/i.test(m[2]) ? n * 60 + Number(m[3] || m[4] || 0) : n);
  } else if ((m = take(/ for (\d{1,2}):(\d{2}) /i))) minutes = Number(m[1]) * 60 + Number(m[2]);
  // The time.
  if ((m = take(/ (?:at )?(noon|midday) /i))) hm = [12, 0];
  else if ((m = take(/ (?:at )?(\d{1,2})(?:[:.](\d{2}))? ?(am|pm) /i))) hm = [Number(m[1]) % 12 + (/pm/i.test(m[3]) ? 12 : 0), Number(m[2] || 0)];
  else if ((m = take(/ (?:at )?([01]?\d|2[0-3])[:.]([0-5]\d) /i))) hm = [Number(m[1]), Number(m[2])];
  else if ((m = take(/ at (\d{1,2}) /i))) { const h = Number(m[1]); hm = [h >= 1 && h <= 7 ? h + 12 : h, 0]; }   // "at 3": the afternoon
  if (hm && (hm[0] > 23 || hm[1] > 59)) hm = null;
  // The day.
  if ((m = take(/ (?:on )?today /i))) date = today;
  else if ((m = take(/ (?:on )?tomorrow /i))) date = addDays(today, 1);
  else if ((m = take(/ (?:on )?(\d{4})-(\d{2})-(\d{2}) /))) date = { y: +m[1], m: +m[2] - 1, d: +m[3] };
  else if ((m = take(new RegExp(' (?:on )?(?:(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*,? )?(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ' + MON + ' ', 'i'))) ||
           (m = take(new RegExp(' (?:on )?(?:(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*,? )?' + MON + ' (\\d{1,2})(?:st|nd|rd|th)? ', 'i')))) {
    const num = /^\d/.test(m[1]) ? m[1] : m[2], mon = /^\d/.test(m[1]) ? m[2] : m[1];
    date = { y: today.y, m: MONTHS.indexOf(mon.slice(0, 3).toLowerCase()), d: Number(num) };
    if (Date.UTC(date.y, date.m, date.d) < Date.UTC(today.y, today.m, today.d)) date.y++;
  } else if ((m = take(/ (?:on )?(\d{1,2})\/(\d{1,2}) /))) {   // day/month, as in the UK
    date = { y: today.y, m: Number(m[2]) - 1, d: Number(m[1]) };
    if (Date.UTC(date.y, date.m, date.d) < Date.UTC(today.y, today.m, today.d)) date.y++;
  } else if ((m = take(/ (?:on )?(next |this )?(sun|mon|tue|wed|thu|fri|sat)[a-z]* /i))) {
    const want = DAYS.findIndex((x) => x.startsWith(m[2].toLowerCase()));
    const dow = new Date(Date.UTC(today.y, today.m, today.d)).getUTCDay();
    let add = (want - dow + 7) % 7;
    if (add === 0) add = 7;
    if (/next/i.test(m[1] || '') && add < 7) add += 7;
    date = addDays(today, add);
  }
  if (date && (date.m < 0 || date.d < 1 || date.d > 31)) date = null;
  // A time with no day: today if it's still to come, else tomorrow; a day with no time: 10:00.
  let start = null;
  if (date || hm) {
    const h = hm || [10, 0];
    let d = date || today;
    start = wallToMs(d.y, d.m, d.d, h[0], h[1], 0, tz);
    if (!date && start <= now) { d = addDays(today, 1); start = wallToMs(d.y, d.m, d.d, h[0], h[1], 0, tz); }
  }
  const title = t.replace(/\s+/g, ' ').trim().replace(/^[-–:,]\s*|\s*[-–:,]$/g, '');
  return { title, start, minutes: minutes && okMinutes(minutes) ? minutes : null };
}

// Pure: the form. in: { triggerId, title, channelId, channelName, names, others, now }.
function formView(o){
  const typed = okMinutes(Number(o.minutes)) ? Number(o.minutes) : 60;
  const lengths = LENGTHS.concat(LENGTHS.indexOf(typed) < 0 ? [typed] : []).sort(function(a, b){ return a - b; }).map(function(m){
    const text = m < 60 ? m + ' minutes' : m === 60 ? '1 hour' : m % 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : (m / 60) + ' hours';
    return { text: { type: 'plain_text', text }, value: String(m) };
  });
  const who = 'Invites the ' + (o.names.length === 1 ? 'one person' : o.names.length + ' people') + ' in #' + o.channelName +
    ' from the lab’s Google account, with a Google Meet unless you give a link: ' + namesText(o.names, 2200) + '.' +
    (o.others ? ' ' + o.others + (o.others === 1 ? ' member with no BOLD.OS account (a bot, or someone from outside BOLD) isn’t' : ' members with no BOLD.OS account (bots, or people from outside BOLD) aren’t') + ' invited.' : '');
  return { trigger_id: o.triggerId, view: {
    type: 'modal', callback_id: CALLBACK, title: { type: 'plain_text', text: 'Set up a meeting' },
    submit: { type: 'plain_text', text: 'Send the invites' }, close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: JSON.stringify({ channel: o.channelId, name: o.channelName, tz: o.tz || TZ }),
    blocks: [
      { type: 'input', block_id: 'title', label: { type: 'plain_text', text: 'Title' },
        element: Object.assign({ type: 'plain_text_input', action_id: 'v', max_length: 200 }, o.title ? { initial_value: String(o.title).slice(0, 200) } : {}) },
      { type: 'input', block_id: 'minutes', label: { type: 'plain_text', text: 'How long' },
        element: { type: 'static_select', action_id: 'v', options: lengths, initial_option: lengths.find(function(x){ return x.value === String(typed); }) } },
      { type: 'input', block_id: 'when', label: { type: 'plain_text', text: 'When' },
        element: { type: 'datetimepicker', action_id: 'v', initial_date_time: o.start > o.now ? Math.floor(o.start / 1000) : nextSlot(o.now) } },
      { type: 'actions', block_id: 'sg_go', elements: [{ type: 'button', action_id: SUGGEST, text: { type: 'plain_text', text: 'Suggest a time' }, value: 'go' }] },
      { type: 'input', block_id: 'notes', optional: true, label: { type: 'plain_text', text: 'Description' },
        element: { type: 'plain_text_input', action_id: 'v', multiline: true, max_length: 3000, placeholder: { type: 'plain_text', text: 'What it’s about, an agenda' } } },
      { type: 'input', block_id: 'link', optional: true, label: { type: 'plain_text', text: 'Meeting link' },
        element: { type: 'plain_text_input', action_id: 'v', max_length: 500, placeholder: { type: 'plain_text', text: 'https://… (empty: a new Google Meet)' } } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: who.replace(/[&<>]/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }) }] },
    ] } };
}

// Pure: the submitted form (view.state.values) → { title, start (ms), minutes, notes, link } or
// { errors: { <block>: message } } (Slack shows them on the form).
function meetingOf(values, now){
  const v = values || {}, el = function(b){ return (v[b] && v[b].v) || {}; };
  const title = String(el('title').value || '').trim().slice(0, 200);
  // When: its block is 'when', or 'when-<ms>' once a suggestion was picked (a new block takes the new time).
  const whenKey = Object.keys(v).filter(function(k){ return /^when(-\d+)?$/.test(k); }).pop() || 'when';
  const start = Number(el(whenKey).selected_date_time) * 1000;
  const minutes = Number((el('minutes').selected_option || {}).value);
  const notes = String(el('notes').value || '').trim().slice(0, 3000);
  const link = String(el('link').value || '').trim();
  const errors = {};
  if (!title) errors.title = 'Give it a title.';
  if (!(start > 0)) errors[whenKey] = 'Choose when.';
  else if (start < now - 5 * 60000) errors[whenKey] = 'That’s in the past.';
  else if (start > now + 366 * 86400000) errors[whenKey] = 'Choose a time within a year.';
  if (!okMinutes(minutes)) errors.minutes = 'Choose how long.';
  if (link && !(link.length <= 500 && /^https:\/\/[^\s"<>]+$/.test(link))) errors.link = 'Give a link starting with https://';
  if (Object.keys(errors).length) return { errors };
  return { title, start, minutes, notes, link };
}

// ---------- Suggest a time (the form's button) ----------
// Pure: the view Slack sends back (payload.view) → one views.update takes.
function viewOf(v){
  return { type: 'modal', callback_id: v.callback_id, title: v.title, submit: v.submit, close: v.close, private_metadata: v.private_metadata,
    blocks: (v.blocks || []).map(function(b){ return JSON.parse(JSON.stringify(b)); }) };
}
// Pure: "Thu 12 Nov, 14:00" in `tz`.
function slotText(start, tz){
  const f = function(o){ return new Intl.DateTimeFormat('en-GB', Object.assign({ timeZone: tz || TZ }, o)).format(new Date(start)); };
  return f({ weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '') + ', ' + f({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}
const mrk = function(t){ return String(t).replace(/[&<>]/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); };
// Pure: the view with what Suggest a time found under its button, in place of what was there:
// { status } (a line, while it looks), or { slots: suggestOnce's, tz, fromCalendar: [names], none: [names], failed: [names] }.
function withSuggestions(view, o){
  const blocks = view.blocks.filter(function(b){ return !/^sg_(list|note)/.test(b.block_id || ''); });
  const at = blocks.findIndex(function(b){ return b.block_id === 'sg_go'; });
  const add = [];
  if (o.status) add.push({ type: 'context', block_id: 'sg_note', elements: [{ type: 'mrkdwn', text: mrk(o.status) }] });
  else {
    const slots = o.slots || [], all = slots.length && slots.every(function(x){ return x.free === x.of; });
    const whose = (o.fromCalendar || []).length
      ? 'From the calendars of ' + namesText(o.fromCalendar, 600) + ', and everyone’s BOLD.OS meetings.'
      : 'From everyone’s BOLD.OS meetings: nobody here has added a free/busy calendar.';
    const none = (o.fromCalendar || []).length && (o.none || []).length
      ? ' ' + namesText(o.none, 600) + ((o.none.length === 1) ? ' hasn’t' : ' haven’t') + ' added a free/busy calendar (on their BOLD.OS profile).' : '';
    const failed = (o.failed || []).length ? ' Couldn’t read a calendar of ' + namesText(o.failed, 300) + '.' : '';
    const head = !slots.length ? 'No time found in the next two weeks.' : all ? 'Everyone’s free at these times (weekdays, 09:00–18:00 London, the next two weeks).'
      : 'No time suits everyone: these suit the most people (weekdays, 09:00–18:00 London, the next two weeks).';
    add.push({ type: 'context', block_id: 'sg_note', elements: [{ type: 'mrkdwn', text: mrk((head + ' ' + whose + none + failed).slice(0, 2900)) }] });
    if (slots.length) add.push({ type: 'actions', block_id: 'sg_list', elements: slots.slice(0, 5).map(function(x){
      return { type: 'button', action_id: PICK + '_' + x.start, value: String(x.start),
        text: { type: 'plain_text', text: (slotText(x.start, o.tz) + (x.free < x.of ? ' (' + x.free + ' of ' + x.of + ')' : '')).slice(0, 75) } };
    }) });
  }
  blocks.splice(at + 1, 0, ...add);
  return Object.assign({}, view, { blocks });
}
// Pure: the view with When set to `start` (ms): a new block id, so Slack takes the new time rather than keeping what was there.
function withWhen(view, start){
  return Object.assign({}, view, { blocks: view.blocks.map(function(b){
    if (!/^when(-\d+)?$/.test(b.block_id || '')) return b;
    return Object.assign({}, b, { block_id: 'when-' + start, element: Object.assign({}, b.element, { initial_date_time: Math.floor(start / 1000) }) });
  }) });
}
// Pure: the length chosen on the form (view.state.values), or 60.
function minutesOf(values){
  const m = Number((((values || {}).minutes || {}).v || {}).selected_option && values.minutes.v.selected_option.value);
  return okMinutes(m) ? m : 60;
}

// Pure: the meeting and its guests → the Calendar event (POST …/events?conferenceDataVersion=1&sendUpdates=all).
function eventOf(m, emails, requestId, footer){
  const ev = {
    summary: m.title,
    description: [m.notes, footer].filter(Boolean).join('\n\n'),
    start: { dateTime: new Date(m.start).toISOString(), timeZone: TZ },
    end: { dateTime: new Date(m.start + m.minutes * 60000).toISOString(), timeZone: TZ },
    attendees: emails.map(function(e){ return { email: e }; }),
    guestsCanModify: false,
  };
  if (m.link) ev.location = m.link;
  else ev.conferenceData = { createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  return ev;
}

// Pure: "Thu 12 Nov, 14:00–15:00 (London)".
function whenText(start, minutes){
  const f = function(t, o){ return new Intl.DateTimeFormat('en-GB', Object.assign({ timeZone: TZ }, o)).format(new Date(t)); };
  const hm = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  return f(start, { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '') + ', ' +
    f(start, hm) + '–' + f(start + minutes * 60000, hm) + ' (London)';
}

module.exports = { TZ, LENGTHS, SUGGEST, PICK, viewOf, slotText, withSuggestions, withWhen, minutesOf, parseText, MAX_GUESTS, CALLBACK, inviteesOf, nextSlot, namesText, formView, meetingOf, eventOf, whenText };
