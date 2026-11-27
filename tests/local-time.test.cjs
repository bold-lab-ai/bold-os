// Each person's timezone is their Slack profile's (functions/local-time.js; people/{slackId}.tz, 2026-11-27):
// a London meeting's time where they are, and the reminders that reach each person at 09:00 their own time.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const L = require('../functions/local-time.js');
const { slackTz, atLocalHour, letterRemindersNow, venueCallRecipients } = require('../functions/index.js')._internal;

const at = (iso) => Date.parse(iso);
const NY = 'America/New_York', TOKYO = 'Asia/Tokyo';

test('a timezone this runtime doesn’t know, or none, is London', () => {
  assert.strictEqual(L.zone(NY), NY);
  assert.strictEqual(L.zone('Nowhere/Else'), L.LONDON);
  assert.strictEqual(L.zone(''), L.LONDON);
  assert.strictEqual(L.zone(undefined), L.LONDON);
});

test('the clock somewhere, and the instant a clock shows a time, across a change of clocks', () => {
  assert.deepStrictEqual(L.at('Pacific/Auckland', at('2026-11-27T12:00:00Z')), { date: '2026-11-28', day: 'SA', hour: 1, minute: 0, time: '01:00' });
  assert.strictEqual(L.instant('2026-01-15', '09:00', L.LONDON), at('2026-01-15T09:00:00Z'));
  assert.strictEqual(L.instant('2026-07-01', '09:00', L.LONDON), at('2026-07-01T08:00:00Z'));
  assert.strictEqual(L.instant('2026-07-01', '09:00', NY), at('2026-07-01T13:00:00Z'));
  // The day the UK's clocks go back: 09:00 is already winter time.
  assert.strictEqual(L.instant('2026-10-25', '09:00', L.LONDON), at('2026-10-25T09:00:00Z'));
});

test('a London meeting where its reader is: the time, and the day when it’s another', () => {
  const now = at('2026-11-27T12:00:00Z');
  const m = { day: 'MO', time: '14:00', minutes: 60 };
  assert.deepStrictEqual(L.meetingIn(m, NY, now), { day: 'MO', time: '09:00', end: '10:00', differs: true });
  assert.deepStrictEqual(L.meetingIn({ day: 'MO', time: '23:30', minutes: 60 }, TOKYO, now), { day: 'TU', time: '08:30', end: '09:30', differs: true });
  assert.deepStrictEqual(L.meetingIn({ day: 'MO', time: '01:00', minutes: 30 }, NY, now), { day: 'SU', time: '20:00', end: '20:30', differs: true });
});

test('where the clock reads as London’s, or the timezone isn’t known, it’s London’s time', () => {
  const now = at('2026-11-27T12:00:00Z'), m = { day: 'MO', time: '14:00', minutes: 90 };
  const london = { day: 'MO', time: '14:00', end: '15:30', differs: false };
  assert.deepStrictEqual(L.meetingIn(m, L.LONDON, now), london);
  assert.deepStrictEqual(L.meetingIn(m, 'Europe/Lisbon', now), london);
  assert.deepStrictEqual(L.meetingIn(m, 'Nowhere/Else', now), london);
  assert.deepStrictEqual(L.meetingIn(m, '', now), london);
  assert.strictEqual(L.meetingIn({ day: 'MO', time: '', minutes: 60 }, NY, now).differs, false);
});

test('the two places’ clocks don’t change together: the time is its next date’s', () => {
  const m = { day: 'MO', time: '14:00', minutes: 60 };
  // The UK goes back on 25 Oct 2026, the US on 1 Nov: on Monday 26 Oct New York is 4 hours behind, not 5.
  assert.strictEqual(L.meetingIn(m, NY, at('2026-10-25T12:00:00Z')).time, '10:00');
  assert.strictEqual(L.meetingIn(m, NY, at('2026-11-01T12:00:00Z')).time, '09:00');
});

test('one London date and time where its reader is', () => {
  assert.deepStrictEqual(L.fromLondon('2026-11-30', '14:00', TOKYO), { date: '2026-11-30', day: 'MO', hour: 23, minute: 0, time: '23:00' });
  assert.strictEqual(L.fromLondon('2026-11-30', '20:00', TOKYO).date, '2026-12-01');
});

test('09:00 comes once a day in each timezone, a half-hour one included', () => {
  for (const tz of [L.LONDON, NY, TOKYO, 'Asia/Kolkata', 'Pacific/Auckland', 'Asia/Kathmandu']) {
    let n = 0;
    for (let h = 0; h < 24; h++) if (L.isHour(tz, 9, at('2026-11-27T00:00:05Z') + h * 3600000)) n++;
    assert.strictEqual(n, 1, tz);
  }
  // On the days the clocks change too.
  for (const day of ['2026-03-29', '2026-10-25']) {
    let n = 0;
    for (let h = 0; h < 24; h++) if (L.isHour(L.LONDON, 9, L.instant(day, '00:00', L.LONDON) + h * 3600000)) n++;
    assert.strictEqual(n, 1, day);
  }
  assert.strictEqual(L.isHour(NY, 9, at('2026-11-27T14:00:05Z')), true);
  assert.strictEqual(L.isHour(NY, 9, at('2026-11-27T14:00:05Z'), 'FR'), true);
  assert.strictEqual(L.isHour(NY, 9, at('2026-11-27T14:00:05Z'), 'MO'), false);
});

test('Slack’s timezone is kept only if it’s one this runtime knows', () => {
  assert.strictEqual(slackTz({ tz: NY }), NY);
  assert.strictEqual(slackTz({ tz: 'Nowhere/Else' }), '');
  assert.strictEqual(slackTz({}), '');
  assert.strictEqual(slackTz(null), '');
});

