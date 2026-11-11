// Branches of the site (#324): what a commit may be, how it's added to a page's part of a branch, and who decides.
const test = require('node:test');
const assert = require('node:assert');
const B = require('../functions/branches.js');

const ana = { email: 'ana@x.org', name: 'Ana' }, ben = { email: 'ben@x.org', name: 'Ben' };

test('the pages a branch can change', () => {
  assert.strictEqual(B.pageKey('handbook', 'boldiquette'), 'handbook/boldiquette');
  assert.strictEqual(B.pageKey('handbook', 'other'), null);
  assert.strictEqual(B.pageKey('guides', 'setup'), 'guides/setup');
  assert.strictEqual(B.pageKey('skills', 'paper-review'), 'skills/paper-review');
  assert.strictEqual(B.pageKey('agentTools', 'find'), 'agentTools/find');
  assert.strictEqual(B.pageKey('people', 'x'), null);
  assert.strictEqual(B.pageKey('guides', '../x'), null);
  const area = (s) => 'guide:' + s;
  assert.deepStrictEqual(['handbook/boldiquette', 'guides/setup', 'skills/a', 'agentTools/b'].map((p) => B.areaOf(p, area)), ['boldiquette', 'guide:setup', 'skills', 'tools']);
});

test('a commit needs a note and a kind its page has', () => {
  assert.throws(() => B.validChange('guides/setup', { kind: 'edit', partId: 'a', note: ' ' }), /Say what you changed/);
  assert.throws(() => B.validChange('guides/setup', { kind: 'skill', note: 'x' }), /Unknown kind/);
  assert.throws(() => B.validChange('guides/setup', { kind: 'access', note: 'x' }), /Unknown kind/);
  assert.throws(() => B.validChange('guides/setup', { kind: 'edit', note: 'x' }), /Which part/);
  assert.throws(() => B.validChange('skills/a', { kind: 'skill', note: 'x', after: { title: 't', code: 'no' } }), /isn’t a skill/);
  assert.deepStrictEqual(B.validChange('guides/setup', { kind: 'edit', partId: 'p1', before: { title: 'A', body: 'x' }, after: { title: 'A', body: 'y' }, note: ' Clearer ', extra: 1 }),
    { kind: 'edit', partId: 'p1', before: { title: 'A', body: 'x' }, after: { title: 'A', body: 'y' }, note: 'Clearer' });
  assert.deepStrictEqual(B.validChange('handbook/boldiquette', { kind: 'access', area: 'events', before: { view: 'a', edit: 'b' }, after: { view: 'c', edit: 'd' }, note: 'x' }).partId, 'access');
  assert.deepStrictEqual(B.validChange('agentTools/t', { kind: 'delete', note: 'Unused' }), { kind: 'delete', partId: '', before: null, after: null, note: 'Unused' });
});

test('commits on a page of parts: a batch, each commit with who and when', () => {
  const c1 = B.validChange('guides/setup', { kind: 'edit', partId: 'p1', before: { body: 'x' }, after: { body: 'y' }, note: 'One' });
  const q1 = B.withCommit(null, 'guides/setup', 'br1', c1, ana, 100);
  assert.deepStrictEqual(q1, { by: ana, at: 100, status: 'open', branch: 'br1', editedAt: 100, note: 'One', kind: 'batch', partId: '', before: null, after: null,
    changes: [Object.assign({}, c1, { by: ana, at: 100 })] });
  const c2 = B.validChange('guides/setup', { kind: 'add', partId: 'p2', after: { title: 'New', body: 'z' }, note: 'Two' });
  const q2 = B.withCommit(q1, 'guides/setup', 'br1', c2, ben, 200);
  assert.strictEqual(q2.by, ana);           // its first author stays
  assert.strictEqual(q2.at, 100);
  assert.strictEqual(q2.editedAt, 200);
  assert.deepStrictEqual(q2.changes.map((c) => [c.note, c.by.name, c.at]), [['One', 'Ana', 100], ['Two', 'Ben', 200]]);
  let q = q2;
  for (let i = 2; i < B.MAX_COMMITS; i++) q = B.withCommit(q, 'guides/setup', 'br1', c2, ana, 300 + i);
  assert.throws(() => B.withCommit(q, 'guides/setup', 'br1', c2, ana, 999), /50 commits/);
});

test('commits on a skill or tool: the whole of it as last committed, from what it was', () => {
  const was = { title: 'T', code: 'return 1' };
  const q1 = B.withCommit(null, 'agentTools/t', 'br', B.validChange('agentTools/t', { kind: 'tool', before: was, after: { title: 'T', code: 'return 2' }, note: 'a' }), ana, 1);
  const q2 = B.withCommit(q1, 'agentTools/t', 'br', B.validChange('agentTools/t', { kind: 'tool', before: { title: 'T', code: 'return 2' }, after: { title: 'T2', code: 'return 2' }, note: 'b' }), ben, 2);
  assert.deepStrictEqual(q2.before, was);
  assert.deepStrictEqual(q2.after, { title: 'T2', code: 'return 2' });
  assert.strictEqual(q2.kind, 'tool');
  assert.deepStrictEqual(q2.commits.map((c) => c.note), ['a', 'b']);
  // A new one stays new; a removal is the last word.
  const n1 = B.withCommit(null, 'skills/s', 'br', B.validChange('skills/s', { kind: 'new', after: { title: 'S', body: 'x' }, note: 'a' }), ana, 1);
  assert.strictEqual(B.withCommit(n1, 'skills/s', 'br', B.validChange('skills/s', { kind: 'skill', after: { title: 'S', body: 'y' }, note: 'b' }), ana, 2).kind, 'new');
  assert.strictEqual(B.withCommit(q2, 'agentTools/t', 'br', B.validChange('agentTools/t', { kind: 'delete', note: 'c' }), ana, 3).kind, 'delete');
});

test('who decides, and who withdraws', () => {
  const b = { status: 'open', by: ana, contributors: ['ana@x.org', 'ben@x.org'] };
  assert.match(B.cannotDecide(b, 'cy@x.org', false), /Only PIs/);
  assert.match(B.cannotDecide(b, 'Ben@x.org', true), /committed to it/);
  assert.strictEqual(B.cannotDecide(b, 'cy@x.org', true), '');
  assert.match(B.cannotDecide(Object.assign({}, b, { status: 'accepted' }), 'cy@x.org', true), /already/);
  assert.strictEqual(B.canWithdraw(b, 'ana@x.org', false), true);
  assert.strictEqual(B.canWithdraw(b, 'ben@x.org', false), false);
  assert.strictEqual(B.canWithdraw(b, 'ben@x.org', true), true);
});

test('a branch’s commits across its pages, in order', () => {
  const g = B.withCommit(null, 'guides/a', 'b', B.validChange('guides/a', { kind: 'remove', partId: 'p', note: 'g1' }), ana, 10);
  const g2 = B.withCommit(g, 'guides/a', 'b', B.validChange('guides/a', { kind: 'remove', partId: 'q', note: 'g2' }), ben, 30);
  const s = B.withCommit(null, 'skills/s', 'b', B.validChange('skills/s', { kind: 'skill', after: { body: 'x' }, note: 's1' }), ana, 20);
  assert.deepStrictEqual(B.commitsOf({ 'guides/a': g2, 'skills/s': s }).map((c) => [c.page, c.note, c.by.name]),
    [['guides/a', 'g1', 'Ana'], ['skills/s', 's1', 'Ana'], ['guides/a', 'g2', 'Ben']]);
});
