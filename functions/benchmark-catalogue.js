'use strict';

const PAGE_SIZE = 25;
const RELEASE_ID = /^ak-[a-f0-9]{24}-[a-f0-9]{40}$/;

// Serve only the fields displayed in the catalogue. Full evidence stays on the release page.
async function listBenchmarkReleases(db, data, error) {
  let query = db.collection('benchmarks').orderBy('createdAt', 'desc').orderBy('__name__', 'desc');
  if (data.cursor != null) {
    const { id, at } = data.cursor;
    if (typeof id !== 'string' || !RELEASE_ID.test(id) || !Number.isSafeInteger(at) || at < 0) {
      throw error('invalid-argument', 'Invalid benchmark page cursor.');
    }
    query = query.startAfter(at, id);
  }
  const snap = await query.limit(PAGE_SIZE + 1).select('problem_id', 'title', 'stage', 'evaluator.version', 'createdAt').get();
  const rows = snap.docs.slice(0, PAGE_SIZE).map(doc => ({ id: doc.id, ...doc.data() }));
  const problemIds = [...new Set(rows.map(row => row.problem_id))];
  const refs = problemIds.map(id => db.collection('problemBank').doc(id));
  const problems = refs.length ? await db.getAll(...refs, { fieldMask: ['archived', 'title'] }) : [];
  const active = new Map(problems.filter(p => p.exists && !p.get('archived')).map(p => [p.id, p.get('title')]));
  const items = rows.filter(row => active.has(row.problem_id)).map(row => ({
    id: row.id, title: row.title, problem_id: row.problem_id, problem_title: active.get(row.problem_id),
    stage: row.stage, version: row.evaluator.version
  }));
  const last = rows[rows.length - 1];
  return { items, cursor: snap.size > PAGE_SIZE ? { id: last.id, at: last.createdAt } : null };
}

module.exports = { listBenchmarkReleases };
