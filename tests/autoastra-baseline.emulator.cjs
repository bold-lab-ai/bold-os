// Run after the repo's demo seed and local Functions, Auth and Firestore emulators.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const admin = require('../functions/node_modules/firebase-admin');
const project = process.env.GCLOUD_PROJECT;
const firestore = process.env.FIRESTORE_EMULATOR_HOST;
const functions = process.env.FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5001';
if (project !== 'demo-bold-os' || ![firestore,functions].every(s => /^127\.0\.0\.1:\d{2,5}$/.test(s || ''))) {
  throw Error('Use the local demo-bold-os emulators only.');
}
admin.initializeApp({projectId:project});
const db = admin.firestore();
const owner = 'internal@example.com', operator = 'pi@example.com';
function jwt(email) {
  const uid = email === operator ? 'UTESTPI' : 'UTESTIN', time = Math.floor(Date.now()/1000);
  const encode = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  return encode({alg:'none',typ:'JWT'}) + '.' + encode({aud:project,iss:'https://securetoken.google.com/'+project,
    sub:uid,email,iat:time,exp:time+3600,firebase:{identities:{'oidc.slack':[uid]},sign_in_provider:'oidc.slack'}}) + '.';
}
async function call(email,action,fields) {
  const response = await fetch('http://'+functions+'/'+project+'/europe-west2/benchmarkRegistry',{
    method:'POST',headers:{Authorization:'Bearer '+jwt(email),'Content-Type':'application/json'},body:JSON.stringify({data:{action,...fields}})
  });
  return {status:response.status,data:await response.json()};
}
async function fixture() {
  const problem_id = 'ak-'+crypto.randomBytes(12).toString('hex'), commit = crypto.randomBytes(20).toString('hex');
  const benchmark_id = problem_id+'-'+commit, repository = 'https://github.com/example/affine';
  const evaluator = {repository,commit,contract_sha256:'a'.repeat(64),version:1,zip_url:repository+'/archive/'+commit+'.zip'};
  const approval = {name:'Demo PI',at:Date.now()};
  await db.doc('problemBank/'+problem_id).set({title:'AutoAstra fixture',objective:'Test score delivery',stage:'validated',
    approval,evaluator,createdBy:owner,createdAt:Date.now(),archived:false,projects:[],latest_benchmark:benchmark_id});
  await db.doc('benchmarks/'+benchmark_id).set({title:'Affine fixture',problem_id,source_id:'autokaggle:'+crypto.randomUUID(),
    stage:'validated',approval,evaluator,createdAt:Date.now(),createdBy:owner});
  return {problem_id,benchmark_id};
}
async function run() {
  const {problem_id,benchmark_id}=await fixture(), field={benchmark_id};
  const clean=async()=>Promise.all(['problemBank/'+problem_id,'benchmarks/'+benchmark_id,'autoastraBaselineJobs/'+benchmark_id].map(path=>db.doc(path).delete()));
  try {
    const status=async(email,action,fields,expected)=>{
      const result=await call(email,action,fields);
      assert.equal(result.status,expected,JSON.stringify(result.data));
      return result.data.result;
    };
    const req=()=>status(owner,'request_baseline',field,200);
    assert.deepEqual(await Promise.all([req(),req()]),[{status:'pending'},{status:'pending'}]);
    const keys=[crypto.randomBytes(32).toString('hex'),crypto.randomBytes(32).toString('hex')];
    const claim=(email,claim_key)=>call(email,'claim_baseline',{...field,claim_key});
    assert.equal((await claim(owner,keys[0])).status,403);
    const concurrent=await Promise.all(keys.map(key=>claim(operator,key)));
    assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,403]);
    const winner=concurrent.findIndex(r=>r.status===200), claim_key=keys[winner];
    assert.equal(concurrent[winner].data.result.recipient,owner);
    assert.equal(concurrent[winner].data.result.release.evaluator.commit,benchmark_id.slice(-40));
    assert.deepEqual(await claim(operator,claim_key),concurrent[winner]);
    const summary={run_id:'1'.repeat(32),candidate_sha256:'4'.repeat(64),development_fitness:0.25,final_fitness:1.25,metric:'MAE',direction:'minimize'};
    const finish=()=>status(operator,'finish_baseline',{...field,claim_key,summary},200);
    assert.deepEqual(await Promise.all([finish(),finish()]),[{status:'completed'},{status:'completed'}]);
    const view=await status(owner,'get',{problem_id},200);
    assert.deepEqual(view.versions[0].baseline,{status:'completed',summary});
    assert.doesNotMatch(JSON.stringify(view),/recipient|claimHash|claimedBy|internal@example.com/);
    const privateUrl='http://'+firestore+'/v1/projects/'+project+'/databases/(default)/documents/autoastraBaselineJobs/'+benchmark_id;
    for (const email of [owner,operator]) {
      assert.equal((await fetch(privateUrl,{headers:{Authorization:'Bearer '+jwt(email)}})).status,403);
    }
    console.log('Concurrent requests and claims, result retries, public scores and private job access verified.');
  } finally { await clean(); }
}
module.exports={fixture,call,db,owner,operator};
if(require.main === module) run().finally(()=>admin.app().delete()).catch(error=>{console.error(error);process.exitCode=1;});
