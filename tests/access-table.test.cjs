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

// The Problem Bank has its own row (2026-11-27). Without one it is open to everyone signed in
// (PAN-BOLD); every other page left out stays BOLD-internal.
class Denied extends Error { constructor(code, message){ super(message); this.code = code; } }
function accessFor(pages, members){
  const db = { collection: (name) => ({ doc: (id) => ({ get: async () => name === 'settings'
    ? { exists: pages !== null, data: () => ({ pages }) }
    : { exists: id in members, data: () => ({ category: members[id] }) } }) }) };
  return a({ db, groupOf: (m) => (m && m.category) || 'pan', isFullWrite: async () => false, HttpsError: Denied });
}
const MEMBERS = { 'internal@example.invalid': 'internal', 'associate@example.invalid': 'associate' };
const PAN = 'pan@example.invalid';

test('the Problem Bank is a page of its own, open to everyone signed in', () => {
  assert.ok(a.PAGES.some(([key, name]) => key === 'problem-bank' && name === 'Problem Bank'));
  assert.deepStrictEqual(a.DEFAULT_PAGES['problem-bank'], { view: 'everyone', edit: 'everyone' });
  assert.match(a.accessTableMarkdown(), /\| Problem Bank \| Everyone \| Everyone \|/);
});

test('a table saved before the Problem Bank had a row opens it to PAN-BOLD, and no other page', async () => {
  const saved = { projects: { view: 'internal', edit: 'internal' }, people: { view: 'everyone', edit: 'internal' } };
  const access = accessFor(saved, MEMBERS);
  assert.strictEqual(await access.can(PAN, 'problem-bank', 'view'), true);
  assert.strictEqual(await access.can(PAN, 'problem-bank', 'change'), true);
  await access.requireAccess(PAN, 'problem-bank', 'edit');
  assert.strictEqual(await access.can(PAN, 'projects', 'view'), false);
  assert.strictEqual(await access.can(PAN, 'projects', 'list'), false);
  assert.strictEqual(await access.can(PAN, 'people', 'edit'), false);
  assert.strictEqual(await access.can(PAN, 'calendar', 'view'), false, 'another page left out stays BOLD-internal');
  assert.strictEqual(await access.can('internal@example.invalid', 'calendar', 'view'), true);
  assert.strictEqual(await access.can(null, 'problem-bank', 'view'), false, 'never signed out');
});

test('the table’s own Problem Bank row decides', async () => {
  const access = accessFor({ 'problem-bank': { view: 'everyone', edit: 'internal' } }, MEMBERS);
  assert.strictEqual(await access.can(PAN, 'problem-bank', 'view'), true);
  assert.strictEqual(await access.can(PAN, 'problem-bank', 'edit'), false);
  assert.strictEqual(await access.can('associate@example.invalid', 'problem-bank', 'edit'), false);
  assert.strictEqual(await access.can('internal@example.invalid', 'problem-bank', 'edit'), true);
  await assert.rejects(access.requireAccess(PAN, 'problem-bank', 'edit'), /Problem Bank is for BOLD-internal and above/);
});

test('a table without a Problem Bank row keeps it open when it is saved again', () => {
  const t = a.parseAccessTable(OPEN);
  assert.deepStrictEqual(t['problem-bank'], { view: 'everyone', edit: 'everyone' });
  assert.strictEqual(t.people.edit, 'internal');
  const closed = a.parseAccessTable(OPEN + '\n| Problem Bank | BOLD-internal |');
  assert.deepStrictEqual(closed['problem-bank'], { view: 'everyone', edit: 'internal' });
  const older = a.parseAccessTable('| Page | View | Edit |\n|---|---|---|\n| Problem Bank | BOLD-associate | BOLD-internal |');
  assert.deepStrictEqual(older['problem-bank'], { view: 'associate', edit: 'internal' });
});
