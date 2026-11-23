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

test('Topics: projects about the same thing cluster together, the same way every time', () => {
  const items = [
    { pid: 'a', title: 'Evolution strategies for RL post-training [AMAZE]', keywords: ['eggroll', 'evolution strategies'] },
    { pid: 'b', title: 'EGGROLL theory', keywords: ['eggroll'] },
    { pid: 'c', title: 'Robots recover from damage [PAUSED]', keywords: ['robotics'] },
    { pid: 'd', title: 'Quadruped robots discover skills', keywords: ['robotics', 'open-endedness'] },
    { pid: 'e', title: 'Co-scientist agents', keywords: ['co-scientist'] },
    { pid: 'f', title: 'AutoKaggle co-scientist evaluation', keywords: ['co-scientist', 'evaluation'] },
  ];
  const c = R.clusters(items, 3);
  assert.strictEqual(c.of.a, c.of.b); assert.strictEqual(c.of.c, c.of.d); assert.strictEqual(c.of.e, c.of.f);
  assert.notStrictEqual(c.of.a, c.of.c); assert.notStrictEqual(c.of.c, c.of.e);
  assert.deepStrictEqual(R.clusters(items, 3), c);
  // A title's [tags] name no topic.
  assert.ok(!c.clusters.some((x) => x.terms.some((t) => /paused|amaze/.test(t))));
  // The board: rows in cards on either side never overlap; a moonshot sits in the middle, by its stepping stones.
  const board = R.topicBoard(items.concat([{ pid: 'm', level: 'moonshot' }, { pid: 'n', level: 'northstar' }]),
    [{ from: 'a', to: 'm' }, { from: 'b', to: 'm' }, { from: 'm', to: 'n' }], c, 1200);
  const rows = items.map((i) => board.pos[i.pid]);
  rows.forEach((p, i) => rows.forEach((q, j) => { if (i < j && p.x === q.x) assert.ok(Math.abs(p.y - q.y) >= 24); }));
  board.cards.forEach((x) => { assert.ok(x.x >= 0 && x.x + x.w <= 1200); });
  const m = board.pos.m, n = board.pos.n;
  assert.ok(m.x > board.cards[0].w && m.x < 1200 - board.cards[0].w, 'the moonshot is in the middle');
  assert.strictEqual(n.x, 600);
  assert.ok(Math.abs(m.y - (board.pos.a.y + board.pos.b.y) / 2) < 40, 'beside its stepping stones');
});

test('Topics as Prezi: a tree of topics (a big one split again), framed inside each other', () => {
  const items = [];
  ['eggroll', 'robotics', 'co-scientist'].forEach((k, j) => { for (let i = 0; i < (j === 0 ? 12 : 4); i++) items.push({ pid: k + i, title: k + ' project ' + i + (i % 2 ? ' theory' : ' practice'), keywords: [k, i % 2 ? 'theory' : 'practice'] }); });
  const tree = R.topicTree(items);
  assert.strictEqual(tree.id, 'all');
  const leaves = []; const walk = (n) => n.children ? n.children.forEach(walk) : leaves.push(n.pid);
  walk(tree);
  assert.deepStrictEqual(leaves.slice().sort(), items.map((i) => i.pid).sort(), 'every stepping stone, once');
  // No topic shows more than 8 stepping stones at once: a bigger one is split into sub-topics, not named by its words.
  const atMost = (n, depth) => { if (!n.children) return; if (depth > 0 && depth < 3) assert.ok(n.children.filter((c) => !c.children).length <= 8 || n.children.every((c) => !c.children) && n.children.length <= 8, n.id); n.children.forEach((c) => atMost(c, depth + 1)); };
  atMost(tree, 0);
  const many = items.slice(0, 12).map((i, x) => Object.assign({}, i, { pid: 'b' + x }));
  const one = R.topicTree(many.concat([{ pid: 'z1', title: 'robots', keywords: ['robotics'] }, { pid: 'z2', title: 'robots two', keywords: ['robotics'] }, { pid: 'z3', title: 'robots three', keywords: ['robotics'] }]));
  one.children.forEach((t) => { if (t.children.some((x) => x.children)) t.children.forEach((sub) => sub.terms.forEach((w) => assert.ok(!t.terms.includes(w)))); });
  const rect = R.frameLayout(tree, 1600, 1000);
  const inside = (a, b) => a.x >= b.x - 0.01 && a.y >= b.y - 0.01 && a.x + a.w <= b.x + b.w + 0.01 && a.y + a.h <= b.y + b.h + 0.01;
  const check = (n) => (n.children || []).forEach((c) => { assert.ok(inside(rect[c.id], rect[n.id]), c.id + ' inside ' + n.id); check(c); });
  check(tree);
  const kids = tree.children.map((c) => rect[c.id]);
  kids.forEach((a, i) => kids.forEach((b, j) => { if (i < j) assert.ok(a.x + a.w <= b.x + 0.01 || b.x + b.w <= a.x + 0.01 || a.y + a.h <= b.y + 0.01 || b.y + b.h <= a.y + 0.01, 'frames don’t overlap'); }));
});
