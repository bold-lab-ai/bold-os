// Emoji by name (src/assets/js/emoji.js): what opens the list, what it finds, and :name: typed whole.
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const read = (f) => fs.readFileSync(__dirname + '/../src/assets/js/' + f, 'utf8');
const ctx = { window: {}, module: { exports: {} } };
vm.runInNewContext(read('emoji-data.js'), ctx); vm.runInNewContext(read('emoji.js'), ctx);
const M = ctx.module.exports, plain = (f) => (...a) => JSON.parse(JSON.stringify(f(...a)));
const E = { parse: plain(M.parse), byName: M.byName, typing: plain(M.typing), whole: plain(M.whole), find: plain(M.find) };
const all = E.parse(ctx.window.BoldEmojiData);

test('the list: Slack’s names', () => {
  assert.ok(all.length > 1800);
  assert.strictEqual(E.byName(all, 'tada'), '🎉');
  assert.strictEqual(E.byName(all, '+1'), '👍');
  assert.strictEqual(E.byName(all, 'thumbsup'), '👍');
  assert.strictEqual(E.byName(all, 'nope-not-one'), '');
});

test('what opens it: : and two letters, after a space or the start; not times or links', () => {
  assert.deepStrictEqual(E.typing('Nice :ta'), { start: 5, query: 'ta' });
  assert.deepStrictEqual(E.typing(':ro'), { start: 0, query: 'ro' });
  assert.strictEqual(E.typing('Nice :t'), null);
  assert.strictEqual(E.typing('at 10:30'), null);
  assert.strictEqual(E.typing('see https://ta'), null);
  assert.strictEqual(E.typing('Nice :ta da'), null);
});

test('what it finds: the name itself, then names starting with it, then words in names', () => {
  const r = E.find(all, 'tada', 8);
  assert.deepStrictEqual(r[0], { e: '🎉', name: 'tada' });
  const s = E.find(all, 'smile', 8);
  assert.strictEqual(s[0].name, 'smile');
  assert.ok(s.length <= 8);
  assert.deepStrictEqual(E.find(all, 'mile', 8), []);   // inside a word: not a match
  assert.ok(E.find(all, 'heart', 200).some((x) => x.name === 'yellow_heart'));
});

test('a whole :name: typed', () => {
  assert.deepStrictEqual(E.whole('Great :tada:'), { start: 6, name: 'tada' });
  assert.strictEqual(E.whole('at 10:30:'), null);
});
