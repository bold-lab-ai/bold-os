'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const admin = require('../functions/node_modules/firebase-admin');
const { listBenchmarkReleases } = require('../functions/benchmark-catalogue');

test('catalogue pages include active releases once and hide archived or missing problems', async () => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST || '', /^127\.0\.0\.1:\d+$/);
  assert.equal(process.env.GCLOUD_PROJECT, 'demo-bold-os');
  const app = admin.initializeApp({ projectId: 'demo-bold-os' }, randomUUID());
  const firestore = app.firestore();
  const scope = firestore.collection('catalogueTests').doc(randomUUID());
  const db = { collection: name => scope.collection(name), getAll: firestore.getAll.bind(firestore) };
  const error = (code, message) => Object.assign(new Error(message), { code });
  const problem = 'ak-' + '1'.repeat(24);
  const hidden = 'ak-' + '2'.repeat(24), missing = 'ak-' + '3'.repeat(24);
  try {
    let result = await listBenchmarkReleases(db, {}, error);
    assert.deepEqual(result, { items: [], cursor: null });
    const batch = firestore.batch();
    batch.set(db.collection('problemBank').doc(problem), { title: 'Example problem' });
    batch.set(db.collection('problemBank').doc(hidden), { title: 'Archived problem', archived: true });
    for (let i = 0; i < 28; i++) {
      const parent = i === 26 ? missing : i === 27 ? hidden : problem;
      const id = parent + '-' + i.toString(16).padStart(40, '0');
      batch.set(db.collection('benchmarks').doc(id), {
        problem_id: parent, createdAt: 100, title: 'Example release', stage: 'checked',
        evaluator: { version: i + 1 }, createdBy: 'private@example.invalid'
      });
    }
    await batch.commit();
    result = await listBenchmarkReleases(db, {}, error);
    assert.ok(result.cursor);
    const next = await listBenchmarkReleases(db, { cursor: result.cursor }, error);
    assert.equal(next.cursor, null);
    const rows = result.items.concat(next.items);
    assert.equal(rows.length, 26);
    assert.equal(new Set(rows.map(r => r.id)).size, 26);
    assert.equal(rows[0].version, 26);
    assert.ok(rows.every(r => r.problem_id === problem && r.problem_title === 'Example problem' && !('createdBy' in r)));
    await assert.rejects(listBenchmarkReleases(db, { cursor: { id: 'invalid', at: 1 } }, error), { code: 'invalid-argument' });
  } finally {
    await firestore.recursiveDelete(scope);
    await app.delete();
  }
});