test('a reminder goes to whoever it’s 09:00 for where they are; London without a timezone', () => {
  const zones = { 'ny@x.org': NY, 'tokyo@x.org': TOKYO };
  const all = ['NY@x.org', 'tokyo@x.org', 'london@x.org', 'london@x.org', ''];
  assert.deepStrictEqual(atLocalHour(all, zones, 9, at('2026-11-27T09:00:10Z')), ['london@x.org']);
  assert.deepStrictEqual(atLocalHour(all, zones, 9, at('2026-11-27T14:00:10Z')), ['ny@x.org']);
  assert.deepStrictEqual(atLocalHour(all, zones, 9, at('2026-11-27T00:00:10Z')), ['tokyo@x.org']);
  assert.deepStrictEqual(atLocalHour(all, zones, 9, at('2026-11-27T11:00:10Z')), []);
  // A weekly one: Monday 09:00 in Tokyo is still Sunday in London and New York.
  assert.deepStrictEqual(atLocalHour(all, zones, 9, at('2026-11-30T00:00:10Z'), 'MO'), ['tokyo@x.org']);
  assert.deepStrictEqual(atLocalHour(all, zones, 9, at('2026-11-29T09:00:10Z'), 'MO'), []);
  // Over a day, everyone once.
  const got = [];
  for (let h = 0; h < 24; h++) got.push(...atLocalHour(all, zones, 9, at('2026-11-27T00:00:10Z') + h * 3600000));
  assert.deepStrictEqual(got.sort(), ['london@x.org', 'ny@x.org', 'tokyo@x.org']);
});

test('a letter’s reminder at its writer’s 09:00, the days left counted from their own date', () => {
  const requests = [
    { id: 'a', writerEmail: 'Tokyo@x.org', recipients: [{ id: 'r', deadline: '2026-12-04' }] },
    { id: 'b', writerEmail: 'london@x.org', recipients: [{ id: 'r', deadline: '2026-12-04' }] },
  ];
  const zones = { 'tokyo@x.org': TOKYO };
  // 27 Nov 09:00 in Tokyo (still 00:00 in London): 7 days left there.
  assert.deepStrictEqual(letterRemindersNow(requests, zones, at('2026-11-27T00:00:10Z')), [{ id: 'a', recipientId: 'r', days: 7, left: 7 }]);
  assert.deepStrictEqual(letterRemindersNow(requests, zones, at('2026-11-27T09:00:10Z')), [{ id: 'b', recipientId: 'r', days: 7, left: 7 }]);
  assert.deepStrictEqual(letterRemindersNow(requests, zones, at('2026-11-27T05:00:10Z')), []);
  // One already sent isn't due again.
  const sent = [{ id: 'b', writerEmail: 'london@x.org', recipients: [{ id: 'r', deadline: '2026-12-04', reminded: [7] }] }];
  assert.deepStrictEqual(letterRemindersNow(sent, zones, at('2026-11-27T09:00:10Z')), []);
});

test('a call for papers found is passed on for a week, to whoever hasn’t had it', () => {
  const now = at('2026-11-30T09:00:00Z'), call = { text: 'ICLR 2027 is on OpenReview.', notified: ['A@x.org'], foundAt: now - 3600000 };
  assert.deepStrictEqual(venueCallRecipients(call, ['a@x.org', 'b@x.org'], now), ['b@x.org']);
  assert.deepStrictEqual(venueCallRecipients(Object.assign({}, call, { foundAt: now - 9 * 86400000 }), ['b@x.org'], now), []);
  // One from before went to everyone at once: no text, nobody more.
  assert.deepStrictEqual(venueCallRecipients({ notified: ['a@x.org'] }, ['b@x.org'], now), []);
  assert.deepStrictEqual(venueCallRecipients(undefined, ['b@x.org'], now), []);
});

// The pages' wording (project-fields.js), loaded as the page loads it.
function fields(tz){
  const ctx = { BoldLocalTime: L, BOLD: tz === undefined ? {} : { timeZone: () => tz }, Date: class extends Date {
    static now(){ return at('2026-11-27T12:00:00Z'); }
  } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/assets/js/project-fields.js'), 'utf8'), ctx);
  return ctx;
}

test('a meeting’s text where its reader is, with London’s time beside it', () => {
  const m = { day: 'MO', time: '14:00', minutes: 60, every: 2, until: '2026-12-18' };
  assert.strictEqual(fields(NY).meetingTextLocal(m), 'Mondays, 09:00–10:00 your time (14:00 London), every 2 weeks, until 18 Dec 2026');
  assert.strictEqual(fields(TOKYO).meetingTextLocal({ day: 'MO', time: '23:30', minutes: 60, every: 1 }), 'Tuesdays, 08:30–09:30 your time (Mondays 23:30 London)');
});

test('in London, or before the timezone is known, it’s the text as entered', () => {
  const m = { day: 'MO', time: '14:00', minutes: 60, every: 1 };
  assert.strictEqual(fields(L.LONDON).meetingTextLocal(m), 'Mondays, 14:00–15:00');
  assert.strictEqual(fields(L.LONDON).meetingTextLocal(m, ' · London time'), 'Mondays, 14:00–15:00 · London time');
  assert.strictEqual(fields(undefined).meetingTextLocal(m), 'Mondays, 14:00–15:00');
  // What a form asks to confirm stays London's.
  assert.strictEqual(fields(NY).meetingText(m), 'Mondays, 14:00–15:00');
  assert.strictEqual(fields(NY).meetingTextLocal(m, ' · London time'), 'Mondays, 09:00–10:00 your time (14:00 London)');
});
