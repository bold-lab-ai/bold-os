// Integration test against the demo emulators. It never contacts production.
const assert=require('node:assert/strict'), crypto=require('node:crypto');
if(process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8080' || process.env.GCLOUD_PROJECT!=='demo-bold-os')throw Error('Use the local demo-bold-os emulators.');
const admin=require('../functions/node_modules/firebase-admin');
admin.initializeApp({projectId:'demo-bold-os'});const db=admin.firestore();
const {record}=require('./benchmark-registry.test.cjs');
const base='http://127.0.0.1:5001/demo-bold-os/europe-west2';
const writeToken='bold_registry_test_'+crypto.randomBytes(16).toString('hex');
const readToken='bold_registry_test_'+crypto.randomBytes(16).toString('hex');
async function api(name,body,token=writeToken){return fetch(base+'/boldApi/v1/'+name,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});}
function jwt(slack=true){const b=x=>Buffer.from(JSON.stringify(x)).toString('base64url'),now=Math.floor(Date.now()/1000);return b({alg:'none',typ:'JWT'})+'.'+b({aud:'demo-bold-os',iss:'https://securetoken.google.com/demo-bold-os',sub:'UTESTIN',user_id:'UTESTIN',email:'internal@example.com',iat:now,exp:now+3600,firebase:{identities:{[slack?'oidc.slack':'google.com']:['UTESTIN']},sign_in_provider:slack?'oidc.slack':'google.com'}})+'.';}
async function rules(path,method='GET',token,body){return fetch('http://127.0.0.1:8080/v1/projects/demo-bold-os/databases/(default)/documents/'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});}
(async()=>{
  for(const [token,write] of [[writeToken,true],[readToken,false]])await db.doc('apiTokens/'+crypto.createHash('sha256').update(token).digest('hex')).set({email:'internal@example.com',name:'Ines Internal',label:'Registry emulator test',prefix:token.slice(0,12),write});
  const registration=record();registration.title='Registry integration test — synthetic evidence';
  registration.source_id='autokaggle:12345678-1234-1234-1234-123456789012';registration.idempotency_key=crypto.randomBytes(32).toString('hex');
  assert.equal((await api('register_benchmark',{registration},readToken)).status,403);
  const missing=structuredClone(registration);missing.project_id='does-not-exist';const missingResponse=await api('register_benchmark',{registration:missing});assert.equal(missingResponse.status,409,await missingResponse.text());
  const invalid=structuredClone(registration);invalid.validation.research_data='not_run';
  assert.equal((await api('register_benchmark',{registration:invalid})).status,400);
  const concurrent=await Promise.all([api('register_benchmark',{registration}),api('register_benchmark',{registration})]);
  for(const r of concurrent)assert.equal(r.status,200,await r.clone().text());
  const receipt=await concurrent[0].json();assert.deepEqual(await concurrent[1].json(),receipt);
  assert.equal((await db.collection('benchmarks').where('problem_id','==',receipt.problem_id).get()).size,1);
  const conflict={...registration,title:'Different content'};assert.equal((await api('register_benchmark',{registration:conflict})).status,409);
  const list=await api('list_benchmarks?kind=benchmarks',null,readToken);assert.equal(list.status,200);assert.doesNotMatch(await list.text(),/internal@example\.com/);
  assert.equal((await rules('problemBank/'+receipt.problem_id)).status,403);
  assert.equal((await rules('problemBank/'+receipt.problem_id,'GET',jwt(false))).status,403);
  assert.equal((await rules('problemBank/'+receipt.problem_id,'GET',jwt())).status,200);
  assert.equal((await rules('problemBank/'+receipt.problem_id,'PATCH',jwt(),{fields:{title:{stringValue:'Direct write must fail'}}})).status,403);
  assert.equal((await rules('benchmarkReceipts/'+registration.idempotency_key,'GET',jwt())).status,403);
  const edit=await api('edit_problem',{problem_id:receipt.problem_id,project_id:'diverging-runs',details:{owner:'Ines Internal'},notes:'Synthetic integration fixture. Do not treat this as research validation.',archived:false});assert.equal(edit.status,200,await edit.clone().text());
  const search=await api('search?query=integration&scope=problems',null,readToken);assert.equal(search.status,200);assert.match(await search.text(),/Registry integration test/);
  console.log('Registry HTTP, transactions, search, permissions, and Firestore rules passed.');
  console.log('Browser fixture: http://localhost:8150/problems.html?problem='+receipt.problem_id);
  await admin.app().delete();
})().catch(e=>{console.error(e);process.exitCode=1;});
