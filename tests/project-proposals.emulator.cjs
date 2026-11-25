// Firestore rules for proposing a project (projects/{id} proposal), against the demo emulator.
// npx firebase emulators:exec --only firestore --project demo-bold-os "node tests/project-proposals.emulator.cjs"
const assert = require('node:assert/strict');
if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '') || process.env.GCLOUD_PROJECT !== 'demo-bold-os') throw Error('Use the local demo-bold-os emulators.');
const admin = require('../functions/node_modules/firebase-admin');
admin.initializeApp({ projectId: 'demo-bold-os' }); const db = admin.firestore();

function jwt(email, slack = true) {
  const b = x => Buffer.from(JSON.stringify(x)).toString('base64url'), now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({ aud: 'demo-bold-os', iss: 'https://securetoken.google.com/demo-bold-os', sub: email, user_id: email, email, iat: now, exp: now + 3600,
    firebase: { identities: { [slack ? 'oidc.slack' : 'google.com']: [email] }, sign_in_provider: slack ? 'oidc.slack' : 'google.com' } }) + '.';
}
function value(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return { integerValue: String(v) };
  if (Array.isArray(v)) return {arrayValue:{values:v.map(value)}};
  if (typeof v === 'object') return { mapValue: { fields: fields(v) } };
  return { stringValue: v };
}
function fields(o) { return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, value(v)])); }
const base = 'http://'+process.env.FIRESTORE_EMULATOR_HOST+'/v1/projects/demo-bold-os/databases/(default)/documents/';
async function req(path, method, token, body, mask) {
  const q = mask ? '?' + mask.map(f => 'updateMask.fieldPaths=' + f).join('&') : '';
  const r = await fetch(base + path + q, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify({ fields: fields(body) }) : undefined });
  return r.status;
}

(async () => {
  const member = 'internal@example.com', dbid = 'rule-plan-' + Date.now();
  const plan = {mode:'deferred',reason:'Awaiting assets',expectedOnboarding:'Next week'};
  const project = 'projects/' + dbid, card = 'boards/demo-venue/cards/' + dbid, legacy = 'projects/' + dbid + '-old';
  const auth = jwt(member), problem = 'ak-' + 'c'.repeat(24);
  const submittedBy = {email:member}, core = {title:'Test',submittedBy,reviewers:{junior:'',senior:''}};
  const proposal = {status:'proposed',more:false,at:Date.now(),by:member};
  const owned = {...core,openProblemId:problem,verificationPlan:plan};
  // Firestore-only emulators can be empty; use only temporary records then restore the fixture.
  const roles = [db.doc('roles/pis'),db.doc('roles/admins'),db.doc('members/'+member)];
  const seeded = [];
  try {
    for (const [i,ref] of roles.entries()) {
      if (!(await ref.get()).exists) { await ref.create(i===2 ? {category:'internal'} : {emails:[]}); seeded.push(ref); }
    }
    assert.equal(await req('projects?documentId='+dbid,'POST',auth,{...owned,proposal}),403,'a proposal requires the registry');
    assert.equal(await req('boards/demo-venue/cards?documentId='+dbid,'POST',auth,core),403,'a venue card must use the appropriate registration callable');
    assert.equal(await req('projectProposalReceipts?documentId='+dbid,'POST',auth,{by:member}),403,'receipts are private');
    await db.doc(project).set({...owned,proposal:{...proposal,status:'approved'}});
    await db.doc(card).set(owned);await db.doc(legacy).set(core);
    for (const path of [project,card,legacy]){
      assert.equal(await req(path,'PATCH',auth,{verificationPlan:{mode:'linked',releaseIds:['invented']}},['verificationPlan']),403);
      assert.equal(await req(path,'PATCH',auth,{openProblemId:'ak-'+'b'.repeat(24)},['openProblemId']),403);
      assert.equal(await req(path,'PATCH',auth,{title:'Edited title'},['title']),200,'existing owners still edit ordinary fields');
    }
    assert.equal(await req(project,'PATCH',auth,{proposal:{status:'declined'}},['proposal']),403);
    // Its level and what it's part of (#248): an older project stays editable; changing its links needs them linked.
    const old = 'projects/' + dbid + '-levels';
    await db.doc(old).set(core);
    assert.equal(await req(old,'PATCH',auth,{parents:[]},['parents']),403,'its links changed to nothing');
    assert.equal(await req(old,'PATCH',auth,{parents:['m1'],connection:'how'},['parents','connection']),200,'linked up');
    assert.equal(await req(old,'PATCH',auth,{level:'northstar',parents:[]},['level','parents']),200,'made a northstar');
    assert.equal(await req(old,'PATCH',auth,{level:'moonshot'},['level']),403,'a moonshot part of nothing');
    assert.equal(await req(old,'PATCH',auth,{level:'galaxy'},['level']),403,'no such level');
    await db.doc(old).delete();
    console.log('Project proposal rules passed for project creation, venue cards, legacy edits and verification plan protection.');
  } finally {
    await Promise.all([db.doc(project),db.doc(card),db.doc(legacy),...seeded].map(ref=>ref.delete()));
    await admin.app().delete();
  }
})().catch((e) => { console.error(e); process.exitCode=1; });
