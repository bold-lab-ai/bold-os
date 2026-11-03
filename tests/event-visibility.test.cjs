// Who sees an event series or an event (visibleTo, 2026-11-02): functions/access.js, which the
// server's listings use, and bold.js BOLD.visibleLevels, which pages query with (they must agree).
// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { seesEvent, visibleLevels, visibilityOf } = require('../functions/access.js');

test('a group sees its level and those below; signed out, only what is for anyone', () => {
  const x = (v) => ({ visibleTo: v });
  assert.strictEqual(seesEvent('out', x('public')), true);
  assert.strictEqual(seesEvent('out', x('everyone')), false);
  assert.strictEqual(seesEvent('pan', x('everyone')), true);
  assert.strictEqual(seesEvent('pan', x('associate')), false);
  assert.strictEqual(seesEvent('associate', x('associate')), true);
  assert.strictEqual(seesEvent('associate', x('internal')), false);
  assert.strictEqual(seesEvent('exec', x('exec')), true);
});

test('without a level, BOLD-internal and above (as every event was before)', () => {
  assert.strictEqual(visibilityOf({}), 'internal');
  assert.strictEqual(visibilityOf({ visibleTo: 'nonsense' }), 'internal');
  assert.strictEqual(seesEvent('associate', {}), false);
  assert.strictEqual(seesEvent('internal', {}), true);
});

test('the pages ask for the same levels the server allows', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/assets/js/bold.js'), 'utf8');
  const body = src.slice(src.indexOf("  var VIS = ['public'"), src.indexOf('  };', src.indexOf('BOLD.visibleLevels = function')) + 4);
  for (const [group, full] of [['out', false], ['pan', false], ['associate', false], ['internal', false], ['staff', false], ['pan', true]]) {
    const ctx = { BOLD: {}, access: group === 'out' ? null : { e: 'x@y.z', group, fullWrite: full } };
    vm.runInNewContext(body, ctx);
    assert.deepStrictEqual([...ctx.BOLD.visibleLevels()], visibleLevels(full ? 'exec' : group), group + (full ? ' (PI)' : ''));
  }
});
