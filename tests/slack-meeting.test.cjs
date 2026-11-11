// /meeting in Slack (#325): the form, reading it back, and the Calendar event.
const test = require('node:test');
const assert = require('node:assert');
const M = require('../functions/slack-meeting.js');

const NOW = Date.UTC(2026, 10, 11, 14, 10);   // Wed 11 Nov 2026, 14:10 London (GMT)
const blk = (v, id) => v.blocks.find((b) => b.block_id === id);
const values = (o) => ({
  title: { v: { value: o.title } },
  when: { v: { selected_date_time: o.when } },
  minutes: { v: { selected_option: o.minutes === undefined ? null : { value: String(o.minutes) } } },
  notes: { v: { value: o.notes || null } },
  link: { v: { value: o.link || null } },
});

test('everyone in the channel with a BOLD.OS address, once each; bots and outsiders counted, not invited', () => {
  const w = M.inviteesOf(['U1', 'U2', 'B1', 'U3', 'U4'], {
    U1: { email: 'Ana@Example.org', name: 'Ana' }, U2: { email: 'ben@example.org', name: 'Ben' }, U3: { email: 'ana@example.org', name: 'Ana again' }, U4: { email: 'nope' } });
  assert.deepStrictEqual(w, { emails: ['ana@example.org', 'ben@example.org'], names: ['Ana', 'Ben'], others: 2 });
});

