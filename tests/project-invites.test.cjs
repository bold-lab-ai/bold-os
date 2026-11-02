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

test('an ask to join (from Projects) can be withdrawn, by the asker or an editor, but not accepted', () => {
  const ask = { email: 'pan@x.org', by: 'pan@x.org', status: 'asked' };
  assert.strictEqual(inviteRefusal(ask, 'withdraw', { email: 'pan@x.org' }), '');
  assert.strictEqual(inviteRefusal(ask, 'withdraw', { email: 'lead@x.org', editor: true }), '');
  assert.match(inviteRefusal(ask, 'accept', { email: 'pan@x.org' }), /already been asked/);
});

test('PAN-BOLD sees titles to ask about; the button follows the ask', () => {
  const { projectTitlesOnly } = require('../functions/index.js')._internal;
  const groups = { ongoing: [{ pid: 'a', title: 'A', authors: [] }, { pid: 'b', title: 'B', authors: [] }], submission: [], completed: [], planned: [] };
  const shown = projectTitlesOnly(groups, { b: true }, true);
  assert.deepStrictEqual([shown.ongoing[0].titleOnly, shown.ongoing[0].ask], [true, true]);
  assert.strictEqual(shown.ongoing[1].titleOnly, undefined, 'their own, in full');
  assert.strictEqual(projectTitlesOnly(groups, {}, false).ongoing[0].ask, undefined, 'no ask flag when not asked for');
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ctx = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/assets/js/project-join.js'), 'utf8'), ctx);
  const st = (p) => ctx.BoldProjectJoin.joinState(p);
  assert.strictEqual(st({ ask: true }).label, 'Ask to join');
  assert.strictEqual(st({ ask: true, asked: true }).disabled, true);
  assert.strictEqual(st({ ask: true, invited: 'iv1' }).invite, 'iv1');
  assert.strictEqual(st({ joined: true, ask: true }).label, 'Joined');
});
