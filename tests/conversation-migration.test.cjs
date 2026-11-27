const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readAssignments, planPost } = require('../scripts/migrate-conversation-topics.cjs');

test('the reviewed map rejects duplicate, malformed and unknown assignments before touching Firestore', () => {
  const row = { id: 'welcome', topicId: 'about-bold', pin: true };
  assert.deepEqual(readAssignments([row]).get('welcome'), row);
  for (const rows of [[], [row, row], [{ ...row, topicId: 'unknown' }], [{ ...row, id: 'a/b' }],
    [{ ...row, pinned: true }], [{ ...row, pin: false }]]) assert.throws(() => readAssignments(rows));
});

test('rerunning the assignment preserves subsequent unpins and topic moves', () => {
  const welcome = { id: 'welcome', topicId: 'about-bold', pin: true };
  const post = { private: true, readers: ['demo-reader'], project: 'demo', votes: { demo: 1 }, replies: 4 };
  const { patch } = planPost(post, welcome);
  assert.deepEqual(patch, { topicId: 'about-bold', pinned: true });
  assert.deepEqual(planPost({ ...post, ...patch }, welcome), { status: 'already set' });
  assert.deepEqual(planPost({ ...post, ...patch, pinned: false }, welcome), { status: 'already set' });
  assert.deepEqual(planPost({ ...post, topicId: 'custom-topic' }, welcome), { status: 'kept changed topic' });
});

test('after review, only proposals with known provenance get an automatic assignment', () => {
  assert.deepEqual(planPost({ source: 'proposal' }), { patch: { topicId: 'project-proposals' } });
  assert.deepEqual(planPost({ source: 'site', title: 'Proposal: sample' }), { status: 'awaiting review' });
  assert.deepEqual(planPost({ opened: true, replies: 0 }), { status: 'empty card thread' });
  assert.deepEqual(planPost({ opened: true, replies: 1 }), { status: 'awaiting review' });
});
