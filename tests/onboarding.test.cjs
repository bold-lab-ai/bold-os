// Onboarding (Get started) and asking for another group, 2026-11-02:
// - onboardingSteps: the steps by group, each ticked from what BOLD.OS knows;
// - BoldJoin.groupSectionOf: a group's section of Who is BOLD, the terms someone accepts.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { onboardingSteps } = require('../functions/index.js')._internal;

const member = { role: 'PhD student', institution: 'UCL', interests: 'RL', pillars: ['Core'], startDate: '2026-10-01', invitedBy: { email: 'pi@x.org' } };
const keys = (r) => r.steps.map((s) => s.key);

test('everyone: details, the BOLDiquette and the tour', () => {
  assert.deepStrictEqual(keys(onboardingSteps('pan', {})), ['details', 'read', 'tour']);
  assert.strictEqual(onboardingSteps('pan', {}).done, false);
});

test('higher groups add a project, then an event series when there is one to join', () => {
  assert.deepStrictEqual(keys(onboardingSteps('associate', {})), ['details', 'read', 'tour', 'project']);
  assert.deepStrictEqual(keys(onboardingSteps('internal', {})), ['details', 'read', 'tour', 'project']);
  assert.deepStrictEqual(keys(onboardingSteps('internal', { openSeries: true })), ['details', 'read', 'tour', 'project', 'events']);
  assert.deepStrictEqual(keys(onboardingSteps('exec', { openSeries: true })), ['details', 'read', 'tour', 'project', 'events']);
});

test('ticked from what BOLD.OS knows', () => {
  const r = onboardingSteps('internal', { member, read: true, marks: { tour: 1 }, inProject: true, openSeries: true, inSeries: true });
  assert.strictEqual(r.done, true);
  assert.strictEqual(onboardingSteps('pan', { member: Object.assign({}, member, { pillars: [] }), read: true, marks: { tour: 1 } }).done, false, 'pillars needed');
  assert.strictEqual(onboardingSteps('pan', { member: Object.assign({}, member, { invitedBy: null }), read: true, marks: { tour: 1 } }).done, false, 'who invited them needed');
  assert.strictEqual(onboardingSteps('pan', { member: Object.assign({}, member, { role: 'PI', invitedBy: null }), read: true, marks: { tour: 1 } }).done, true, 'not for a PI');
});

test('a group\'s terms: its section of Who is BOLD, dedented, "For" headings too', () => {
  const ctx = { BOLD: { escapeHtml: (s) => s }, window: {} };
  ctx.window = ctx;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/assets/js/join-common.js'), 'utf8'), ctx);
  const body = 'Intro\n\n#### BOLD-internal\n- **Requirements**:\n    - Present\n\n#### For BOLD-associate:\n  - Contribute\n#### PAN-BOLD\n- Slack';
  assert.strictEqual(ctx.BoldJoin.groupSectionOf(body, 'internal'), '- **Requirements**:\n    - Present');
  assert.strictEqual(ctx.BoldJoin.groupSectionOf(body, 'associate'), '- Contribute');
  assert.strictEqual(ctx.BoldJoin.groupSectionOf(body, 'staff'), '');
});
