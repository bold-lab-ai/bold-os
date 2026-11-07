// Search ranking (src/assets/js/search-rank.js, copied to functions/ on deploy), shared by the site's search and the agents': the whole before its words (#251).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ctx = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/assets/js/search-rank.js'), 'utf8'), ctx);
const R = ctx.module.exports;

const items = [
  { title: 'Behind the Tokens', where: 'Talk', text: 'Intelligence is possible only because the world has structure. ' + 'Filler words go here. '.repeat(20) + 'Deep models learn it.' },
  { title: 'DreamTeam', where: 'Project', text: 'Foundation world models can simulate diverse environments.' },
  { title: 'Sparse world models for control', where: 'Project', text: 'Planning.' },
  { title: 'World models', where: 'Project', text: 'A line of work.' },
  { title: 'Models of the world', where: 'Talk', text: 'A talk.' },
];
const titles = (q) => Array.from(R.rank(items, q), (r) => r.item.title);

test('a title that is the query comes first, then the phrase in a title, then in a text', () => {
  assert.deepStrictEqual(titles('world models').slice(0, 3), ['World models', 'Sparse world models for control', 'DreamTeam']);
});

test('the words close together come before the words far apart', () => {
  const t = titles('world models');
  assert.ok(t.indexOf('Models of the world') < t.indexOf('Behind the Tokens'));
});

test('every word must match: one that has only the first word is left out', () => {
  assert.ok(!titles('world tokens').includes('World models'));
  assert.deepStrictEqual(titles('world tokens'), ['Behind the Tokens']);
});

test('a phrase is found through plurals and British spellings', () => {
  const r = R.rank([{ title: 'Generalisation in world models', where: '', text: '' }], 'generalization in world model');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].tier, 4);
});
