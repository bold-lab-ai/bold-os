// The join form's checks (join-common.js): each missing answer shown under its own field.
const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm'), fs = require('fs'), path = require('path');

const ctx = { window: {}, BOLD: { escapeHtml: (s) => String(s == null ? '' : s) } };
ctx.window.BOLD = ctx.BOLD;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/assets/js/join-common.js'), 'utf8'), ctx);
const J = ctx.window.BoldJoin;
const fields = (d) => Array.from(J.problems(d)).map((p) => p.field);

test('every missing answer of an empty join form, once each, in the form’s order', () => {
  const d = { name: '', email: '', institution: '', role: '', invitedBy: '', inviterTyped: '', contact: '', interests: '', startDate: '', endDate: '' };
  assert.deepStrictEqual(fields(d), ['jn-name', 'jn-email', 'jn-institution', 'jn-role', 'jn-inviter', 'jn-end', 'jn-interests']);
  // The point of contact: one message, saying to choose from the list once something's typed.
  assert.strictEqual(J.problems(Object.assign({}, d, { inviterTyped: 'Pat' })).filter((p) => p.field === 'jn-inviter')[0].msg, 'Choose them from the list as you type.');
  assert.strictEqual(J.problem(d), 'Give your full name.');
});

test('a filled form has none; roles without an end date need none; dates in order', () => {
  const ok = { name: 'Ada', email: 'ada@x.org', institution: 'UCL', role: 'Postdoc', invitedBy: 'U1', inviterTyped: 'Pat', contact: 'Pat', interests: 'RL', startDate: '2026-10-01', endDate: '2027-10-01' };
  assert.deepStrictEqual(fields(ok), []);
  assert.strictEqual(J.problem(ok), '');
  assert.deepStrictEqual(fields(Object.assign({}, ok, { role: 'PI', endDate: '' })), []);
  assert.deepStrictEqual(fields(Object.assign({}, ok, { endDate: '2026-01-01' })), ['jn-end']);
  assert.deepStrictEqual(fields(Object.assign({}, ok, { email: 'nope' })), ['jn-email']);
});

test('the profile’s form (no name, email or inviter box): its point of contact is the picker', () => {
  const d = { institution: 'UCL', role: 'Postdoc', contact: '', interests: 'RL', endDate: '2027-01-01', bookingUrl: 'http://x' };
  assert.deepStrictEqual(fields(d), ['jn-contact-pick', 'jn-booking']);
});
