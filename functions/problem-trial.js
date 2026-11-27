// Comparing two ways of adding a problem (problem-new.html, 2026-11-24): talking it through with BOLD-LLM, or the
// form. Each person gets one by a hash of their email, fixed, and can switch. Per attempt it keeps only signals,
// never what was said: which way, when it started, switched, was saved, BOLD-LLM's failures, the turns, and how many
// fields they changed from BOLD's draft. problemTrials/{id}: server only; PIs and admins export it. Pure but the store.
'use strict';
const crypto = require('crypto');

const VARIANTS = ['chat', 'form'];
const FIELDS = ['title', 'significance', 'difficulties', 'existing_solutions', 'builds_benchmark', 'category', 'inspiration', 'collaborators', 'project_ids', 'parent_ids', 'related_ids'];

// Pure: the way someone gets, by their email: fixed, about half each.
function variantFor(email){
  const h = crypto.createHash('sha256').update('problem-trial:' + String(email || '').toLowerCase()).digest();
  return VARIANTS[h[0] % 2];
}
// Pure: how many of the fields differ between BOLD's last draft and what was saved.
function changedFields(bold, saved){
  if (!bold || !saved) return null;
  const norm = (v) => Array.isArray(v) ? v.slice().map(String).sort().join('|') : typeof v === 'string' ? v.trim() : v === true;
  return FIELDS.filter((k) => norm(bold[k]) !== norm(saved[k])).length;
}
// Pure: an attempt id from the page (a UUID), or throws.
function attemptId(id){
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) throw new Error('Supply the attempt id.');
  return id;
}

module.exports = function({ db }){
  const col = db.collection('problemTrials');
  // The page's events for one attempt → { variant }. start: { attempt }; switch: { attempt, to }; sofya_error;
  // turn; saved: { attempt, problem_id, bold, saved } (bold: BOLD's last draft, saved: what was saved).
  async function record(email, d){
    const id = attemptId(d.attempt), ref = col.doc(id), now = Date.now();
    return db.runTransaction(async (tx) => {
      const doc = await tx.get(ref), x = doc.exists ? doc.data() : null;
      if (x && x.email !== email) throw new Error('That attempt isn’t yours.');
      const base = x || { email, variant: variantFor(email), startedAt: now, way: null, switches: [], turns: 0, sofyaErrors: 0, savedAt: null, problemId: null, changedFields: null };
      if (!base.way) base.way = base.variant;
      if (d.event === 'switch') {
        if (VARIANTS.indexOf(d.to) < 0) throw new Error('Switch to chat or form.');
        if (d.to !== base.way) { base.switches = base.switches.concat([{ to: d.to, at: now, reason: d.reason === 'sofya' ? 'sofya' : 'choice' }]).slice(-20); base.way = d.to; }
      } else if (d.event === 'turn') base.turns = Math.min((base.turns || 0) + 1, 1000);
      else if (d.event === 'sofya_error') base.sofyaErrors = Math.min((base.sofyaErrors || 0) + 1, 1000);
      else if (d.event === 'saved') {
        base.savedAt = now; base.problemId = typeof d.problem_id === 'string' ? d.problem_id.slice(0, 40) : null;
        base.changedFields = changedFields(d.bold, d.saved);
      } else if (d.event !== 'start') throw new Error('Unknown event.');
      base.updatedAt = now;
      tx.set(ref, base);
      return { variant: base.variant, way: base.way };
    });
  }
  // Every attempt, for PIs and admins: one row each, emails as given (BOLD.OS's own data).
  async function list(){
    const snap = await col.get();
    return snap.docs.map((d) => Object.assign({ id: d.id }, d.data())).sort((a, b) => a.startedAt - b.startedAt);
  }
  return { record, list };
};
module.exports.variantFor = variantFor;
module.exports.changedFields = changedFields;
module.exports.VARIANTS = VARIANTS;
