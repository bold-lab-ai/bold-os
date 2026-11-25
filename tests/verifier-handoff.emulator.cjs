// Run with the isolated demo emulators and their configured disposable Lite credential.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const admin = require('../functions/node_modules/firebase-admin');
const {record} = require('./benchmark-registry.test.cjs');

const {FIRESTORE_EMULATOR_HOST:store, FUNCTIONS_EMULATOR_HOST:host, GCLOUD_PROJECT:project, BOLD_TEST_LITE_TOKEN_FILE:file} = process.env;
if (project !== 'demo-bold-os' || ![store,host].every(h=>/^127\.0\.0\.1:\d+$/.test(h||'')) || !file)
  throw Error('Use the local demo emulators and their dedicated fixture token.');
const service = fs.readFileSync(file,'utf8').trim();
if (!service.startsWith('bold_local_verifier_')) throw Error('Use a disposable emulator credential.');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const email = 'internal@example.com';
const base = 'http://'+host+'/demo-bold-os/europe-west2';
const write = 'bold_member_fixture_'+crypto.randomBytes(24).toString('hex');
const app = admin.initializeApp({projectId:project}), db = app.firestore();

function jwt(member = true) {
  const now = Math.floor(Date.now()/1000), provider = member ? 'oidc.slack' : 'google.com';
  const part = o=>Buffer.from(JSON.stringify(o)).toString('base64url');
  return part({alg:'none',typ:'JWT'})+'.'+part({aud:project,iss:'https://securetoken.google.com/'+project,sub:'UTESTIN',user_id:'UTESTIN',
    email,iat:now,exp:now+3600,firebase:{identities:{[provider]:['UTESTIN']},sign_in_provider:provider}})+'.';
}
async function post(endpoint,token,args,status) {
  const response=await fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(args)});
  const data=await response.json();
  assert.equal(response.status,status,data.error?.message || data.error || 'unexpected HTTP status');
  return data.result ?? data;
}
const registry = (args,status=200,token=jwt()) => post(base+'/benchmarkRegistry',token,{data:args},status);
const api = (name,args,status=200,token=service) => post(base+'/boldApi/v1/'+name,token,args,status);
const issue = (id,extra={},status=200,token) => registry({action:'issue_verifier_handoff',problem_id:id,...extra},status,token);
const claim = (grant,id,as=email,status=200,token=service) => api('claim_verifier_handoff',{handoff:grant.handoff,email:as,session_id:id},status,token);
function registration(parent,id) {
  const r=record();
  r.source_id='autokaggle:'+id; r.problem_id=parent; delete r.project_id;
  r.idempotency_key=crypto.randomBytes(32).toString('hex');
  return r;
}

