// The Projects page's "Join the project" button must not be offered on a project the viewer
// already joined. Two halves: getAllProjects marks those projects `joined` (markJoined), and
// the page turns `joined` into a greyed-out "Joined" (BoldProjectJoin.joinState).
// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { markJoined, projectTitlesOnly } = require('../functions/index.js')._internal;

function clientJoinState(){
  const ctx = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/assets/js/project-join.js'), 'utf8'), ctx);
  return (p) => ({ ...ctx.BoldProjectJoin.joinState(p) });   // a plain object of this realm
}

const list = () => ({
  ongoing: [{ pid: 'a', title: 'Joined, ongoing' }, { pid: 'b', title: 'Not joined' }],
  submission: [],
  completed: [{ pid: 'c', title: 'Joined, completed' }],
  planned: [{ pid: 'd', title: 'Not joined, planned' }],
});

test('getAllProjects marks every project the caller joined, in every group', () => {
  const out = markJoined(list(), { a: true, c: true });
  assert.strictEqual(out.ongoing[0].joined, true);
  assert.strictEqual(out.completed[0].joined, true);
  assert.ok(!out.ongoing[1].joined);
  assert.ok(!out.planned[0].joined);
  assert.strictEqual(out.v, 2, 'v 2 makes the page refetch a list cached before `joined` existed');
});

test('a viewer who sees titles only still gets their own projects in full, marked joined', () => {
  const out = markJoined(projectTitlesOnly(list(), { a: true }), { a: true });
  assert.strictEqual(out.ongoing[0].joined, true);
  assert.ok(!out.ongoing[0].titleOnly);
  assert.ok(out.ongoing[1].titleOnly && !out.ongoing[1].joined);
});

test('the page offers to join only a project the viewer is not on', () => {
  const joinState = clientJoinState();
  const marked = markJoined(list(), { a: true });
  assert.deepStrictEqual(joinState(marked.ongoing[0]), { label: 'Joined', disabled: true, title: 'You’re on this project' });
  assert.deepStrictEqual(joinState(marked.ongoing[1]), { label: 'Join the project', disabled: false, title: '' });
});

test('the page refetches a cached list from before `joined` (no v 2)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/assets/js/pages/projects.js'), 'utf8');
  assert.match(src, /function hasAuthors\(d\)\{\s*return d\.v >= 2 &&/);
});

test('PAN-BOLD talks to the owner instead of asking to join (2026-11-03)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/assets/js/project-join.js'), 'utf8');
  const ctx = {}; require('node:vm').runInNewContext(src, ctx);
  const st = ctx.BoldProjectJoin.joinState({ talk: { name: 'Ann Lead', slackId: 'U1' } });
  assert.strictEqual(st.label, 'Talk to its owner');
  assert.strictEqual(st.talk.slackId, 'U1');
  assert.strictEqual(ctx.BoldProjectJoin.joinState({ talk: { name: 'Ann' }, joined: true }).label, 'Joined', 'on it already');
});
