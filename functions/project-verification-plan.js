// Write the project and its verified selection together. Firestore rules cannot
// validate a variable list of releases and their separate source problems.
const makeRegisteredCard = require('./make-registered-card');
const PROBLEM_ID = /^ak-[a-f0-9]{24}$/;
const RELEASE_ID = /^ak-[a-f0-9]{24}-[a-f0-9]{40}$/;
const SETUP = ['setUpMeeting','setUpChannel','setUpRepo','setUpDocs','setUpSkipped','announce'];

function verificationPlan(plan, error) {
  function reject(message){ throw error('invalid-argument', message); }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) reject('Select benchmark releases or defer verifier onboarding.');
  if (plan.mode === 'deferred') {
    if (Object.keys(plan).some(k => !['mode','reason','expectedOnboarding'].includes(k)) ||
        typeof plan.reason !== 'string' || !plan.reason.trim() || plan.reason.trim().length > 2000 ||
        typeof plan.expectedOnboarding !== 'string' || !plan.expectedOnboarding.trim() || plan.expectedOnboarding.trim().length > 240)
      reject('Give a reason and an expected onboarding date or time frame.');
    return {mode:'deferred', reason:plan.reason.trim(), expectedOnboarding:plan.expectedOnboarding.trim()};
  }
  const ids = plan.releaseIds;
  if (plan.mode !== 'linked' || Object.keys(plan).some(k => !['mode','releaseIds'].includes(k)) ||
      !Array.isArray(ids) || !ids.length || ids.length > 100 ||
      ids.some(id => typeof id !== 'string' || !RELEASE_ID.test(id)) || new Set(ids).size !== ids.length)
    reject('Choose between one and 100 distinct registered verifier releases.');
  return {mode:'linked', releaseIds:ids};
}

async function createProposal({db,error,fingerprint}, input, email, name) {
  const card = input.card, id = input.project_id;
  if (typeof id !== 'string' || !/^card-[a-z0-9-]{1,80}$/.test(id) || !card || typeof card !== 'object' || Array.isArray(card))
    throw error('invalid-argument','Supply the project proposal and its ID.');
  if (typeof card.openProblemId !== 'string' || !PROBLEM_ID.test(card.openProblemId))
    throw error('invalid-argument','Choose an active Problem Bank problem.');
  if (typeof card.title !== 'string' || !card.title.trim() || typeof card.abstractText !== 'string' || !card.abstractText.trim())
    throw error('invalid-argument','Give the project a title and an abstract.');
  if (card.submittedBy?.email !== email || (card.projectId !== undefined && card.projectId !== id))
    throw error('permission-denied','Propose the project under your own account.');
  const proposal = card.proposal;
  if (!proposal || proposal.status !== 'proposed' || 'dueAt' in proposal ||
      (proposal.more !== undefined && typeof proposal.more !== 'boolean') ||
      (proposal.more === false ? 'gpuHours' in proposal :
        !Number.isFinite(proposal.gpuHours) || proposal.gpuHours <= 0 || proposal.gpuHours > 10000000))
    throw error('invalid-argument','Choose the standard compute allowance or specify the extra GPU hours.');
  const plan = verificationPlan(card.verificationPlan, error);
  const fields = {title:card.title.trim(), abstractText:card.abstractText.trim(), keywords:card.keywords || [], slackChannel:card.slackChannel || '', computeEstimate:card.computeEstimate || ''};
  const setup = Object.fromEntries(SETUP.filter(k => card[k] !== undefined).map(k => [k,card[k]]));
  const budget = proposal.more === false ? {more:false} : {more:true,gpuHours:proposal.gpuHours};
  const hash = fingerprint([fields,setup,card.openProblemId,budget,plan]);
  const project = db.collection('projects').doc(id), receipt = db.collection('projectProposalReceipts').doc(id);
  const bank = db.collection('problemBank'), releases = db.collection('benchmarks');
  return db.runTransaction(async tx => {
    const [saved,existing] = await Promise.all([tx.get(receipt),tx.get(project)]);
    if (saved.exists && saved.data().by === email && saved.data().hash === hash) return {project_id:id};
    if (saved.exists || existing.exists) throw error('already-exists','This project ID was already used for a different proposal.');

    const selected = plan.mode === 'linked' ? await Promise.all(plan.releaseIds.map(release => tx.get(releases.doc(release)))) : [];
    if (selected.some(doc => !doc.exists || !PROBLEM_ID.test(doc.data().problem_id) || !doc.data().title || !Number.isInteger(doc.data().evaluator?.version)))
      throw error('failed-precondition','A selected verifier release is unavailable. Refresh the choices.');
    const problemIds = new Set([card.openProblemId,...selected.map(doc=>doc.data().problem_id)]);
    const problems = await Promise.all([...problemIds].map(key => tx.get(bank.doc(key))));
    if (problems.some(doc => !doc.exists || doc.data().archived)) throw error('failed-precondition','The selected problem or a benchmark source problem is no longer active. Refresh the choices.');
    const confirmed = plan.mode === 'linked' ? {...plan, releases:selected.map(doc => {
      const release = doc.data();
      return {id:doc.id,title:release.title,version:release.evaluator.version,problem_id:release.problem_id};
    })} : plan;
    const now = Date.now(), base = makeRegisteredCard({email,name:name || email},fields,now);
    delete base.id;
    tx.set(project,{...base,...setup,openProblemId:card.openProblemId, verificationPlan:confirmed,
      proposal:{status:'proposed',...budget,at:now,by:email}});
    tx.set(receipt,{by:email,hash});
    return {project_id:id};
  });
}
module.exports = {createProposal,verificationPlan};
