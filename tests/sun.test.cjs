// The Auto theme's sun (src/_includes/sun.js, inlined in base.njk): London's sunrise and sunset, and when it's dark.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ctx = { Math, Date };
ctx.window = ctx;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/_includes/sun.js'), 'utf8'), ctx);
const london = (t) => new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
const mins = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const near = (t, hm) => assert.ok(Math.abs(mins(london(t)) - mins(hm)) <= 3, london(t) + ' vs ' + hm);

test('London’s sunrise and sunset, within a few minutes of the almanac', () => {
  let s = ctx.boldSun(Date.parse('2026-11-07T12:00:00Z')); near(s.rise, '07:05'); near(s.set, '16:23');
  s = ctx.boldSun(Date.parse('2026-06-21T12:00:00Z')); near(s.rise, '04:43'); near(s.set, '21:21');
  s = ctx.boldSun(Date.parse('2026-12-21T12:00:00Z')); near(s.rise, '08:04'); near(s.set, '15:53');
});

test('dark before sunrise and after sunset, light between', () => {
  assert.strictEqual(ctx.boldSunDark(Date.parse('2026-11-07T06:00:00Z')), true);
  assert.strictEqual(ctx.boldSunDark(Date.parse('2026-11-07T12:00:00Z')), false);
  assert.strictEqual(ctx.boldSunDark(Date.parse('2026-11-07T17:00:00Z')), true);
});

test('the next change: today’s sunrise, today’s sunset, then tomorrow’s sunrise', () => {
  const day = (iso) => ctx.boldSun(Date.parse(iso));
  assert.strictEqual(ctx.boldSunNext(Date.parse('2026-11-07T06:00:00Z')), day('2026-11-07T12:00:00Z').rise);
  assert.strictEqual(ctx.boldSunNext(Date.parse('2026-11-07T12:00:00Z')), day('2026-11-07T12:00:00Z').set);
  assert.strictEqual(ctx.boldSunNext(Date.parse('2026-11-07T20:00:00Z')), day('2026-11-08T12:00:00Z').rise);
});
