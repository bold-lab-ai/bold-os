// Exercise the same authenticated API used by agents. Only the local demo services are supported.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const admin = require('../functions/node_modules/firebase-admin');
const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST, storeHost = process.env.FIRESTORE_EMULATOR_HOST;
if (![functionsHost,storeHost].every(h=>/^127\.0\.0\.1:\d+$/.test(h || '')) || process.env.GCLOUD_PROJECT !== 'demo-bold-os') throw Error('Use the demo-bold-os emulators.');
admin.initializeApp({projectId:'demo-bold-os'});
const db = admin.firestore(), key = 'bold_local_fixture_'+crypto.randomBytes(20).toString('hex');
const token = db.doc('apiTokens/'+crypto.createHash('sha256').update(key).digest('hex'));
const bank = () => 'ak-'+crypto.randomBytes(12).toString('hex');
const question = bank(), source = bank(), release = bank()+'-'+crypto.randomBytes(20).toString('hex');
const endpoint = 'http://'+functionsHost+'/demo-bold-os/europe-west2/boldApi/v1/';
async function call(name,args,expected=200) {
  const read = name==='list_benchmarks';
  const response = await fetch(endpoint+name+(read ? '?'+new URLSearchParams(args) : ''), {method:read ? 'GET':'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:read ? undefined:JSON.stringify(args)});
  const data = await response.json();
  assert.equal(response.status,expected,JSON.stringify(data));
  return data;
}
(async()=>{
 const docs=[token,db.doc('problemBank/'+question), db.doc('problemBank/'+source),db.doc('benchmarks/'+release)];
 try {
  await Promise.all([
   token.set({email:'internal@example.com',name:'Ines Internal',label:'Project proposal fixture',prefix:key.slice(0,12),write:true}),
   docs[1].set({title:'Example open scientific question',stage:'checked',archived:false}),
   docs[2].set({title:'Example benchmark source',stage:'validated',archived:false}),
   docs[3].set({title:'Example reference',problem_id:source,stage:'checked',evaluator:{version:2},createdAt:Date.now()})
  ]);
  const choices=await call('list_benchmarks',{view:'problem_choices'});
  assert.ok(choices.items.some(i=>i.id===question));
  const catalogue=await call('list_benchmarks',{view:'releases'});
  assert.equal(catalogue.items.find(i=>i.id===release).problem_id,source);
  const proposal={action:'register',title:'Test project proposal',abstract:'Validate the benchmark selection.',problem_id:question,slack_channel:'proj-emulator',gpu_hours:12000};
  await call('projects',proposal,400);
  for(const verification_plan of [{mode:'linked',releaseIds:[release]},{mode:'deferred',reason:'Missing licence',expectedOnboarding:'Next sprint'},{mode:'benchmark'}]){
   const out=await call('projects',{...proposal,verification_plan});
   const p=db.doc('projects/'+out.id); docs.push(p,db.doc('projectProposalReceipts/'+out.id));
   const stored=(await p.get()).data();
   assert.equal(stored.openProblemId,question);
   assert.equal(stored.verificationPlan.mode,verification_plan.mode);
   if (verification_plan.mode==='linked') assert.deepEqual(stored.verificationPlan.releases,[{id:release,problem_id:source,title:'Example reference',version:2}]);
   else if (verification_plan.mode==='deferred') assert.equal(stored.verificationPlan.expectedOnboarding,'Next sprint');
   else assert.deepEqual(stored.verificationPlan,{mode:'benchmark'});
  }
  await docs[1].update({builds_benchmark:true});
  const inherited=await call('projects',proposal), p=db.doc('projects/'+inherited.id);
  docs.push(p,db.doc('projectProposalReceipts/'+inherited.id));
  assert.deepEqual((await p.get()).data().verificationPlan,{mode:'benchmark'});
  await call('projects',{...proposal,verification_plan:{mode:'linked',releaseIds:[release]}},409);
  console.log('Actual agent API passed for discovering releases, required verification, global pinned references explicit deferral and benchmark construction.');
 }finally{await Promise.all(docs.map(d=>d.delete())); await admin.app().delete();}
})().catch(e=>{console.error(e);process.exitCode=1;});
