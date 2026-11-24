// Deleting your own profile (functions/index.js deleteMyProfile): which of your documents go.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {ownDocs} = require('../functions/index.js')._internal;

test('their details, links, feeds and settings go; nothing of anyone else’s', () => {
  const d = ownDocs('a@b.c', 'U1');
  for (const p of ['members/a@b.c', 'googleLinks/a@b.c', 'githubLinks/a@b.c', 'calendarFeeds/a@b.c', 'visits/a@b.c', 'homeLetters/a@b.c', 'prefs/U1']) assert.ok(d.includes(p), p);
  assert.ok(d.every((p) => p.endsWith('/a@b.c') || p === 'prefs/U1'));
  assert.ok(!d.some((p) => p.startsWith('people/') || p.startsWith('conversations/') || p.startsWith('projects/')), 'the Slack roster and what they wrote stay');
});
