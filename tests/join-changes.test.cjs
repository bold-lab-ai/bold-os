// Asking whoever asked to join to change their request (joinChanges, #261).
const test = require('node:test');
const assert = require('node:assert');
const { joinChangesRefusal, joinChangesKeyRefusal, joinChangesEmail, joinChangesView, keyHash } = require('../functions/index.js')._internal;

const req = (o) => Object.assign({ name: 'Ada Byron', email: 'ada@x.org', status: 'open', invitedBy: { id: 'U1', name: 'Inviter', email: 'inv@x.org' } }, o);

test('only whoever decides a request asks for changes, while it is open, with a note', () => {
  assert.strictEqual(joinChangesRefusal(req(), { email: 'inv@x.org' }, 'Your end date, please'), '');
  assert.match(joinChangesRefusal(req(), { email: 'other@x.org' }, 'x'), /Only whoever invited them/);
  // PIs and admins only a request that names nobody, as for deciding it.
  assert.match(joinChangesRefusal(req(), { email: 'pi@x.org', full: true }, 'x'), /Only whoever invited them/);
  assert.strictEqual(joinChangesRefusal(req({ invitedBy: null }), { email: 'pi@x.org', full: true }, 'x'), '');
  assert.match(joinChangesRefusal(req({ status: 'approved' }), { email: 'inv@x.org' }, 'x'), /already been approved/);
  assert.match(joinChangesRefusal(req(), { email: 'inv@x.org' }, '   '), /Say what/);
  assert.match(joinChangesRefusal(req(), { email: 'inv@x.org' }, 'x'.repeat(1001)), /too long/);
  assert.match(joinChangesRefusal(null, { email: 'inv@x.org' }, 'x'), /No such/);
});

test('the link works with its key, once, while the request is open', () => {
  const asked = req({ changes: { status: 'asked', keyHash: keyHash('k1') } });
  assert.strictEqual(joinChangesKeyRefusal(asked, 'k1'), '');
  assert.match(joinChangesKeyRefusal(asked, 'k2'), /isn’t valid/);
  assert.match(joinChangesKeyRefusal(asked, ''), /isn’t valid/);
  assert.match(joinChangesKeyRefusal(req(), 'k1'), /isn’t valid/);
  // Saving clears the hash: the same link never works twice.
  assert.match(joinChangesKeyRefusal(req({ changes: { status: 'made', keyHash: '' } }), 'k1'), /isn’t valid/);
  assert.match(joinChangesKeyRefusal(req({ changes: { status: 'made', keyHash: keyHash('k1') } }), 'k1'), /already changed/);
  assert.match(joinChangesKeyRefusal(req({ status: 'declined', changes: { status: 'asked', keyHash: keyHash('k1') } }), 'k1'), /already been declined/);
});

test('the email names who asks, quotes the note and carries the link', () => {
  const m = joinChangesEmail(req(), 'Your end date\nand pillars', 'https://site/join.html?changes=r1&key=k', 'Inviter');
  assert.match(m.subject, /Inviter asks for changes/);
  assert.match(m.body, /^Hi Ada,/);
  assert.match(m.body, / {2}Your end date\n {2}and pillars/);
  assert.match(m.body, /https:\/\/site\/join\.html\?changes=r1&key=k/);
});

test('the applicant sees their answers and the note, never the key or who decided anything else', () => {
  const v = joinChangesView(req({ role: 'Postdoc', pillars: ['A'], contactEmail: 'inv@x.org', changes: { status: 'asked', note: 'Fix it', byName: 'Inviter', keyHash: 'h', by: 'inv@x.org' } }));
  assert.deepStrictEqual(v, { name: 'Ada Byron', email: 'ada@x.org', role: 'Postdoc', pillars: ['A'], note: 'Fix it', byName: 'Inviter', inviter: { id: 'U1', name: 'Inviter' } });
});