(async()=>{
  const memberToken=db.doc('apiTokens/'+sha(write));
  try {
    await memberToken.set({email,name:'Test member',label:'Handoff test',prefix:write.slice(0,12),write:true});
    const create = {action:'create',request_id:crypto.randomUUID(),projects:[],owner_id:'UTESTIN',title:'Test a problem-bound verifier',
      difficulties:'Sparse measurements',significance:'Improve independent trials.',existing_solutions:'Measure single events.',reminders:false};
    const {problem_id:parent}=await registry(create);
    const other=(await registry({...create,request_id:crypto.randomUUID(),projects:[{id:'diverging-runs'}]})).problem_id;
    const building=(await registry({...create,request_id:crypto.randomUUID(),builds_benchmark:true})).problem_id;
    const detail=await registry({action:'get',problem_id:parent});
    assert.equal(detail.handoff_enabled,true); assert.equal(detail.problem.handoff_enabled,true);
    await issue(parent,{},403,jwt(false));
    await issue(building,{},400); await issue(parent,{project_id:'diverging-runs'},400);
    const serviceDoc=db.doc('apiTokens/'+sha(service));
    // Simulate the first ever request with the configured credential, before its scope marker exists.
    await serviceDoc.update({liteVerifierOnly:admin.firestore.FieldValue.delete()});
    assert.equal((await serviceDoc.get()).data().liteVerifierOnly,undefined);
    await api('edit_problem',{problem_id:parent,changes:{title:'unexpected general write'}},403);
    assert.equal((await serviceDoc.get()).data().liteVerifierOnly,true);
    assert.equal((await db.doc('problemBank/'+parent).get()).data().title,create.title);
    const grant=await issue(parent), id=crypto.randomUUID();
    assert.match(grant.handoff,/^[a-f0-9]{64}$/); assert.ok(grant.expires_at>Date.now());
    const grantRef=db.doc('verifierHandoffs/'+sha(grant.handoff));
    assert.doesNotMatch(JSON.stringify((await grantRef.get()).data()),new RegExp(grant.handoff));
    await claim(grant,id,'pi@example.com',403); await claim(grant,id,email,403,write);
    const old='bold_rotated_fixture_'+crypto.randomBytes(24).toString('hex'), oldRef=db.doc('apiTokens/'+sha(old));
    await oldRef.set({email,name:'Old test service',prefix:old.slice(0,12),write:true,liteVerifierOnly:true});
    try {
      await claim(grant,id,email,403,old); await api('edit_problem',{problem_id:parent,changes:{title:'should fail'}},403,old);
    } finally { await oldRef.delete(); }
    assert.equal((await db.doc('apiTokens/'+sha(service)).get()).data().liteVerifierOnly,true);
    const outcome={problem_id:parent,project_id:'',project_board:'',session_id:id};
    const replies=await Promise.all([claim(grant,id),claim(grant,id)]);
    assert.deepEqual(replies,[outcome,outcome]);
    await claim(grant,crypto.randomUUID(),email,409);
    const second=await issue(other,{project_id:'diverging-runs'});
    await claim(second,id,email,409);
    const next=crypto.randomUUID();
    assert.equal((await claim(second,next)).project_id,'diverging-runs');
    const stale=await issue(parent);
    await db.doc('verifierHandoffs/'+sha(stale.handoff)).update({expires_at:Date.now()-1000});
    await claim(stale,crypto.randomUUID(),email,409);
    await grantRef.update({expires_at:Date.now()-1000});
    assert.deepEqual(await claim(grant,id),outcome);
    await grantRef.delete(); // Simulate Firestore TTL after the original claim.
    assert.deepEqual(await claim(grant,id),outcome);
    const r=registration(parent,id);
    const register=(registration,status=200,token=service)=>api('register_linked_verifier',{registration},status,token);
    await register(r,403,write);
    await api('register_benchmark',{registration:r},403);
    await api('register_benchmark',{registration:r},403,write);
    await register({...r,problem_id:other},403); await register({...r,project_id:'diverging-runs'},403);
    await register({...r,source_id:'autokaggle:'+crypto.randomUUID()},403);
    await register({...r,source_id:undefined},400);
    for (const session of [undefined,null,{}, {application:'full'}, {application:'lite',project_id:next}])
      await register({...r,session},400);
    // Source ID is canonical. An omitted redundant session ID still needs a Lite session.
    assert.equal(r.session.application,'lite'); assert.equal(r.session.project_id,undefined);
    assert.equal((await db.collection('benchmarks').where('problem_id','==',parent).get()).size,0);
    await register({...r,human_approval:undefined},409);
    const lower={...r,human_approval:undefined,validation:{...r.validation,research_data:'not_run'}};
    await register(lower,409);
    const r2=registration(other,next);
    await register(r2,403);
    r2.project_id='diverging-runs';
    const receipt=await register(r), receipt2=await register(r2);
    assert.deepEqual(await register(r),receipt); assert.equal(receipt.problem_id,parent); assert.equal(receipt2.problem_id,other);
    assert.equal((await db.collection('benchmarks').where('problem_id','==',parent).get()).size,1);
    const row=(await db.doc('benchmarks/'+receipt.benchmark_id).get()).data();
    assert.equal(row.createdBy,email); assert.equal(row.project_id,''); assert.ok(row.reported_approval);
    const replay=await registry({action:'get',problem_id:other});
    assert.equal(replay.versions[0].project_id,'diverging-runs');
    const logs=await db.collection('apiLog').where('tool','==','claim_verifier_handoff').get();
    assert.ok(logs.size>0); assert.ok(logs.docs.every(item=>item.data().args==='{}'));
    for (const path of ['verifierHandoffs/'+sha(grant.handoff),'verifierSessionClaims/'+id]) {
      const response=await fetch('http://'+store+'/v1/projects/'+project+'/databases/(default)/documents/'+path,{headers:{Authorization:'Bearer '+jwt()}});
      assert.equal(response.status,403);
    }
    console.log('Verified private handoff, account/session/destination checks, atomic replay, bounded service permissions and approved release return.');
  } finally { await memberToken.delete(); await app.delete(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
