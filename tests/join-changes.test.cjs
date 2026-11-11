// Proposing changes to a request to join (joinChanges, #261).
const test = require('node:test');
const assert = require('node:assert');
const { joinChangesRefusal, joinChangesKeyRefusal, joinChangesEmail, joinChangesView, joinChangesProposed, joinChangesLines, keyHash } = require('../functions/index.js')._internal;

const req = (o) => Object.assign({ name: 'Ada Byron', email: 'ada@x.org', status: 'open', invitedBy: { id: 'U1', name: 'Inviter', email: 'inv@x.org' } }, o);

test('only whoever decides a request proposes changes, while it is open, with a change or a note', () => {
  assert.strictEqual(joinChangesRefusal(req(), { email: 'inv@x.org' }, 'Your end date, please'), '');
  assert.match(joinChangesRefusal(req(), { email: 'other@x.org' }, 'x'), /Only whoever invited them/);
  // PIs and admins only a request that names nobody, as for deciding it.
  assert.match(joinChangesRefusal(req(), { email: 'pi@x.org', full: true }, 'x'), /Only whoever invited them/);
  assert.strictEqual(joinChangesRefusal(req({ invitedBy: null }), { email: 'pi@x.org', full: true }, 'x'), '');
  assert.match(joinChangesRefusal(req({ status: 'approved' }), { email: 'inv@x.org' }, 'x'), /already been approved/);
  assert.match(joinChangesRefusal(req(), { email: 'inv@x.org' }, '   ', {}), /Change an answer/);
  assert.strictEqual(joinChangesRefusal(req(), { email: 'inv@x.org' }, '', { role: 'Postdoc' }), '');
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

test('only answers that differ are proposed, each as a line', () => {
  const q = req({ role: 'Visitor', endDate: '', pillars: ['A'], listOnWebsite: false, institution: 'UCL' });
  const p = joinChangesProposed(q, { name: 'Ada Byron', email: 'ada@x.org', role: 'Postdoc', endDate: '2029-09-30', pillars: ['A'], listOnWebsite: true, institution: 'UCL', feedback: '' });
  assert.deepStrictEqual(p, { role: 'Postdoc', endDate: '2029-09-30', listOnWebsite: true });
  assert.deepStrictEqual(joinChangesLines(q, p), ['Role at BOLD: Visitor → Postdoc', 'End date: — → 2029-09-30', 'Listed on the BOLD website: no → yes']);
});

test('the pages list the same changes as the server', () => {
  const vm = require('vm'), fs = require('fs'), ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(require('path').join(__dirname, '../src/assets/js/join-changes.js'), 'utf8'), ctx);
  const q = req({ role: 'Visitor', pillars: [], listOnWebsite: false }), next = { role: 'Postdoc', pillars: ['B'], listOnWebsite: false, name: 'Ada Byron' };
  const client = ctx.window.BoldJoinChanges.proposed(q, next);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(client)), joinChangesProposed(q, next));
  assert.deepStrictEqual(Array.from(ctx.window.BoldJoinChanges.lines(q, client)), joinChangesLines(q, joinChangesProposed(q, next)));
});

test('the email lists the changes, then the note, and carries the link', () => {
  const m = joinChangesEmail(req({ role: 'Visitor' }), 'Your end date\nand pillars', 'https://site/join.html?changes=r1&key=k', 'Inviter', { role: 'Postdoc' });
  assert.match(m.subject, /Inviter proposes changes/);
  assert.match(m.body, /^Hi Ada,/);
  assert.match(m.body, /  • Role at BOLD: Visitor → Postdoc/);
  assert.match(m.body, /They add:\n {2}Your end date\n {2}and pillars/);
  assert.match(m.body, /https:\/\/site\/join\.html\?changes=r1&key=k/);
  // A note alone.
  assert.match(joinChangesEmail(req(), 'Fix the dates', 'L', 'Inviter', {}).body, /decide\.\n\nThey say:\n {2}Fix the dates/);
});

test('the applicant sees their answers, the proposed ones and the note, never the key or who decided anything else', () => {
  const v = joinChangesView(req({ role: 'Visitor', pillars: ['A'], contactEmail: 'inv@x.org', changes: { status: 'asked', proposed: { role: 'Postdoc' }, note: 'Fix it', byName: 'Inviter', keyHash: 'h', by: 'inv@x.org' } }));
  assert.deepStrictEqual(v, { name: 'Ada Byron', email: 'ada@x.org', role: 'Visitor', pillars: ['A'], proposed: { role: 'Postdoc' }, lines: ['Role at BOLD: Visitor → Postdoc'],
    note: 'Fix it', byName: 'Inviter', inviter: { id: 'U1', name: 'Inviter' } });
});
