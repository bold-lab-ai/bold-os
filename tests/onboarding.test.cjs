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

test('everyone: details and the BOLDiquette (the tour is optional)', () => {
  assert.deepStrictEqual(keys(onboardingSteps('pan', {})), ['details', 'read']);
  assert.strictEqual(onboardingSteps('pan', {}).done, false);
});

const series = [
  { id: 'rg', title: 'BOLD Reading Group', requiredFor: 'internal', invite: { mode: 'join' }, joined: ['me@x.org'] },
  { id: 'hs', title: 'Hamming Sessions', requiredFor: 'internal', invite: { mode: 'group', group: 'internal' }, joined: [] },
  { id: 'gm', title: 'Group meeting', requiredFor: 'associate', invite: { mode: 'join' }, joined: [] },
  { id: 'fest', title: 'Festival', requiredFor: '', invite: null, joined: [] },
  { id: 'hid', title: 'Hidden one', requiredFor: 'internal', hidden: true },
];

test('BOLD-associate: join a project or register one', () => {
  assert.deepStrictEqual(keys(onboardingSteps('associate', { series })), ['details', 'read', 'project']);
  const step = (f) => onboardingSteps('associate', f).steps.find((s) => s.key === 'project').done;
  assert.strictEqual(step({ inProject: true }), true);
  assert.strictEqual(step({ owns: true }), true);
  assert.strictEqual(step({}), false);
});

test('BOLD-internal and up: own a project, and join every series required for their group', () => {
  assert.deepStrictEqual(keys(onboardingSteps('internal', { series })), ['details', 'read', 'own', 'series:rg', 'series:gm', 'series:hs']);
  const r = onboardingSteps('internal', { email: 'Me@x.org', series, inProject: true });
  const by = Object.fromEntries(r.steps.map((s) => [s.key, s.done]));
  assert.strictEqual(by.own, false, 'joining one isn’t owning one');
  assert.strictEqual(by['series:rg'], true, 'joined');
  assert.strictEqual(by['series:hs'], true, 'invites their whole group');
  assert.strictEqual(by['series:gm'], false, 'not joined yet');
  assert.deepStrictEqual(keys(onboardingSteps('exec', { series })), ['details', 'read', 'own', 'series:rg', 'series:gm', 'series:hs']);
  assert.deepStrictEqual(keys(onboardingSteps('pan', { series })), ['details', 'read'], 'PAN-BOLD has none of these');
});

test('ticked from what BOLD.OS knows', () => {
  const r = onboardingSteps('internal', { email: 'me@x.org', member, read: true, owns: true,
    series: series.map((x) => x.id === 'gm' ? Object.assign({}, x, { joined: ['me@x.org'] }) : x) });
  assert.strictEqual(r.done, true);
  assert.strictEqual(onboardingSteps('pan', { member: Object.assign({}, member, { pillars: [] }), read: true }).done, false, 'pillars needed');
  assert.strictEqual(onboardingSteps('pan', { member: Object.assign({}, member, { invitedBy: null }), read: true }).done, false, 'who invited them needed');
  assert.strictEqual(onboardingSteps('pan', { member: Object.assign({}, member, { role: 'PI', invitedBy: null }), read: true }).done, true, 'not for a PI');
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

// A group's first week (trialCheck, 2026-11-03): each timer does something only for the trial it
// was set for, while it's open, the person still in that group and something still left.
test('a first week’s timers: remind on day 5, end on day 7, nothing once done or superseded', () => {
  const { trialAction, trialTexts, stepsLeft } = require('../functions/index.js')._internal;
  const trial = { group: 'internal', startedAt: 100 }, data = { group: 'internal', startedAt: 100 };
  const left = { done: false, steps: [{ label: 'Join BOLD Reading Group', done: false }, { label: 'Register a project of your own', done: true }] };
  assert.strictEqual(trialAction('remind', trial, data, 'internal', left), 'remind');
  assert.strictEqual(trialAction('end', trial, data, 'internal', left), 'end');
  assert.strictEqual(trialAction('end', trial, data, 'internal', { done: true, steps: [] }), 'done', 'all done: closed quietly');
  assert.strictEqual(trialAction('end', Object.assign({}, trial, { done: true }), data, 'internal', left), 'nothing', 'done already');
  assert.strictEqual(trialAction('end', Object.assign({}, trial, { startedAt: 200 }), data, 'internal', left), 'nothing', 'a newer trial');
  assert.strictEqual(trialAction('end', trial, data, 'staff', left), 'nothing', 'in another group now');
  assert.strictEqual(trialAction('end', null, data, 'internal', left), 'nothing');
  assert.deepStrictEqual(stepsLeft(left), ['join BOLD Reading Group']);
  const t = trialTexts('BOLD-internal', stepsLeft(left), 'Ari');
  assert.match(t.remind, /Two days left/); assert.match(t.end, /PIs and admins have been told/); assert.match(t.staff, /^⌛ Ari/);
});

test('only who was newly added to a list counts (onProjectJoined, onSeriesJoined)', () => {
  const { addedTo } = require('../functions/index.js')._internal;
  assert.deepStrictEqual(addedTo({ joined: ['A@x.org'] }, { joined: ['a@x.org', 'B@x.org'] }, 'joined'), ['b@x.org']);
  assert.deepStrictEqual(addedTo(null, { members: ['c@x.org'] }, 'members'), ['c@x.org']);
  assert.deepStrictEqual(addedTo({ joined: ['a@x.org'] }, null, 'joined'), []);
});
