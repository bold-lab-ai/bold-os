// Diffs (src/assets/js/history.js diffHtml), as GitHub shows them: hunks under their @@ headers (as `git diff -U3`
// writes them), each line numbered before and after.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ctx = { window: {}, BOLD: { escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }, Uint32Array, Uint16Array };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/assets/js/history.js'), 'utf8'), ctx);
const H = ctx.window.BoldHistory;
// Each row shown → '@@ … @@' for a hunk's header, else 'old|new|op|text'.
const rows = (a, b) => Array.from(H.diffHtml(a, b).matchAll(/<div class="hist-(add|del|ctx|hunk|gap)">(.*?)<\/div>/g), (m) => {
  if (m[1] === 'hunk' || m[1] === 'gap') return m[2];
  return Array.from(m[2].matchAll(/<span class="hist-(?:ln|op|text)">(.*?)<\/span>/g), (c) => c[1].replace(/<[^>]+>/g, '')).join('|');
});
const hunks = (a, b) => rows(a, b).filter((r) => r.startsWith('@@'));
const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n');

test('a change in the middle: one hunk, its header, each line numbered before and after', () => {
  const a = lines(9, (i) => 'line ' + i), b = a.replace('line 5', 'line five').replace('line 7\n', '');
  assert.deepStrictEqual(rows(a, b), ['@@ -2,8 +2,7 @@', '2|2||line 2', '3|3||line 3', '4|4||line 4', '5||-|line 5', '|5|+|line five', '6|6||line 6', '7||-|line 7', '8|7||line 8', '9|8||line 9']);
});

test('two changes far apart: two hunks, as git diff writes them, the numbers carrying on', () => {
  const a = lines(30, (i) => 'l' + i), b = a.replace('l2\n', 'two\n').replace('l25', 'twenty-five');
  assert.deepStrictEqual(hunks(a, b), ['@@ -1,5 +1,5 @@', '@@ -22,7 +22,7 @@']);
  const r = rows(a, b);
  assert.ok(r.includes('25||-|l25') && r.includes('|25|+|twenty-five'));
  assert.ok(!r.some((x) => x === '⋯'));
});

test('a line added near the top', () => {
  const a = lines(30, (i) => 'l' + i), b = a.replace('l1\n', 'l1\nnew\n');
  assert.deepStrictEqual(hunks(a, b), ['@@ -1,4 +1,5 @@']);
});

test('all new, all removed, and a count of 1 written without ",1"', () => {
  assert.deepStrictEqual(rows('', 'a\nb'), ['@@ -0,0 +1,2 @@', '|1|+|a', '|2|+|b']);
  assert.deepStrictEqual(rows('a\nb', ''), ['@@ -1,2 +0,0 @@', '1||-|a', '2||-|b']);
  assert.deepStrictEqual(hunks('x', 'y'), ['@@ -1 +1 @@']);
});
