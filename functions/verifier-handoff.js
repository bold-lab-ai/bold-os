const crypto = require('node:crypto');

const CLAIM_WINDOW_MS = 10 * 60 * 1000;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const enabled = () => process.env.BOLD_LINKED_VERIFIER_HANDOFF_ENABLED === 'true';
const serviceHash = () => process.env.BOLD_LINKED_VERIFIER_SERVICE_TOKEN_SHA256 || '';
const configured = () => enabled() && HEX64.test(serviceHash());

const MEMBER_RATE_PER_MINUTE = 60;

// onClaimed(binding): after a session is first linked (not on a retry), e.g. to tell the member.
function verifierHandoffs(db, error, checkTarget, onClaimed) {
  const grants = db.collection('verifierHandoffs'), sessions = db.collection('verifierSessionClaims');
  function requireConfigured() {
    if (!configured()) throw error('failed-precondition','Linked Lite verifier handoffs are unavailable.');
  }
  async function issue(target, email) {
    requireConfigured();
    const handoff = crypto.randomBytes(32).toString('hex'), expires_at = Date.now() + CLAIM_WINDOW_MS;
    await db.runTransaction(async tx => {
      await checkTarget(tx,target);
      tx.set(grants.doc(sha(handoff)),{...target,email,expires_at,expireAt:new Date(expires_at),session_id:null});
    });
    return {handoff,expires_at};
  }
  async function claim({handoff,email,session_id}) {
    requireConfigured();
    if (typeof handoff !== 'string' || !HEX64.test(handoff) || typeof session_id !== 'string' || !UUID.test(session_id) ||
        typeof email !== 'string' || !email.trim() || email.length > 320)
      throw error('invalid-argument','Supply the BOLD handoff, the verified email and the Lite session ID.');
    const member = email.trim().toLowerCase(), grant = grants.doc(sha(handoff)), session = sessions.doc(session_id);
    const sourceKey = 'ak-' + sha('autokaggle:'+session_id).slice(0,24);
    const out = await db.runTransaction(async tx => {
      const [g, bound, stream, legacy] = await Promise.all([tx.get(grant),tx.get(session),
        tx.get(db.collection('benchmarkSources').doc(sourceKey)),tx.get(db.collection('problemBank').doc(sourceKey))]);
      // The short-lived grant may have been removed by TTL after a successful claim.
      if (bound.exists && bound.data().handoff_hash === grant.id && bound.data().email === member) {
        const {problem_id,project_id,project_board} = bound.data();
        return {result:{problem_id,project_id,project_board,session_id}};
      }
      if (!g.exists || g.data().email !== member) throw error('permission-denied','This BOLD handoff is unavailable for this account.');
      const row = g.data(), result = {problem_id:row.problem_id,project_id:row.project_id,project_board:row.project_board,session_id};
      if (row.session_id || bound.exists || stream.exists || legacy.exists) throw error('failed-precondition','A verifier session or handoff has already been linked.');
      if (Date.now() >= row.expires_at) throw error('failed-precondition','This verifier handoff expired. Open Lite again from the Problem Bank.');
      await checkTarget(tx,row);
      tx.update(grant,{session_id});
      tx.set(session,{...result,email:member,handoff_hash:grant.id,claimed_at:Date.now()});
      return {result,fresh:true};
    });
    if (out.fresh && onClaimed) {
      try { await onClaimed({...out.result,email:member}); } catch (ignored) { /* the link stands; the notice is best effort */ }
    }
    return out.result;
  }
  // The sessions linked to a problem, for its page: who linked each stays private but to them.
  async function linkedTo(problemId, email) {
    const snap = await sessions.where('problem_id','==',problemId).get();
    return snap.docs.map(doc => {
      const x = doc.data();
      return {session_id:doc.id,project_id:x.project_id || '',project_board:x.project_board || '',claimed_at:x.claimed_at || 0,mine:x.email === email};
    }).sort((a,b) => b.claimed_at - a.claimed_at);
  }
  // Unlinking a session: Lite can no longer return a verifier through it. Its member, a PI or an admin.
  async function unlink(problemId, sessionId, email, full) {
    if (typeof sessionId !== 'string' || !UUID.test(sessionId)) throw error('invalid-argument','Choose a linked Lite session.');
    const ref = sessions.doc(sessionId);
    return db.runTransaction(async tx => {
      const doc = await tx.get(ref);
      if (!doc.exists || doc.data().problem_id !== problemId) throw error('not-found','This Lite session is no longer linked to this problem.');
      if (doc.data().email !== email && !full) throw error('permission-denied','Only whoever linked it, a PI or an admin can unlink it.');
      tx.delete(ref);
      return {ok:true};
    });
  }
  // At most MEMBER_RATE_PER_MINUTE linked requests a minute for each member, whatever the shared service token's count.
  async function countFor(email) {
    const ref = db.collection('verifierHandoffRates').doc(sha('rate:' + String(email).toLowerCase()));
    const minute = Math.floor(Date.now() / 60000);
    const ok = await db.runTransaction(async tx => {
      const doc = await tx.get(ref), x = doc.exists ? doc.data() : {};
      const count = x.minute === minute ? (x.count || 0) + 1 : 1;
      if (count > MEMBER_RATE_PER_MINUTE) return false;
      tx.set(ref,{minute,count});
      return true;
    });
    if (!ok) throw error('resource-exhausted','At most ' + MEMBER_RATE_PER_MINUTE + ' Lite requests a minute for each member: wait a moment.');
  }
  function sourceSession(source) {
    if (typeof source !== 'string' || !source.startsWith('autokaggle:') || !UUID.test(source.slice(11)))
      throw error('invalid-argument','Supply the source ID of the linked Lite session.');
    return sessions.doc(source.slice(11));
  }
  return {issue,claim,sourceSession,requireConfigured,linkedTo,unlink,countFor};
}

module.exports = {enabled,configured,serviceHash,verifierHandoffs};
