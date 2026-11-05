// Notifications for what someone is part of (functions/notify.js): what each says, and to whom.
const test = require('node:test');
const assert = require('node:assert');
const { projectChanges, cardChanges, partOwners, editionChange } = require('../functions/notify.js');
const { pingText } = require('../functions/index.js')._internal;

test('a project: who joined or left, its status and its setup, told to its other people', () => {
  const b = { title: 'P', members: ['a@x', 'b@x'] };
  const a = { title: 'P', members: ['a@x', 'c@x'], startedAt: 1, startedBy: 'a@x', meeting: { day: 'MO' }, updatedBy: 'a@x' };
  const out = projectChanges(b, a, { 'c@x': 'Cara', 'b@x': 'Ben' });
  assert.deepStrictEqual(out.find((x) => x.kind === 'project-joined'), { to: ['a@x'], text: 'Cara joined “P”.', kind: 'project-joined' });
  assert.deepStrictEqual(out.find((x) => x.kind === 'project-left'), { to: ['a@x', 'c@x'], text: 'Ben left “P”.', kind: 'project-left' });
  assert.deepStrictEqual(out.find((x) => x.kind === 'project-status').to, ['c@x']);
  assert.strictEqual(out.find((x) => x.kind === 'project-setup').text, '“P”: its meeting changed.');
  assert.deepStrictEqual(projectChanges(a, a), []);
});

test('a card: whoever’s put on it, and its people and raiser when it moves; never the mover', () => {
  const b = { title: 'Fix it', column: 'todo', assigneeEmails: ['a@x'], by: { email: 'r@x' } };
  const a = Object.assign({}, b, { column: 'doing', assigneeEmails: ['a@x', 'n@x'], updatedBy: 'a@x' });
  const out = cardChanges(b, a, '#7 ', { 'a@x': 'Ann' });
  assert.deepStrictEqual(out[0], { to: ['n@x'], text: 'Ann put you on #7 “Fix it”.', kind: 'card-assigned' });
  assert.deepStrictEqual(out[1], { to: ['r@x'], text: 'Ann moved #7 “Fix it” to Doing.', kind: 'card-moved' });
  const done = cardChanges(b, Object.assign({}, b, { column: 'done', assigneeEmails: ['a@x', 'z@x'], updatedBy: 'q@x' }), '', {});
  assert.ok(done.find((x) => x.kind === 'card-moved').to.indexOf('r@x') < 0, 'the raiser hears of Done through card-done');
});

test('a part’s comments and proposals go to whoever last changed it, not to themselves', () => {
  const parts = [{ id: 'p1', changedBy: 'w@x' }, { id: 'p2' }];
  assert.deepStrictEqual(partOwners(parts, 'p1', 'c@x'), ['w@x']);
  assert.deepStrictEqual(partOwners(parts, 'p1', 'W@x'), []);
  assert.deepStrictEqual(partOwners(parts, 'p2', 'c@x'), []);
});

test('an edition: released, moved or cancelled', () => {
  assert.strictEqual(editionChange({ title: 'RG', hidden: true }, { title: 'RG', hidden: false, startDate: '2026-11-12' }).kind, 'edition-new');
  assert.strictEqual(editionChange({ title: 'RG', hidden: false, startDate: 'a' }, { title: 'RG', hidden: false, startDate: 'b' }).kind, 'edition-moved');
  assert.strictEqual(editionChange({ title: 'RG', hidden: false }, null).kind, 'edition-cancelled');
  assert.strictEqual(editionChange({ title: 'RG', hidden: true }, null), null);
  assert.strictEqual(editionChange({ title: 'RG', hidden: false, startDate: 'a' }, { title: 'RG', hidden: false, startDate: 'a' }), null);
});

test('the ping says how many, and links to them', () => {
  assert.strictEqual(pingText(1, 'u'), '🔔 You have a new notification on BOLD.OS: <u|open it>.');
  assert.match(pingText(4, 'u'), /4 new notifications/);
});
