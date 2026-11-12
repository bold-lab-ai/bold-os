const {test}=require('node:test'), assert=require('node:assert/strict');
const factory=require('../functions/benchmark-registry');
function record(){return {schema:'bold.autokaggle.registration.v1',source_id:'autokaggle:11111111-2222-3333-4444-555555555555',idempotency_key:'1'.repeat(64),destinations:['problem_bank','benchmarks'],title:'Example benchmark',objective:'Compare independently measured outcomes.',task_kind:'optimization',
 evaluator:{repository:'https://github.com/example/evaluator',commit:'a'.repeat(40),version:1,contract_sha256:'b'.repeat(64),zip_url:'https://github.com/example/evaluator/archive/'+'a'.repeat(40)+'.zip'},
 validation:{build:'passed',contract_coverage:'passed',code_review:'passed',synthetic:'passed',research_data:'validated',research_evidence:{passed:true,mode:'research',commit:'a'.repeat(40),contract_sha256:'b'.repeat(64),reference_sha256:'c'.repeat(64),artifact_sha256:'d'.repeat(64),report_sha256:'e'.repeat(64),checked_by:'controlled-runtime:1234567890abcdef',checked_at:'2026-11-12T20:00:00Z',expected_fitness:1,observed_fitness:1,tolerance:1e-6,expected_basis:'Independent calculation on declared input.'}},
 human_approval:{commit:'a'.repeat(40),contract_sha256:'b'.repeat(64),research_report_sha256:'e'.repeat(64),approved_by:'f'.repeat(64),approved_at:'2026-11-12T20:01:00Z',note:'I reviewed the code and research evidence.'}};}
function harness(){
 const data=new Map();
 const snap=p=>({id:p.split('/').pop(),exists:data.has(p),data:()=>structuredClone(data.get(p))});
 const doc=p=>({path:p,get:async()=>snap(p),collection:n=>col(p+'/'+n)});
 const col=p=>({doc:id=>doc(p+'/'+id),orderBy:()=>({limit:()=>({get:async()=>({docs:[...data.keys()].filter(k=>k.startsWith(p+'/')&&k.split('/').length===p.split('/').length+1).map(snap)})})}),where:(key,op,value)=>({get:async()=>({docs:[...data.keys()].filter(k=>k.startsWith(p+'/')&&k.split('/').length===p.split('/').length+1&&data.get(k)[key]===value).map(snap)})})});
 const db={collection:col,runTransaction:async fn=>{const writes=[];const result=await fn({get:async ref=>snap(ref.path),set:(ref,x)=>writes.push(()=>data.set(ref.path,structuredClone(x))),update:(ref,x)=>writes.push(()=>data.set(ref.path,{...data.get(ref.path),...structuredClone(x)}))});writes.forEach(f=>f());return result;}};
 class ErrorWithCode extends Error{constructor(code,message){super(message);this.code=code;}}
 let denied=false;
 const registry=factory({db,onCall:(_,fn)=>fn,callerEmail:r=>{if(!r.auth?.slack)throw new ErrorWithCode('unauthenticated','Slack required');return r.auth.email;},isFullWrite:async e=>e==='admin@example.invalid',access:{requireAccess:async()=>{if(denied)throw new ErrorWithCode('permission-denied','Access denied');},can:async()=>true},HttpsError:ErrorWithCode});
 const call=(value,email='owner@example.invalid')=>registry.run({auth:{slack:true,email},data:value});
 return {call,data,registry,deny:()=>{denied=true;}};
}
for(const change of ['research','approval','commit','reference','score','zip','mode','extra_url'])test('registration rejects '+change,()=>{
 const r=record();if(change==='research')r.validation.research_data='not_run';if(change==='approval')r.human_approval={};if(change==='commit')r.validation.research_evidence.commit='0'.repeat(40);if(change==='reference')delete r.validation.research_evidence.reference_sha256;if(change==='score')r.validation.research_evidence.observed_fitness=2;if(change==='zip')r.evaluator.zip_url='https://github.com/example/evaluator/archive/main.zip';if(change==='mode')r.validation.research_evidence.mode='synthetic';if(change==='extra_url')r.evaluator.repository+='?token=private';assert.throws(()=>factory.normalize(r));
});
test('one transaction registers both records, retries return one receipt, and changed evidence conflicts',async()=>{
 const h=harness(),registration=record(),first=await h.call({action:'register',registration});
 assert.equal([...h.data.keys()].filter(k=>k.startsWith('problemBank/')&&k.split('/').length===2).length,1);
 assert.equal([...h.data.keys()].filter(k=>k.startsWith('benchmarks/')&&k.split('/').length===2).length,1);
 assert.deepEqual(await h.call({action:'register',registration}),first);
 await assert.rejects(h.call({action:'register',registration:{...registration,title:'Changed'}}),e=>e.code==='already-exists');
 const view=await h.call({action:'get',problem_id:first.problem_id});assert.equal(view.versions.length,1);assert.equal(view.problem.createdBy,undefined);
 assert.doesNotMatch(JSON.stringify(view),/@example/);
});
test('new commits preserve history and reject an older or conflicting version',async()=>{
 const h=harness(),r=record(),first=await h.call({action:'register',registration:r});
 r.idempotency_key='2'.repeat(64);r.evaluator.version=2;r.evaluator.commit='2'.repeat(40);r.evaluator.zip_url='https://github.com/example/evaluator/archive/'+r.evaluator.commit+'.zip';r.validation.research_evidence.commit=r.evaluator.commit;r.human_approval.commit=r.evaluator.commit;
 const next=await h.call({action:'register',registration:r});assert.equal(first.problem_id,next.problem_id);assert.notEqual(first.benchmark_id,next.benchmark_id);
 const old=record();old.idempotency_key='3'.repeat(64);await assert.rejects(h.call({action:'register',registration:old}),e=>e.code==='failed-precondition');
 assert.equal((await h.call({action:'get',problem_id:first.problem_id})).versions.length,2);
});
test('ownership, Slack identity and page access apply to registration and edits',async()=>{
 const h=harness(),r=record(),first=await h.call({action:'register',registration:r});
 await assert.rejects(h.call({action:'register',registration:r},'other@example.invalid'),e=>e.code==='permission-denied');
 await assert.rejects(h.call({action:'update',problem_id:first.problem_id,notes:'x',archived:false},'other@example.invalid'),e=>e.code==='permission-denied');
 await h.call({action:'update',problem_id:first.problem_id,notes:'Archive for now.',archived:true});
 await h.call({action:'update',problem_id:first.problem_id,notes:'Restored.',archived:false});
 assert.equal(h.data.get('problemBank/'+first.problem_id).archived,false);
 await assert.rejects(h.registry.run({data:{action:'list'}}),e=>e.code==='unauthenticated');h.deny();
 await assert.rejects(h.call({action:'get',problem_id:first.problem_id}),e=>e.code==='permission-denied');
});
module.exports={record};
