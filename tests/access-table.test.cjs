// Who can do what (BOLDiquette, 2026-11-04): everyone signed in sees everything; the table,
// headed Page | Edit, says who can act on each page. The older Page | View | Edit still reads.
const test = require('node:test');
const assert = require('node:assert');
const a = require('../functions/access.js');

const OPEN = '| Page | Edit |\n|---|---|\n| Calendar | Everyone |\n| Projects | BOLD-associate |\n| Your profile | Everyone |';

test('a Page | Edit table opens every page to everyone, and says who acts', () => {
  assert.strictEqual(a.accessColumns(OPEN), 1);
  const t = a.parseAccessTable(OPEN);
  for (const [key] of a.PAGES) assert.strictEqual(t[key].view, 'everyone', key);
  assert.strictEqual(t.calendar.edit, 'everyone');
  assert.strictEqual(t.projects.edit, 'associate');
  assert.strictEqual(t.people.edit, 'internal', 'a page left out: Edit BOLD-internal');
});

test('the Page | View | Edit table reads as before', () => {
  const t = a.parseAccessTable('| Page | View | Edit |\n|---|---|---|\n| Projects | BOLD-internal | BOLD-associate |');
  assert.deepStrictEqual(t.projects, { view: 'internal', edit: 'associate' });
  assert.strictEqual(t.people, undefined);
});

test('everyone keeps editing their profile (where they ask for another group)', () => {
  assert.throws(() => a.parseAccessTable('| Page | Edit |\n|---|---|\n| Your profile | BOLD-internal |'), /profile/);
});

test('a bad row says which', () => {
  assert.throws(() => a.parseAccessTable('| Page | Edit |\n|---|---|\n| Nowhere | Everyone |'), /Nowhere/);
  assert.throws(() => a.parseAccessTable('| Page | Edit |\n|---|---|\n| Calendar | Somebody |'), /Somebody/);
});

test('changing one row keeps the table’s shape', () => {
  const body = a.setAccessRow(OPEN, 'people', { view: 'everyone', edit: 'exec' });
  assert.match(body, /\| People \| BOLD-exec \|/);
  assert.strictEqual(a.parseAccessTable(body).people.edit, 'exec');
  const old = a.setAccessRow('| Page | View | Edit |\n|---|---|---|\n| Projects | BOLD-internal | BOLD-associate |', 'people', { view: 'internal', edit: 'exec' });
  assert.match(old, /\| People \| BOLD-internal \| BOLD-exec \|/);
});
