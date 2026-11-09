// /bug's form: a proper report, in sections, its severity in the card's title.
const test = require('node:test');
const assert = require('node:assert');
const { bugReportOf, bugNotes, bugTitle } = require('../functions/index.js')._internal;

const values = (o) => Object.fromEntries(Object.entries(o).map(([k, x]) => [k, { v: k === 'severity' ? { selected_option: { value: x } } : { value: x } }]));

test('the form’s sections become the description, with only what was filled in', () => {
  const r = bugReportOf(values({ where: 'Projects', happened: 'It froze', steps: '1. Open\n2. Click', severity: 'blocks' }));
  assert.deepStrictEqual(r, { where: 'Projects', happened: 'It froze', expected: '', steps: '1. Open\n2. Click', severity: 'blocks', device: '' });
  const n = bugNotes(r);
  assert.match(n, /^\*\*Severity:\*\* Blocks me/);
  assert.match(n, /### Where\nProjects/);
  assert.match(n, /### Steps to reproduce\n1\. Open\n2\. Click/);
  assert.doesNotMatch(n, /What I expected|Device/);
});

test('the severity goes in the title', () => {
  assert.strictEqual(bugTitle('Bug: the board froze', 'blocks'), 'Bug (blocks me): the board froze');
  assert.strictEqual(bugTitle('bug:x', 'cosmetic'), 'Bug (cosmetic):x');
  assert.strictEqual(bugTitle('The board froze', 'annoying'), 'Bug (annoying): The board froze');
  assert.strictEqual(bugTitle('Bug: the board froze', ''), 'Bug: the board froze');
  assert.strictEqual(bugReportOf(values({ severity: 'nonsense' })).severity, '');
});
