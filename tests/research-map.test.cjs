// Northstars, moonshots and stepping stones (#248): functions/research-map.js.
const test = require('node:test');
const assert = require('node:assert');
const R = require('../functions/research-map.js');

test('a card without a level is a stepping stone', () => {
  assert.strictEqual(R.levelOf({}), 'project');
  assert.strictEqual(R.levelOf({ level: 'moonshot' }), 'moonshot');
  assert.strictEqual(R.levelOf({ level: 'galaxy' }), 'project');
});

test('each level is part of the one above', () => {
  assert.strictEqual(R.parentLevel('project'), 'moonshot');
  assert.strictEqual(R.parentLevel('moonshot'), 'northstar');
  assert.strictEqual(R.parentLevel('northstar'), null);
  assert.strictEqual(R.childLevel('northstar'), 'moonshot');
});

test('links are required: a moonshot needs a northstar, a stepping stone a moonshot or a problem', () => {
  assert.strictEqual(R.linkIssue({ level: 'northstar' }), '');
  assert.match(R.linkIssue({ level: 'moonshot' }), /northstar/);
  assert.strictEqual(R.linkIssue({ level: 'moonshot', parents: ['n1'] }), '');
  assert.match(R.linkIssue({ level: 'project' }), /moonshot/);
  assert.strictEqual(R.linkIssue({ level: 'project', problems: ['p1'] }), '');
  assert.strictEqual(R.linkIssue({ parents: ['m1'] }), '');
  // A moonshot doesn't explore problems: they don't count for it.
  assert.match(R.linkIssue({ level: 'moonshot', problems: ['p1'] }), /northstar/);
});

test('normalizeLinks drops bad ids, duplicates, and a northstar’s links', () => {
  const n = R.normalizeLinks({ level: 'project', parents: ['a', 'a', 'bad id', '', 'b'], problems: ['x'], connection: '  why  ' });
  assert.deepStrictEqual(n, { level: 'project', parents: ['a', 'b'], problems: ['x'], connection: 'why' });
  assert.deepStrictEqual(R.normalizeLinks({ level: 'northstar', parents: ['a'], connection: 'x' }), { level: 'northstar', parents: [], problems: [], connection: '' });
  assert.match(R.linkIssue({ level: 'project', parents: Array.from({ length: 21 }, (_, i) => 'm' + i) }), /At most/);
});

test('linked: what the Projects page marks Not linked yet', () => {
  assert.ok(R.linked({ level: 'northstar' }));
  assert.ok(!R.linked({}));
  assert.ok(R.linked({ problems: ['p'] }));
  assert.ok(!R.linked({ level: 'moonshot', problems: ['p'] }));
});

test('buildMap links only to the level above, and leaves out what isn’t there', () => {
  const map = R.buildMap([
    { pid: 'n1', title: 'N', level: 'northstar' },
    { pid: 'm1', title: 'M', level: 'moonshot', parents: ['n1', 'gone'] },
    { pid: 'p1', title: 'P', parents: ['m1', 'n1'], problems: ['q1'] },
    { pid: 'p2', title: 'P2' },
  ], [{ id: 'q1', title: 'Q', project: 'p2' }, { id: 'q2', title: 'Q2', project: '' }]);
  const edges = map.edges.map((e) => e.from + '>' + e.to + ':' + e.kind).sort();
  assert.deepStrictEqual(edges, ['m1>n1:part', 'p1>m1:part', 'p1>problem:q1:explores', 'problem:q1>p2:problem'].sort());
  assert.strictEqual(map.nodes.length, 6);
});

test('lineage: everything above and below', () => {
  const map = R.buildMap([
    { pid: 'n1', level: 'northstar' }, { pid: 'n2', level: 'northstar' },
    { pid: 'm1', level: 'moonshot', parents: ['n1'] }, { pid: 'm2', level: 'moonshot', parents: ['n2'] },
    { pid: 'p1', parents: ['m1'] }, { pid: 'p2', parents: ['m2'] },
  ], []);
  assert.deepStrictEqual(Object.keys(R.lineage(map, 'm1')).sort(), ['m1', 'n1', 'p1']);
  assert.deepStrictEqual(Object.keys(R.lineage(map, 'n2')).sort(), ['m2', 'n2', 'p2']);
});

test('a northstar or moonshot isn’t joined: its announcement has no Join link', () => {
  const { projectAnnouncement } = require('../functions/index.js')._internal;
  const card = { title: 'T', submittedBy: { name: 'A' } };
  assert.match(projectAnnouncement(card, 'https://x/p'), /Join the project/);
  const m = projectAnnouncement(Object.assign({ level: 'moonshot' }, card), 'https://x/p');
  assert.doesNotMatch(m, /Join the project/);
  assert.match(m, /a new moonshot/);
});
