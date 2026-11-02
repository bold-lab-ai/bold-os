// Inviting someone to a project (#148): who may answer or withdraw an invitation (inviteRefusal).
// Run: npm test
const test = require('node:test');
const assert = require('node:assert');

const { inviteRefusal } = require('../functions/index.js')._internal;
const inv = { email: 'new@x.org', by: 'lead@x.org', status: 'open' };

test('only the person invited accepts or declines', () => {
  assert.strictEqual(inviteRefusal(inv, 'accept', { email: 'New@x.org' }), '');
  assert.strictEqual(inviteRefusal(inv, 'decline', { email: 'new@x.org' }), '');
  assert.match(inviteRefusal(inv, 'accept', { email: 'lead@x.org', editor: true }), /someone else/);
});

test('whoever invited them, or an editor, withdraws it', () => {
  assert.strictEqual(inviteRefusal(inv, 'withdraw', { email: 'lead@x.org' }), '');
  assert.strictEqual(inviteRefusal(inv, 'withdraw', { email: 'pi@x.org', editor: true }), '');
  assert.match(inviteRefusal(inv, 'withdraw', { email: 'new@x.org' }), /Only whoever invited them/);
});

test('only an open one, and only known actions', () => {
  assert.match(inviteRefusal(Object.assign({}, inv, { status: 'accepted' }), 'accept', { email: 'new@x.org' }), /already been accepted/);
  assert.match(inviteRefusal(null, 'accept', { email: 'new@x.org' }), /isn’t there/);
  assert.match(inviteRefusal(inv, 'delete', { email: 'lead@x.org' }), /Unknown/);
});
