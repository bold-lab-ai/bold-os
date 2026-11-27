// The Calendar's week where its reader is (pages/calendar.js weekHtml, 2026-11-27): meetings are kept in London
// time and drawn on the day and at the time of the reader's Slack timezone (functions/local-time.js).
// Run: npm test
process.env.TZ = 'UTC';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const L = require('../functions/local-time.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '../src/assets/js', f), 'utf8');
const page = read('pages/calendar.js');
const slice = (from, to) => page.slice(page.indexOf(from), page.indexOf(to));
// The reader's-time helpers and the week itself, as the page has them.
const code = read('project-fields.js') + '\n' + slice('  var LT = window.BoldLocalTime;', '  function render(){') + '\n' + slice('  var HOUR = 48', '  function press(sel, attr, value){');

// Wednesday 2 Dec 2026: the week shown is Mon 30 Nov – Sun 6 Dec.
const NOW = Date.parse('2026-12-02T12:00:00Z');
class FixedDate extends Date {
  constructor(...a){ if (a.length) super(...a); else super(NOW); }
  static now(){ return NOW; }
}

function week(tz, meetings, evs){
  const ctx = {
    Date: FixedDate, window: { BoldLocalTime: L }, BoldLocalTime: L, BOLD: { timeZone: () => tz, escapeHtml: (s) => String(s) },
    esc: (s) => String(s), E: { when: () => '' }, pop: null, weekOffset: 0, kind: 'all', geom: null,
    KIND_LABELS: { event: 'Event', project: 'Project', study: 'Supervision', series: 'Recurring' },
    keyOf: (m) => m.kind + ':' + m.id, greyed: (m) => m.paused || m.hidden, groupBadge: () => '', ownBadge: () => '',
    timed: (x) => /^\d\d:\d\d$/.test(x.startTime || '') && (!x.endDate || x.endDate === x.startDate), evMinutes: (x) => +x.durationMinutes || 60,
    eventUrl: (x) => 'event.html?event=' + x.slug,
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const html = ctx.weekHtml(meetings, evs || []);
  // Each day's blocks: [{ day: 'Mon 30', time, title }].
  const heads = [...html.matchAll(/<span(?: class="is-today")?>((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d+)<\/span>/g)].map((x) => x[1]);
  const days = html.split('<div class="week-day">').slice(1);
  const blocks = [];
  days.forEach((d, i) => [...d.matchAll(/data-orig="([^"]*)"[^>]*>\s*<span class="week-time">([^<]*)<\/span> ([^<]*)/g)].forEach((b) => blocks.push({ day: heads[i], orig: b[1], time: b[2], title: b[3].trim() })));
  return { html, heads, blocks, ctx };
}
const meeting = (id, day, time, extra) => Object.assign({ kind: 'project', id, title: id, href: '', meeting: { day, time, minutes: 60, every: 1 }, start: '2026-01-05', moved: {}, people: 2 }, extra);

test('in London the week is as it was: each meeting on its day at its time, and no note', () => {
  const w = week('Europe/London', [meeting('a', 'MO', '14:00'), meeting('b', 'TH', '09:30')]);
  assert.deepStrictEqual(w.blocks, [{ day: 'Mon 30', orig: '2026-11-30', time: '14:00', title: 'a' }, { day: 'Thu 3', orig: '2026-12-03', time: '09:30', title: 'b' }]);
  assert.ok(!/your time/.test(w.html));
  assert.deepStrictEqual(w.heads, ['Mon 30', 'Tue 1', 'Wed 2', 'Thu 3', 'Fri 4']);
});

test('elsewhere, each meeting is drawn at its time there; its key stays its London date', () => {
  const w = week('America/New_York', [meeting('a', 'MO', '14:00')]);
  assert.deepStrictEqual(w.blocks, [{ day: 'Mon 30', orig: '2026-11-30', time: '09:00', title: 'a' }]);
  assert.match(w.html, /The week is in your time \(America\/New York, from Slack\)/);
  assert.match(w.html, /Mondays, 09:00–10:00 your time \(14:00 London\)/);
});

test('a late London meeting falls on the next day further east', () => {
  const w = week('Asia/Tokyo', [meeting('late', 'MO', '23:30'), meeting('sun', 'SU', '20:00')]);
  // Monday's is Tuesday 08:30 there; the Sunday before this week's is this Monday 05:00, and this Sunday's is next week's.
  assert.deepStrictEqual(w.blocks, [{ day: 'Mon 30', orig: '2026-11-29', time: '05:00', title: 'sun' }, { day: 'Tue 1', orig: '2026-11-30', time: '08:30', title: 'late' }]);
});

test('an early London meeting falls on the day before further west, a weekend day shown for it', () => {
  const w = week('America/New_York', [meeting('early', 'MO', '01:00')]);
  // This Monday's was last Sunday there; next Monday's (7 Dec) is this Sunday 20:00.
  assert.deepStrictEqual(w.blocks, [{ day: 'Sun 6', orig: '2026-12-07', time: '20:00', title: 'early' }]);
  assert.deepStrictEqual(w.heads, ['Mon 30', 'Tue 1', 'Wed 2', 'Thu 3', 'Fri 4', 'Sun 6']);
});

test('a moved occurrence and a timed event are drawn where the reader is too', () => {
  const moved = meeting('m', 'MO', '14:00', { moved: { '2026-11-30': { date: '2026-12-01', time: '23:00', minutes: 60 } } });
  const w = week('Asia/Tokyo', [moved], [{ slug: 'gm', title: 'Group meeting', startDate: '2026-12-02', startTime: '11:00', durationMinutes: 60 }]);
  assert.deepStrictEqual(w.blocks, [{ day: 'Wed 2', orig: '2026-11-30', time: '08:00', title: 'm' }, { day: 'Wed 2', orig: '2026-12-02', time: '20:00', title: 'Group meeting' }]);
});

test('a drop where the reader is goes back to London’s day and time', () => {
  const { ctx } = week('Asia/Tokyo', []);
  assert.deepStrictEqual({ ...ctx.london('2026-12-01', '08:30') }, { date: '2026-11-30', time: '23:30' });
  assert.deepStrictEqual({ ...ctx.here('2026-11-30', '23:30') }, { date: '2026-12-01', time: '08:30' });
  const home = week('Europe/London', []).ctx;
  assert.deepStrictEqual({ ...home.london('2026-12-01', '08:30') }, { date: '2026-12-01', time: '08:30' });
});

test('a card’s occurrence says whose time it is', () => {
  assert.strictEqual(week('America/New_York', []).ctx.occText('2026-11-30', '14:00', 60), 'Mon 30 Nov, 09:00–10:00 your time (14:00 London)');
  assert.strictEqual(week('Asia/Tokyo', []).ctx.occText('2026-11-30', '23:30', 60), 'Tue 1 Dec, 08:30–09:30 your time (Mon 30 Nov, 23:30 London)');
  assert.strictEqual(week('Europe/London', []).ctx.occText('2026-11-30', '14:00', 60), 'Mon 30 Nov, 14:00–15:00');
});