test('the form names whom it invites and starts on the next whole hour', () => {
  const v = M.formView({ triggerId: 't', title: 'Reading group', channelId: 'C1', channelName: 'proj-x', names: ['Ben', 'Ana'], others: 1, now: NOW }).view;
  assert.strictEqual(v.callback_id, M.CALLBACK);
  assert.deepStrictEqual(JSON.parse(v.private_metadata), { channel: 'C1', name: 'proj-x', tz: 'Europe/London' });
  assert.strictEqual(blk(v, 'title').element.initial_value, 'Reading group');
  assert.strictEqual(blk(v, 'when').element.initial_date_time, Date.UTC(2026, 10, 11, 15) / 1000);
  assert.strictEqual(blk(v, 'minutes').element.initial_option.value, '60');
  const ctx = v.blocks[v.blocks.length - 1].elements[0].text;
  assert.match(ctx, /the 2 people in #proj-x/);
  assert.match(ctx, /Ana and Ben\./);
  assert.match(ctx, /1 member with no BOLD\.OS account/);
  // Less than 30 minutes to the next hour: the one after.
  assert.strictEqual(M.nextSlot(Date.UTC(2026, 10, 11, 14, 45)), Date.UTC(2026, 10, 11, 16) / 1000);
});

test('a long list of names is cut short', () => {
  const names = Array.from({ length: 80 }, (_, i) => 'Person number ' + String(i).padStart(2, '0'));
  const t = M.namesText(names, 200);
  assert.ok(t.length <= 200);
  assert.match(t, / and \d+ others$/);
});

test('the form read back, and what to fix', () => {
  const when = Date.UTC(2026, 10, 12, 14) / 1000;
  assert.deepStrictEqual(M.meetingOf(values({ title: ' Sync ', when, minutes: 30, notes: 'Agenda' }), NOW),
    { title: 'Sync', start: when * 1000, minutes: 30, notes: 'Agenda', link: '' });
  const bad = M.meetingOf(values({ title: '', when: Date.UTC(2026, 10, 10) / 1000, minutes: 7, link: 'http://x' }), NOW);
  assert.deepStrictEqual(Object.keys(bad.errors).sort(), ['link', 'minutes', 'title', 'when']);
  assert.match(bad.errors.when, /past/);
  assert.ok(M.meetingOf(values({ title: 'x', when: Date.UTC(2028, 0, 1) / 1000, minutes: 60 }), NOW).errors.when);
});

test('the event: a Google Meet, or the link given; guests can’t change it', () => {
  const m = { title: 'Sync', start: Date.UTC(2026, 10, 12, 14), minutes: 90, notes: 'Agenda', link: '' };
  const ev = M.eventOf(m, ['a@x.org', 'b@x.org'], 'req-1', 'Set up by Ana.');
  assert.strictEqual(ev.start.dateTime, '2026-11-12T14:00:00.000Z');
  assert.strictEqual(ev.end.dateTime, '2026-11-12T15:30:00.000Z');
  assert.deepStrictEqual(ev.attendees, [{ email: 'a@x.org' }, { email: 'b@x.org' }]);
  assert.strictEqual(ev.description, 'Agenda\n\nSet up by Ana.');
  assert.strictEqual(ev.conferenceData.createRequest.requestId, 'req-1');
  assert.strictEqual(ev.guestsCanModify, false);
  const own = M.eventOf(Object.assign({}, m, { link: 'https://zoom.us/j/1' }), [], 'r', '');
  assert.strictEqual(own.location, 'https://zoom.us/j/1');
  assert.strictEqual(own.conferenceData, undefined);
});

test('when, in London time across the clocks changing', () => {
  assert.strictEqual(M.whenText(Date.UTC(2026, 10, 12, 14), 60), 'Thu 12 Nov, 14:00–15:00 (London)');
  assert.strictEqual(M.whenText(Date.UTC(2026, 5, 4, 9), 30), 'Thu 4 Jun, 10:00–10:30 (London)');
});

test('what’s typed after /meeting fills the form in', () => {
  // NOW: Wed 11 Nov 2026, 14:10 in London.
  const p = (s, tz) => { const r = M.parseText(s, NOW, tz); return [r.title, r.start && new Date(r.start).toISOString().slice(0, 16), r.minutes]; };
  assert.deepStrictEqual(p('tomorrow at 1pm for 30min'), ['', '2026-11-12T13:00', 30]);
  assert.deepStrictEqual(p('Reading group tomorrow at 1pm for 30min'), ['Reading group', '2026-11-12T13:00', 30]);
  assert.deepStrictEqual(p('Sync on friday at 10:30 for 1h'), ['Sync', '2026-11-13T10:30', 60]);
  assert.deepStrictEqual(p('next monday 9am for 1.5 hours Planning'), ['Planning', '2026-11-23T09:00', 90]);
  assert.deepStrictEqual(p('wednesday 3pm'), ['', '2026-11-18T15:00', null]);   // today is Wednesday: next week's
  assert.deepStrictEqual(p('12 Nov at noon for an hour'), ['', '2026-11-12T12:00', 60]);
  assert.deepStrictEqual(p('Dec 3rd 16:00 for 1h30'), ['', '2026-12-03T16:00', 90]);
  assert.deepStrictEqual(p('at 2'), ['', '2026-11-12T14:00', null]);            // 14:00 has passed today
  assert.deepStrictEqual(p('at 3 for 45 mins'), ['', '2026-11-11T15:00', 45]);
  assert.deepStrictEqual(p('5/1 11am'), ['', '2027-01-05T11:00', null]);         // day/month; January is next year's
  assert.deepStrictEqual(p('tomorrow'), ['', '2026-11-12T10:00', null]);
  assert.deepStrictEqual(p('Paper chat'), ['Paper chat', null, null]);
  assert.deepStrictEqual(p('tomorrow at 1pm', 'America/New_York'), ['', '2026-11-12T18:00', null]);
  assert.deepStrictEqual(p('for 7min'), ['', null, null]);                        // not in 5s: the form's default
});

test('the form starts from what was typed', () => {
  const r = M.parseText('tomorrow at 1pm for 20min', NOW);
  const v = M.formView({ triggerId: 't', title: r.title, start: r.start, minutes: r.minutes, channelId: 'C1', channelName: 'x', names: ['Ana'], others: 0, now: NOW }).view;
  assert.strictEqual(blk(v, 'title').element.initial_value, undefined);
  assert.strictEqual(blk(v, 'when').element.initial_date_time, Date.UTC(2026, 10, 12, 13) / 1000);
  assert.strictEqual(blk(v, 'minutes').element.initial_option.value, '20');
  assert.ok(blk(v, 'minutes').element.options.some((o) => o.value === '20'));
});

test('Suggest a time: the button, what it found, and picking one', () => {
  const view = M.viewOf(Object.assign({ id: 'V1', hash: 'h', state: {} }, M.formView({ triggerId: 't', title: 'Sync', channelId: 'C1', channelName: 'x', names: ['Ana', 'Ben'], others: 0, now: NOW, tz: 'Europe/London' }).view));
  assert.strictEqual(view.id, undefined);
  assert.strictEqual(blk(view, 'sg_go').elements[0].action_id, M.SUGGEST);
  const ids = (v) => v.blocks.map((b) => b.block_id);
  const waiting = M.withSuggestions(view, { status: 'Looking…' });
  assert.deepStrictEqual(ids(waiting).slice(1, 5), ['minutes', 'when', 'sg_go', 'sg_note']);
  const a = Date.UTC(2026, 10, 12, 14), b = Date.UTC(2026, 10, 13, 10);
  const found = M.withSuggestions(waiting, { slots: [{ start: a, free: 2, of: 2, busy: [] }, { start: b, free: 1, of: 2, busy: ['Ben'] }], tz: 'Europe/London', fromCalendar: ['Ana'], none: ['Ben'], failed: [] });
  assert.strictEqual(ids(found).filter((x) => x === 'sg_note').length, 1);
  assert.match(blk(found, 'sg_note').elements[0].text, /No time suits everyone.*From the calendars of Ana.*Ben hasn’t added/);
  assert.deepStrictEqual(blk(found, 'sg_list').elements.map((e) => e.text.text), ['Thu 12 Nov, 14:00', 'Fri 13 Nov, 10:00 (1 of 2)']);
  // In New York, the same times.
  assert.strictEqual(M.slotText(a, 'America/New_York'), 'Thu 12 Nov, 09:00');
  // Picking one: When takes it, under a new block id; the form still reads it.
  const picked = M.withWhen(found, a);
  assert.strictEqual(blk(picked, 'when-' + a).element.initial_date_time, a / 1000);
  assert.ok(!blk(picked, 'when'));
  const vals = { title: { v: { value: 'Sync' } }, minutes: { v: { selected_option: { value: '30' } } }, ['when-' + a]: { v: { selected_date_time: a / 1000 } } };
  assert.strictEqual(M.meetingOf(vals, NOW).start, a);
  assert.strictEqual(M.minutesOf(vals), 30);
  assert.strictEqual(M.minutesOf({}), 60);
});
