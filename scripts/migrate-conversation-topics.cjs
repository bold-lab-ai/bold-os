// Run after the topic-aware reader ships. Install functions/ dependencies first.
// node scripts/migrate-conversation-topics.cjs --project PROJECT_ID --map /private/path/assignments.json
// Inspect the dry run, then repeat with --apply. FIRESTORE_EMULATOR_HOST selects a local emulator.
// Keep the real map outside the public repo. Example using a fictional conversation:
// [{"id":"welcome-demo","topicId":"about-bold","pin":true}]
'use strict';
const { readFileSync } = require('node:fs');
const { parseArgs } = require('node:util');
const { starters, topicOf } = require('../functions/conversation-topics');

function readAssignments(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('Expected an array of reviewed assignments.');
  const assignments = new Map();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id.trim() || row.id.includes('/') ||
        !starters.some(topic => topic.id === row.topicId) ||
        Object.keys(row).some(key => !['id', 'topicId', 'pin'].includes(key)) ||
        ('pin' in row && row.pin !== true)) throw new Error('Invalid assignment: ' + JSON.stringify(row));
    if (assignments.has(row.id)) throw new Error('Duplicate conversation: ' + row.id);
    assignments.set(row.id, row);
  }
  return assignments;
}

function planPost(post, assignment) {
  const topicId = assignment?.topicId || topicOf(post);
  if (!topicId) return { status: post.opened && !post.replies ? 'empty card thread' : 'awaiting review' };
  if (post.topicId && post.topicId !== topicId) return { status: 'kept changed topic' };
  const patch = {};
  if (!post.topicId) patch.topicId = topicId;
  // The UI writes false on unpin. An explicit choice survives every later run.
  if (assignment?.pin && post.pinned === undefined) patch.pinned = true;
  return Object.keys(patch).length ? { patch } : { status: 'already set' };
}

function millis(at) { return typeof at === 'number' ? at : at?.toMillis?.() || 0; }

async function migrate(db, assignments, apply, log) {
  const totals = {};
  function record(status) { totals[status] = (totals[status] || 0) + 1; }
  for (const { id, name, icon } of starters) {
    const topic = db.collection('conversationTopics').doc(id);
    if ((await topic.get()).exists) continue;
    log('Create topic ' + name);
    if (apply) {
      try { await topic.create({ name, icon }); }
      catch (err) { if (err.code === 6) continue; throw err; } // Created concurrently.
    }
    record('create topic');
  }
  const snapshot = await db.collection('conversations')
    .select('topicId', 'source', 'pinned', 'opened', 'replies', 'lastAt', 'at').get();
  const missing = new Set(assignments.keys());
  for (const doc of snapshot.docs) {
    missing.delete(doc.id);
    const post = doc.data();
    const { patch, status } = planPost(post, assignments.get(doc.id));
    if (!patch) {
      record(status);
      if (status === 'awaiting review' || status === 'kept changed topic') log(doc.id + ': ' + status);
      continue;
    }
    // Older threads have a reply count but no activity timestamp. Slack imports
    // and site replies can use different timestamp types in the same collection.
    if (patch.topicId && post.replies > 0 && post.lastAt == null) {
      const replies = await doc.ref.collection('messages').select('at').get();
      const latest = replies.docs.reduce((max, reply) => Math.max(max, millis(reply.get('at'))), 0);
      if (latest > millis(post.at)) patch.lastAt = latest;
    }
    log(doc.id + ' ' + JSON.stringify(patch));
    if (apply) {
      // A vote, move, unpin or deletion since the scan must not be overwritten.
      // Re-running reevaluates the current document and resumes partial runs.
      try { await doc.ref.update(patch, { lastUpdateTime: doc.updateTime }); }
      catch (err) {
        if (err.code !== 5 && err.code !== 9) throw err;
        log(doc.id + ': changed during migration; rerun to reconcile');
        record('changed during migration');
        continue;
      }
    }
    record('update conversation');
    if (patch.pinned) record('pin');
  }
  for (const id of missing) { log(id + ': reviewed conversation missing'); record('missing'); }
  return totals;
}

async function main() {
  const { values } = parseArgs({ options: { project: { type: 'string' }, map: { type: 'string' }, apply: { type: 'boolean' } } });
  if (!values.project || !values.map) throw new Error('Pass --project PROJECT_ID and --map /path/to/assignments.json. The default is a dry run.');
  const assignments = readAssignments(JSON.parse(readFileSync(values.map, 'utf8')));
  const admin = require('../functions/node_modules/firebase-admin');
  const app = admin.initializeApp({ projectId: values.project });
  try {
    console.log(values.apply ? 'Applying' : 'Dry run', values.project, process.env.FIRESTORE_EMULATOR_HOST || '(cloud)', '—', assignments.size, 'reviewed');
    const totals = await migrate(app.firestore(), assignments, values.apply, console.log);
    console.log(totals);
    if (totals['changed during migration']) process.exitCode = 1;
  } finally { await app.delete(); }
}

module.exports = { readAssignments, planPost, migrate };
if (require.main === module) main().catch(err => { console.error(err.message); process.exitCode = 1; });
