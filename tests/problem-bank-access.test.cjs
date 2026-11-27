// The Problem Bank's own row in Who can do what (2026-11-27), held to by every layer: the rules,
// the pages, the callables and the agents' API name `problem-bank`, and a page left out of the
// saved table gets the same level in all three places that read it.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const access = require('../functions/access.js');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const literal = (source, pattern) => { const m = source.match(pattern); assert.ok(m, String(pattern)); return Function('return (' + m[1] + ')')(); };

test('a page left out of the saved table: the same level in the functions, the rules and the pages', () => {
  assert.deepEqual(access.UNLISTED, { 'problem-bank': 'everyone' });
  assert.deepEqual(literal(read('firebase/firestore.rules'), /let unlisted = (\{[^}]*\})\.get\(page, 'internal'\);/), access.UNLISTED);
  assert.deepEqual(literal(read('src/assets/js/bold.js'), /var UNLISTED = (\{[^}]*\});/), access.UNLISTED);
});

test('the pages name every page the table has', () => {
  const names = literal(read('src/assets/js/bold.js'), /var AREA_NAMES = (\{[^}]*\});/);
  assert.deepEqual(names, Object.fromEntries(access.PAGES));
});

test('the Problem Bank’s pages, sidebar link and + menu are in its own area', () => {
  for (const page of ['problems', 'problem', 'problem-new']) assert.match(read('src/pages/' + page + '.html'), /^---\narea: "problem-bank"\n/, page);
  assert.match(read('src/_data/site.js'), /\{ label: 'Problem Bank', href: 'problems\.html', area: 'problem-bank' \}/);
  assert.match(read('src/assets/js/bold.js'), /\{ label: 'Open problem', href: 'problem-new\.html', can: may\('problem-bank', 'edit'\) \}/);
  // The roster is People's or Projects': without either, the definer's Edit is greyed out with the reason.
  assert.match(read('src/assets/js/pages/problem.js'), /aria-label="Problem definer"><\/select>', rosterUnavailable\(\)\);/);
  for (const script of ['problems', 'problem', 'problem-new']) {
    const source = read('src/assets/js/pages/' + script + '.js');
    assert.doesNotMatch(source, /BOLD\.(can|cannotReason)\('projects', ?'edit'\)/, script);
    assert.match(source, /BOLD\.can\('problem-bank', ?'edit'\)/, script);
  }
});

test('the rules let whoever edits the Problem Bank keep a draft', () => {
  const rules = read('firebase/firestore.rules');
  const drafts = rules.slice(rules.indexOf('match /problemDrafts/{id}'));
  assert.match(drafts.slice(0, 400), /allow create, update: if may\('problem-bank', 'edit'\) && request\.resource\.data\.email == email\(\)/);
  // The saved table has only view and edit: any other name reads as BOLD-internal.
  assert.doesNotMatch(rules, /may(List)?\('[a-z-]+', '(?!view'|edit')/);
});

test('the callables and the agents’ tools for problems check the Problem Bank', () => {
  const index = read('functions/index.js');
  for (const name of ['problemTrial', 'problemInterview']) {
    const body = index.slice(index.indexOf('exports.' + name + ' = onCall('));
    assert.match(body.slice(0, 600), /await access\.requireAccess\(email, 'problem-bank', 'change'\);/, name);
  }
  const api = read('functions/api.js');
  const pages = literal(api, /const TOOL_PAGE = (\{[^}]*\});/);
  for (const tool of ['list_benchmarks', 'register_benchmark', 'create_open_problem', 'edit_problem']) assert.equal(pages[tool], 'problem-bank', tool);
  assert.equal(pages.list_projects, 'projects');
  assert.match(api, /\(want\('problems'\) \|\| want\('benchmarks'\)\) && await access\.can\(who\.email, 'problem-bank', 'view'\)/);
});
