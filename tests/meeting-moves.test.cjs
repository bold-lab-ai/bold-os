// One date of a recurring meeting moved: functions/meeting-moves.js, and what reads it.
const test = require('node:test');
const assert = require('node:assert');
const M = require('../functions/meeting-moves.js');
const B = require('../functions/busy.js');
const { buildCalendar } = require('../functions/calendar-ics.js');

const tue = { day: 'TU', time: '14:00', minutes: 60, every: 2 };   // every other Tuesday from 3 Nov
const START = '2026-11-03', TODAY = '2026-11-11';

test('its own dates, and what can be moved', () => {
  assert.ok(M.isOccurrence(tue, START, '2026-11-17'));
  assert.ok(!M.isOccurrence(tue, START, '2026-11-10'));    // not its week
  assert.ok(!M.isOccurrence(tue, START, '2026-11-18'));    // not a Tuesday
  assert.deepStrictEqual(M.normalizeMove(tue, START, '2026-11-17', { date: '2026-11-18', time: '15:30', minutes: 30 }, TODAY), { date: '2026-11-18', time: '15:30', minutes: 30 });
  assert.match(M.normalizeMove(tue, START, '2026-11-10', { date: '2026-11-18', time: '15:30' }, TODAY).error, /one of its dates/);
  assert.match(M.normalizeMove(tue, START, '2026-11-17', { date: '2026-11-09', time: '15:30' }, TODAY).error, /past/);
  assert.match(M.normalizeMove(tue, START, '2026-11-17', { date: '2026-11-18', time: '25:00' }, TODAY).error, /time/);
  assert.match(M.normalizeMove(tue, START, '2026-11-17', { date: '2026-11-18', time: '15:00', minutes: 7 }, TODAY).error, /long/);
});

test('moving, moving back, and the past dropped', () => {
  let moved = M.withMove({ '2026-10-20': { date: '2026-10-21', time: '10:00', minutes: 60 } }, tue, '2026-11-17', { date: '2026-11-18', time: '15:30', minutes: 30 }, TODAY);
  assert.deepStrictEqual(moved, { '2026-11-17': { date: '2026-11-18', time: '15:30', minutes: 30 } });
  assert.deepStrictEqual(M.movedTo(moved), ['2026-11-18']);
  moved = M.withMove(moved, tue, '2026-11-17', { date: '2026-11-17', time: '14:00', minutes: 60 }, TODAY);
  assert.deepStrictEqual(moved, {});
});

test('its dates in a range, moves applied, in and out of it', () => {
  const moved = { '2026-11-17': { date: '2026-11-19', time: '09:00', minutes: 30 }, '2026-12-01': { date: '2026-11-27', time: '11:00', minutes: 60 } };
  const occ = M.occurrences(tue, START, moved, '2026-11-16', '2026-11-29');
  assert.deepStrictEqual(occ.map((x) => [x.orig, x.date, x.time, x.moved]), [['2026-11-17', '2026-11-19', '09:00', true], ['2026-12-01', '2026-11-27', '11:00', true]]);
  assert.deepStrictEqual(M.occurrences(tue, START, {}, '2026-11-16', '2026-11-29').map((x) => x.date), ['2026-11-17']);
});

test('Google: the instance’s id, and what to change', () => {
  assert.strictEqual(M.instanceId('abc', B.londonMs('2026-11-17', '14:00')), 'abc_20261117T140000Z');
  assert.strictEqual(M.instanceId('abc', B.londonMs('2026-06-02', '14:00')), 'abc_20260602T130000Z');   // BST
  const moved = { '2026-11-17': { date: '2026-11-18', time: '15:30', minutes: 30 } };
  assert.deepStrictEqual(M.movesToSync(tue, moved, {}), [{ orig: '2026-11-17', to: moved['2026-11-17'], restore: false }]);
  assert.deepStrictEqual(M.movesToSync(tue, moved, moved), []);
  // Moved back: its own time again.
  assert.deepStrictEqual(M.movesToSync(tue, {}, moved), [{ orig: '2026-11-17', to: { date: '2026-11-17', time: '14:00', minutes: 60 }, restore: false }]);
});

test('busy times and the calendar feed follow a moved date', () => {
  const moved = { '2026-11-17': { date: '2026-11-18', time: '15:30', minutes: 30 } };
  const b = B.meetingBusy(tue, Date.UTC(2026, 10, 16), Date.UTC(2026, 10, 20), START, moved);
  assert.deepStrictEqual(b.map((x) => new Date(x[0]).toISOString().slice(0, 16)), ['2026-11-18T15:30']);
  const ics = buildCalendar({ meetings: [{ id: 'p1', title: 'Sync', meeting: tue, start: START, moved }], now: Date.UTC(2026, 10, 11) });
  assert.match(ics, /BEGIN:VEVENT\r\nUID:p1@bold-os[\s\S]*RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU/);
  assert.match(ics, /RECURRENCE-ID;TZID=Europe\/London:20261117T140000\r\nDTSTART;TZID=Europe\/London:20261118T153000\r\nDTEND;TZID=Europe\/London:20261118T160000/);
  assert.doesNotMatch(ics, /EXDATE/);   // moved, not cancelled
});

test('an occurrence cancelled: left out everywhere, and restored', () => {
  const off = M.withMove({}, tue, '2026-11-17', { cancelled: true }, TODAY);
  assert.deepStrictEqual(off, { '2026-11-17': { cancelled: true } });
  assert.deepStrictEqual(M.movedTo(off), []);
  assert.deepStrictEqual(M.occurrences(tue, START, off, '2026-11-16', '2026-12-06').map((x) => x.date), ['2026-12-01']);
  assert.deepStrictEqual(M.movesToSync(tue, off, {}), [{ orig: '2026-11-17', to: { cancelled: true }, restore: false }]);
  // Restored: its own time again, and Google told it's back.
  assert.deepStrictEqual(M.movesToSync(tue, {}, off), [{ orig: '2026-11-17', to: { date: '2026-11-17', time: '14:00', minutes: 60 }, restore: true }]);
  assert.deepStrictEqual(B.meetingBusy(tue, Date.UTC(2026, 10, 16), Date.UTC(2026, 10, 20), START, off), []);
  const ics = buildCalendar({ meetings: [{ id: 'p1', title: 'Sync', meeting: tue, start: START, moved: off }], now: Date.UTC(2026, 10, 11) });
  assert.match(ics, /EXDATE;TZID=Europe\/London:20261117T140000/);
  assert.doesNotMatch(ics, /RECURRENCE-ID/);
});
