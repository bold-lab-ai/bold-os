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

test('Topics: the meaning map puts alike projects nearer, none overlapping, inside the canvas', () => {
  const items = [];
  ['eggroll', 'robotics', 'co-scientist'].forEach((k) => { for (let i = 0; i < 5; i++) items.push({ pid: k + i, title: k + ' study ' + i, keywords: [k] }); });
  const m = R.meaningMap(items, 1600, 1000);
  assert.deepStrictEqual(Object.keys(m).sort(), items.map((i) => i.pid).sort());
  const d = (a, b) => Math.hypot(m[a].x - m[b].x, m[a].y - m[b].y);
  Object.values(m).forEach((p) => assert.ok(p.x - p.r >= 0 && p.x + p.r <= 1600 && p.y - p.r >= 0 && p.y + p.r <= 1000));
  items.forEach((a, i) => items.forEach((b, j) => { if (i < j) assert.ok(d(a.pid, b.pid) >= 2 * m[a.pid].r - 0.5, 'overlap'); }));
  // On average, a project is nearer those with its keyword than those without.
  const mean = (xs) => xs.reduce((x, y) => x + y, 0) / xs.length;
  const same = [], other = [];
  items.forEach((a, i) => items.forEach((b, j) => { if (i < j) (a.keywords[0] === b.keywords[0] ? same : other).push(d(a.pid, b.pid)); }));
  assert.ok(mean(same) < mean(other));
  // Given how alike they mean (sim, Sofya's), it uses that: alike in meaning, near, whatever their words.
  const sim = (a, b) => (a[0] === 'e') === (b[0] === 'e') ? 1 : 0;
  const m2 = R.meaningMap(items, 1600, 1000, sim);
  assert.ok(Math.hypot(m2.eggroll0.x - m2.robotics0.x, m2.eggroll0.y - m2.robotics0.y) > Math.hypot(m2.robotics0.x - m2['co-scientist0'].x, m2.robotics0.y - m2['co-scientist0'].y));
  const links = R.nearLinks(items, 2, 0.12);
  assert.ok(links.length && links.every((l) => l.s >= 0.12 && l.a !== l.b));
  // Topics by meaning: the eggroll ones together, the rest together; named by their words.
  const byMeaning = R.clustersBySim(items, sim, 2);
  assert.strictEqual(new Set(items.filter((i) => i.pid[0] === 'e').map((i) => byMeaning.of[i.pid])).size, 1);
  assert.notStrictEqual(byMeaning.of.eggroll0, byMeaning.of.robotics0);
  assert.strictEqual(byMeaning.clusters[byMeaning.of.eggroll0].terms[0], 'eggroll');
});

test('Meaning: what a project is read from, and Sofya’s embedding model picked from its list', () => {
  const M = require('../functions/meaning.js')._internal;
  assert.strictEqual(M.textOf({ title: 'AutoKaggle [AMAZE]', keywords: ['co-scientist', 'evaluation'], abstract: ' Evals  for BOLD. ' }), 'AutoKaggle\nco-scientist, evaluation\nEvals for BOLD.');
  assert.strictEqual(M.embedModelOf([{ id: 'Qwen/Qwen3.8-27B-FP8' }]), '');
  assert.strictEqual(M.embedModelOf([{ id: 'Qwen/Qwen3.8-27B-FP8' }, { id: 'Qwen/Qwen3-Embedding-8B' }]), 'Qwen/Qwen3-Embedding-8B');
  const t = M.simTable(['a', 'b'], { a: [1, 0], b: [1, 1] });
  assert.deepStrictEqual(t, { ids: ['a', 'b'], sim: [[1, 0.707], [0.707, 1]] });
});
