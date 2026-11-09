// #174: Slack channels follow BOLD.OS (alignmentPlan, alignmentMessage).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { alignmentPlan, alignmentMessage } = require('../functions/index.js')._internal;

const groups = { channels: { internal: 'bold-internal', associate: 'bold-associates', exec: 'exec-pis-only' } };
const people = { UPI: { email: 'pi@x.org', name: 'Pat PI' }, UIN: { email: 'in@x.org', name: 'Ines In' }, UAS: { email: 'as@x.org', name: 'Ari As' },
  UNR: { email: 'nr@x.org', name: 'Nora Norecord' } };
const members = { 'in@x.org': { category: 'internal' }, 'as@x.org': { category: 'associate' } };
const base = { people, members, full: ['pi@x.org'], groups, bots: ['UBOT'],
  projects: [{ channel: '#proj-a', pid: 'a', title: 'Project A', url: 'https://x/project.html#id=a', people: ['in@x.org'] }] };

test('each channel keeps who it is for, PIs and bots', () => {
  const plan = alignmentPlan(Object.assign({ channels: { 'bold-internal': ['UPI', 'UIN', 'UAS', 'UNR', 'UBOT'], 'bold-associates': ['UIN', 'UAS', 'UNR'] } }, base));
  const by = Object.fromEntries(plan.map((p) => [p.slackId, p.channels]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['UAS', 'UNR']);
  assert.deepStrictEqual(by.UAS, [{ name: 'bold-internal', why: 'group', group: 'BOLD-associate', for: 'BOLD-internal' }]);
  assert.deepStrictEqual(by.UNR.map((c) => c.name + ':' + c.why), ['bold-associates:no-record', 'bold-internal:no-record']);
});
test('a project channel is for its people; an account from elsewhere leaves', () => {
  const plan = alignmentPlan(Object.assign({ channels: { 'proj-a': ['UIN', 'UAS', 'UEXT'] }, outside: { UEXT: 'Ext Person' } }, base));
  assert.deepStrictEqual(plan.map((p) => p.slackId + ':' + p.channels[0].why), ['UAS:project', 'UEXT:outside']);
  assert.strictEqual(plan[1].name, 'Ext Person');
});
test('an excluded channel, or one that is neither a group’s nor a project’s, is left alone', () => {
  assert.deepStrictEqual(alignmentPlan(Object.assign({ channels: { 'bold-internal': ['UAS'], random: ['UAS'] }, exclude: ['bold-internal'] }, base)), []);
});
test('the message says where from, why and how to get back', () => {
  const t = alignmentMessage('Ari As', [{ name: 'bold-internal', why: 'group', group: 'BOLD-associate', for: 'BOLD-internal' },
    { name: 'proj-a', why: 'project', title: 'Project A', url: 'https://x/project.html#id=a' }]);
  assert.match(t, /^Hi Ari,/);
  assert.match(t, /#bold-internal: it’s for BOLD-internal and above; you’re BOLD-associate/);
  assert.match(t, /#proj-a: it’s for the people on <https:\/\/x\/project\.html#id=a\|Project A> on BOLD\.OS/);
  assert.match(t, /group-request\.html/);
  assert.match(t, /Working on <https:\/\/x\/project\.html#id=a\|Project A>\? Ask to join it on its page on BOLD\.OS; once you’re on it, you’re invited back to #proj-a\./);
  assert.match(t, /still on BOLD’s Slack, in every other channel/);
  assert.doesNotMatch(t, /Join BOLD\.OS/);
});
