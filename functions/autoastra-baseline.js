'use strict';

const crypto = require('node:crypto');
const RELEASE = /^ak-[a-f0-9]{24}-[a-f0-9]{40}$/;
const HEX32 = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const emailAddress = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function resultSummary(input, error) {
  const invalid = () => error('invalid-argument', 'Supply a baseline run ID, frozen candidate digest, metric, direction and two finite scores.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const {run_id, candidate_sha256, development_fitness, final_fitness, metric, direction} = input;
  if (Object.keys(input).length !== 6 || typeof run_id !== 'string' || !HEX32.test(run_id) ||
      typeof candidate_sha256 !== 'string' || !HEX64.test(candidate_sha256) ||
      !Number.isFinite(development_fitness) || !Number.isFinite(final_fitness) ||
      typeof metric !== 'string' || !metric.trim() || metric.length > 250 || /[\x00-\x1f\x7f]/.test(metric) ||
      !['minimize','maximize'].includes(direction)) throw invalid();
  return {run_id, candidate_sha256, development_fitness, final_fitness, metric:metric.trim(), direction};
}

async function changeBaseline({db, error, publicRow, full, canEdit, email}, input) {
  const {benchmark_id:id, action} = input;
  if (typeof id !== 'string' || !RELEASE.test(id)) throw error('invalid-argument', 'Select a pinned verifier release.');
  let claimHash, summary;
  if (action !== 'request_baseline') {
    if (!full) throw error('permission-denied', 'Only a PI or admin can operate the baseline worker.');
    if (typeof input.claim_key !== 'string' || !HEX64.test(input.claim_key)) throw error('invalid-argument', 'Supply a valid worker claim key.');
    claimHash = crypto.createHash('sha256').update(input.claim_key).digest('hex');
    if (action === 'finish_baseline') summary = resultSummary(input.summary, error);
  }
  const releaseRef = db.collection('benchmarks').doc(id);
  const jobRef = db.collection('autoastraBaselineJobs').doc(id);
  return db.runTransaction(async tx => {
    const [release, job] = await Promise.all([tx.get(releaseRef), tx.get(jobRef)]);
    if (!release.exists) throw error('not-found', 'The selected release does not exist.');
    const data = release.data(), state = job.exists ? job.data() : null;
    if (claimHash && state && state.claimHash &&
        (state.claimHash !== claimHash || state.claimedBy !== email)) {
      throw error('permission-denied', 'Another worker owns this request.');
    }
    if (action === 'finish_baseline' && state && state.status === 'completed' && state.claimHash === claimHash && state.claimedBy === email) {
      if (JSON.stringify(resultSummary(state.summary,error)) !== JSON.stringify(summary)) {
        throw error('already-exists', 'This release already has a different baseline result.');
      }
      // A lost reply can be retried even if the problem was archived after the result was saved.
      return {status:'completed'};
    }
    const problem = await tx.get(db.collection('problemBank').doc(data.problem_id));
    if (!problem.exists || problem.data().archived || data.stage !== 'validated' ||
        !data.approval || typeof data.approval.name !== 'string' || !data.approval.name.trim() ||
        !Number.isSafeInteger(data.approval.at) || data.approval.at <= 0) {
      throw error('failed-precondition', 'AutoAstra needs an active problem and a validated release approved in BOLD.OS.');
    }
    const now = Date.now();
    if (action === 'request_baseline') {
      if (!canEdit(problem)) throw error('permission-denied', 'Only the problem submitter, a PI or an admin can request a baseline.');
      if (!state) {
        const recipient = problem.data().createdBy;
        if (typeof recipient !== 'string' || recipient.length > 254 || !emailAddress.test(recipient)) {
          throw error('failed-precondition', 'The original problem submitter has no delivery address.');
        }
        tx.set(jobRef, {recipient, requestedBy:email, requestedAt:now, status:'pending'});
        tx.update(releaseRef, {baseline:{status:'pending'}});
      }
      return {status:state ? state.status : 'pending'};
    }
    if (!state) throw error('failed-precondition', 'Request the baseline on the problem page first.');
    if (action === 'claim_baseline') {
      if (!state.claimHash) {
        tx.update(jobRef, {status:'claimed', claimHash, claimedBy:email, claimedAt:now});
        tx.update(releaseRef, {baseline:{status:'claimed'}});
      }
      const row = publicRow(release);
      delete row.baseline; // A replay returns the same pinned release regardless of job progress.
      return {release:row, recipient:state.recipient};
    }
    if (state.status !== 'claimed') throw error('failed-precondition', 'The worker must claim the request first.');
    tx.update(jobRef, {status:'completed', summary, finishedAt:now});
    tx.update(releaseRef, {baseline:{status:'completed', summary}});
    return {status:'completed'};
  });
}

module.exports = {changeBaseline};
