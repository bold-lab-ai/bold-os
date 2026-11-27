// Claim each due notice before contacting Slack. A crashed worker releases its claim after
// ten minutes. A confirmed refusal can retry; an uncertain Slack reply waits until next week.
const {needsVerifier} = require('./problem-category');
const WEEK = 7 * 24 * 60 * 60 * 1000;
const RETRY = 60 * 60 * 1000;
const LEASE = 10 * 60 * 1000;

async function sendDue(db, ref, send, now = Date.now()) {
  const claimedUntil = now + LEASE;
  const problem = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const p = snap.data();
    if (!p.reminders || !needsVerifier(p) || p.archived || p.evaluator || !Number.isFinite(p.verifierNoticeDue) || p.verifierNoticeDue > now) return;
    const cycle = p.verifierNoticeCycle ?? p.verifierNoticeDue;
    tx.update(ref, { verifierNoticeDue: claimedUntil, verifierNoticeCycle: cycle });
    return { id: ref.id, title: p.title, email: p.createdBy, cycle };
  });
  if (!problem) return false;
  let due = now + WEEK, retry = false;
  try {
    // Registration, archiving or changing the preference cancels a pending dispatch.
    if ((await ref.get()).data()?.verifierNoticeDue !== claimedUntil) return false;
    await send(problem);
  } catch (error) {
    if (error.definite) { due = now + RETRY; retry = true; }
    throw error;
  } finally {
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (snap.exists && snap.data().verifierNoticeDue === claimedUntil)
        tx.update(ref, { verifierNoticeDue: due, verifierNoticeCycle: retry ? problem.cycle : due });
    });
  }
  return true;
}
module.exports = { sendDue, WEEK };
