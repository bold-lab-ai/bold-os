// Moves between groups (groupMoves, Network › Lineage), PAN-BOLD's channels, and where a
// person's meeting invitations go (#178).
const test = require('node:test');
const assert = require('node:assert');
const { groupMoveOf, currentGroupMove, groupMoveTitle, channelGroupsFor, inviteChoices, validInviteTo, interactionsFor } = require('../functions/index.js')._internal;

test('a change of group is a move; joining and saving details are not', () => {
  assert.deepStrictEqual(groupMoveOf('A@x.org', { category: 'associate' }, { category: 'internal', categoryBy: 'PI@x.org', categoryAt: 5 }),
    { email: 'a@x.org', from: 'associate', to: 'internal', by: 'pi@x.org', at: 5, via: '' });
  assert.strictEqual(groupMoveOf('a@x.org', {}, { category: 'pan' }), null);
  assert.strictEqual(groupMoveOf('a@x.org', { category: 'pan', name: 'A' }, { category: 'pan', name: 'B' }), null);
});

test('a request\'s move says so (its interaction is the request\'s), a later move on People does not', () => {
  const viaReq = groupMoveOf('a@x.org', { category: 'pan' }, { category: 'associate', categoryBy: 'p@x.org', categoryAt: 7, categoryVia: 'request-7' });
  assert.strictEqual(viaReq.via, 'request');
  const later = groupMoveOf('a@x.org', { category: 'associate', categoryVia: 'request-7' }, { category: 'internal', categoryBy: 'p@x.org', categoryAt: 9, categoryVia: 'request-7' });
  assert.strictEqual(later.via, '');
});

test('backfill: a group someone else set, not PAN-BOLD on joining or a request\'s', () => {
  assert.deepStrictEqual(currentGroupMove('a@x.org', { category: 'internal', categoryBy: 'p@x.org', categoryAt: 3 }), { email: 'a@x.org', from: '', to: 'internal', by: 'p@x.org', at: 3, via: '' });
  assert.strictEqual(currentGroupMove('a@x.org', { category: 'pan', categoryBy: 'p@x.org', categoryAt: 3 }), null);
  assert.strictEqual(currentGroupMove('a@x.org', { category: 'internal', categoryBy: 'a@x.org', categoryAt: 3 }), null);
  assert.strictEqual(currentGroupMove('a@x.org', { category: 'associate', categoryBy: 'p@x.org', categoryAt: 1000, categoryVia: 'request-1000' }), null);
  assert.ok(currentGroupMove('a@x.org', { category: 'internal', categoryBy: 'p@x.org', categoryAt: 99000, categoryVia: 'request-1000' }));
});

test('moves become interactions: requests approved, People\'s moves, not a request\'s logged move', async () => {
  const none = async () => null;
  const req = await interactionsFor('groupRequests/r1', { status: 'approved', email: 'a@x.org', from: 'pan', to: 'associate', decidedBy: 'p@x.org', decidedAt: 4 }, none);
  assert.deepStrictEqual(req.map((x) => [x.kind, x.from, x.to, x.title]), [['moved', 'p@x.org', 'a@x.org', 'PAN-BOLD → BOLD-associate']]);
  assert.strictEqual((await interactionsFor('groupRequests/r2', { status: 'open', email: 'a@x.org', from: 'pan', to: 'associate' }, none)).length, 0);
  const mv = await interactionsFor('groupMoves/m1', { email: 'a@x.org', from: '', to: 'internal', by: 'p@x.org', at: 5, via: '' }, none);
  assert.strictEqual(mv[0].title, 'BOLD-internal');
  assert.strictEqual((await interactionsFor('groupMoves/m2', { email: 'a@x.org', from: 'pan', to: 'associate', by: 'p@x.org', at: 5, via: 'request' }, none)).length, 0);
  assert.strictEqual(groupMoveTitle('associate', 'internal'), 'BOLD-associate → BOLD-internal');
});

test('PAN-BOLD has channels too: everyone is in them', () => {
  ['exec', 'staff', 'internal', 'associate', 'pan'].forEach((g) => assert.ok(channelGroupsFor(g).indexOf('pan') >= 0, g));
  assert.deepStrictEqual(channelGroupsFor('pan'), ['pan']);
  assert.deepStrictEqual(channelGroupsFor('internal'), ['internal', 'associate', 'pan']);
});

test('invitations go only to their own proven addresses', () => {
  const choices = inviteChoices('A@x.org', 'a@slack.org', 'a@gmail.com');
  assert.deepStrictEqual(choices, ['a@x.org', 'a@slack.org', 'a@gmail.com']);
  assert.deepStrictEqual(inviteChoices('a@x.org', 'a@x.org', 'a@gmail.com'), ['a@x.org', 'a@gmail.com']);
  assert.deepStrictEqual(validInviteTo(['A@X.org', 'evil@y.org', 'a@gmail.com', 'a@x.org'], choices), ['a@x.org', 'a@gmail.com']);
  assert.deepStrictEqual(validInviteTo('a@x.org', choices), []);
});
