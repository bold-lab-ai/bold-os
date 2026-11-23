// Run with seeded local demo Functions and Firestore.
const assert = require('node:assert/strict');
const {randomUUID, randomBytes} = require('node:crypto');
const host = process.env.FIRESTORE_EMULATOR_HOST, functions = process.env.FUNCTIONS_EMULATOR_HOST;
if (process.env.GCLOUD_PROJECT !== 'demo-bold-os' || ![host,functions].every(x => /^127\.0\.0\.1:\d+$/.test(x || '')))
  throw Error('Use the local demo-bold-os Firestore and Functions emulators.');
const admin = require('../functions/node_modules/firebase-admin');
const db = admin.initializeApp({projectId:'demo-bold-os'}).firestore();
const base = 'http://'+functions+'/demo-bold-os/europe-west2/';
const store = 'http://'+host+'/v1/projects/demo-bold-os/databases/(default)/documents/';
const email = 'internal@example.com', now = Math.floor(Date.now()/1000);
const b64 = x => Buffer.from(JSON.stringify(x)).toString('base64url');
const token = [b64({alg:'none',typ:'JWT'}), b64({aud:'demo-bold-os',iss:'https://securetoken.google.com/demo-bold-os',
  sub:'UTESTIN',user_id:'UTESTIN',email,iat:now,exp:now+3600,
  firebase:{identities:{'oidc.slack':['UTESTIN']},sign_in_provider:'oidc.slack'}}),''].join('.');
const headers = {Authorization:'Bearer '+token,'Content-Type':'application/json'};
async function call(name,data,expected){
  const r = await fetch(base+name,{method:'POST',headers,body:JSON.stringify({data})});
  const body = await r.json();assert.equal(r.status,expected,JSON.stringify(body));return body;
}
async function patch(path,key,value,expected){
  const r = await fetch(store+path+'?updateMask.fieldPaths='+key,{method:'PATCH',headers,
    body:JSON.stringify({fields:value?{[key]:value}:{}})});
  assert.equal(r.status,expected,await r.text());
}
(async()=>{
  const problemId = 'ak-'+randomBytes(12).toString('hex'), board = 'paper-test-'+randomUUID();
  const problem = db.doc('problemBank/'+problemId), venue = db.doc('boards/'+board);
  const clean = [venue,problem];
  try {
    await Promise.all([problem.create({title:'Existing scientific question',archived:false,notes:'Private detail'}),venue.create({status:'approved'})]);
    const {result:{items}} = await call('benchmarkRegistry',{action:'past_paper_problem_choices'},200);
    assert.deepEqual(items.find(i=>i.id===problemId),{id:problemId,title:'Existing scientific question'});
    const req = {action:'register_past_paper',request_id:randomUUID(),board,problem_id:problemId,title:'Paper HTTP integration test'};
    const [first,retry] = await Promise.all([call('benchmarkRegistry',req,200),call('benchmarkRegistry',req,200)]);
    assert.deepEqual(first.result,retry.result);
    const id = first.result.card_id, card = venue.collection('cards').doc(id);
    clean.unshift(card,db.doc('paperRegistrationReceipts/'+id));
    const row = (await card.get()).data();assert.equal(row.registrationKind,'past_paper');
    assert.equal(row.submittedBy.email,email);assert.equal(row.openProblemTitle,'Existing scientific question');
    for(const field of ['projectId','proposal','verificationPlan']) assert.equal(row[field],undefined);
    await call('benchmarkRegistry',{...req,title:'Other title'},409);
    await call('benchmarkRegistry',{...req,request_id:randomUUID(),proposal:{status:'approved'}},400);
    await problem.update({archived:true});
    await call('benchmarkRegistry',{...req,request_id:randomUUID()},400);
    for(const action of ['setUp','join','submit']){
      const res=await call('projectWorkspace',{action,board,id},400);
      assert.match(res.error.message,/no project workspace/);
    }
    const {result:groups} = await call('getAllProjects',{},200);
    assert.ok(!JSON.stringify(groups).includes(id));
    await patch(card.path,'registrationKind',null,403);
    await patch(card.path,'openProblemTitle',{stringValue:'Forged'},403);
    await patch(card.path,'openProblemId',{stringValue:'ak-'+'a'.repeat(24)},403);
    await patch(card.path,'proposal',{mapValue:{fields:{status:{stringValue:'approved'}}}},403);
    await patch(card.path,'title',{stringValue:'Revised paper title'},200);
    const raw = await fetch(store+venue.path+'/cards?documentId=raw-card',{method:'POST',headers,body:JSON.stringify({fields:{title:{stringValue:'raw'}}})});
    assert.equal(raw.status,403);
    assert.equal((await db.doc('projects/'+id).get()).exists,false);
    assert.equal((await db.doc('projectWorkspaces/'+id).get()).exists,false);
    console.log('Verified authenticated registration, concurrent retry, archived problem, read-only provenance, ordinary paper edits, and separation from project resources.');
  } finally {
    await Promise.all(clean.map(ref=>ref.delete()));
    await admin.app().delete();
  }
})().catch(err => {console.error(err);process.exitCode=1;});
