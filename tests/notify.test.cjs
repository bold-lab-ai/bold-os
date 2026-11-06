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
  assert.strictEqual(pingText(1, 'u'), '🔔 You have a new notification on BOLD.OS: <u|open it>. _<u#settings|Change what you get on Slack>_');
  assert.match(pingText(4, 'u'), /4 new notifications/);
});

test('someone signed in with Slack is on the roster under their account’s email', () => {
  const { accountEmailsBySlackId } = require('../functions/index.js')._internal;
  const users = [
    { email: 'Y@x', providerData: [{ providerId: 'oidc.slack', uid: 'U1', email: 'other@x' }, { providerId: 'github.com', uid: '9' }] },
    { email: 'g@x', providerData: [{ providerId: 'google.com', uid: '7' }] },
  ];
  assert.deepStrictEqual(accountEmailsBySlackId(users), { U1: 'y@x' });
});

test('moving someone to another email: values, arrays and map keys, any case', () => {
  const { replaceEmail } = require('../functions/index.js')._internal;
  const r = replaceEmail({ to: 'Old@x', members: ['a@x', 'old@x'], by: { email: 'old@x', name: 'Y' }, seen: { 'old@x': 1 }, n: 3, note: 'old@x said' }, 'old@x', 'new@x');
  assert.strictEqual(r.n, 4);
  assert.deepStrictEqual(r.value, { to: 'new@x', members: ['a@x', 'new@x'], by: { email: 'new@x', name: 'Y' }, seen: { 'new@x': 1 }, n: 3, note: 'old@x said' });
});

test('someone joining or leaving: whose project it is hears of it as a kind of its own', () => {
  const b = { title: 'P', members: ['lead@x', 'a@x'] }, a = { title: 'P', members: ['lead@x', 'a@x', 'c@x'] };
  const out = projectChanges(b, a, { 'c@x': 'Cara' }, ['Lead@x']);
  assert.deepStrictEqual(out.find((x) => x.kind === 'project-joined-mine').to, ['lead@x']);
  assert.deepStrictEqual(out.find((x) => x.kind === 'project-joined').to, ['a@x']);
  // With nobody leading it, as before.
  assert.strictEqual(projectChanges(b, a, {}).some((x) => /-mine$/.test(x.kind)), false);
});

const kinds = require('../functions/notify-kinds');
test('what people can turn off: each feature in one kind, each kind with an id of its own', () => {
  const ids = kinds.IDS, features = kinds.KINDS.flatMap((s) => s.items.flatMap((i) => i.features));
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.strictEqual(new Set(features).size, features.length);
});
test('an unticked kind is heard of in the Inbox only; a feature in no kind, always', () => {
  assert.strictEqual(kinds.kindOf('conversation-reply-mine'), 'conv-mine');
  assert.strictEqual(kinds.wants(['conv-mine'], 'conversation-reply-mine'), false);
  assert.strictEqual(kinds.wants(['conv-mine'], 'conversation-replies'), true);
  assert.strictEqual(kinds.wants(['conv-mine'], 'channel-alignment'), true);
  assert.strictEqual(kinds.wants(undefined, 'project-joined'), true);
});
