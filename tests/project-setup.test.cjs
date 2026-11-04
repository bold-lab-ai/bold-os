// A project is ongoing when its practical setup is all there (a weekly meeting, slides, notes and a
// GitHub repository), or when it was marked ongoing, which needs that setup first (2026-11-04).
// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { setupMissing, setupMissingText, workspaceStarted, normalizeRepo, setupNudgeText } = require('../functions/index.js')._internal;

const full = { meeting: { day: 'MO', time: '10:00' }, deckId: 'd', notesId: 'n', repoName: 'proj-x' };

test('all four set up: ongoing on its own', () => {
  assert.deepStrictEqual(setupMissing(full), []);
  assert.strictEqual(workspaceStarted(full), true);
});

test('their own slides, notes and a linked repository count too', () => {
  assert.deepStrictEqual(setupMissing({ meeting: {}, ownDeckUrl: 'https://x', ownNotesUrl: 'https://y', ownRepoUrl: 'https://github.com/a/b' }), []);
});

test('a meeting alone no longer makes it ongoing; marked ongoing before, it stays so', () => {
  const meetingOnly = { meeting: { day: 'MO' } };
  assert.deepStrictEqual(setupMissing(meetingOnly), ['slides', 'notes', 'repo']);
  assert.strictEqual(workspaceStarted(meetingOnly), false);
  assert.strictEqual(workspaceStarted(Object.assign({ startedAt: 1 }, meetingOnly)), true);
  assert.strictEqual(workspaceStarted(null), false);
});

test('what’s missing, in words', () => {
  assert.strictEqual(setupMissingText(['meeting', 'repo']), 'a weekly meeting and a GitHub repository');
  assert.strictEqual(setupMissingText(['slides', 'notes', 'repo']), 'slides, meeting notes and a GitHub repository');
  assert.match(setupNudgeText('ROAR', ['meeting'], 'https://x/project.html'), /^🛠️ “ROAR” is ongoing but still needs a weekly meeting\. /);
});

test('any GitHub repository can be linked; nothing else', () => {
  assert.deepStrictEqual(normalizeRepo({ mode: 'link', url: 'https://github.com/someone/thing.git/' }), { mode: 'link', url: 'https://github.com/someone/thing' });
  assert.ok(normalizeRepo({ mode: 'link', url: 'https://gitlab.com/a/b' }).error);
  assert.ok(normalizeRepo({ mode: 'link', url: 'https://github.com/only-owner' }).error);
  assert.ok(normalizeRepo({ mode: 'link', url: 'javascript:alert(1)' }).error);
});

test('the page and the server agree on what’s missing', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/assets/js/project-fields.js'), 'utf8');
  const ctx = { document: {}, firebase: {} }; require('node:vm').runInNewContext(src, ctx);
  for (const ws of [{}, full, { meeting: {} }, { ownDeckUrl: 'x', notesUrl: 'y', ownRepoUrl: 'z' }, null]) {
    assert.deepStrictEqual([...ctx.projectSetupMissing(ws)], setupMissing(ws), JSON.stringify(ws));
  }
});
