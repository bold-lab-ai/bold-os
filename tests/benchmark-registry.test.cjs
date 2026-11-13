const {test}=require('node:test'), assert=require('node:assert/strict');
const factory=require('../functions/benchmark-registry');
function record(){return {schema:'bold.autokaggle.registration.v1',source_id:'autokaggle:11111111-2222-3333-4444-555555555555',idempotency_key:'1'.repeat(64),destinations:['problem_bank'],project_id:'diverging-runs',session:{application:'lite'},title:'Example benchmark',objective:'Compare independently measured outcomes.',task_kind:'optimization',
 evaluator:{repository:'https://github.com/example/evaluator',commit:'a'.repeat(40),version:1,contract_sha256:'b'.repeat(64),zip_url:'https://github.com/example/evaluator/archive/'+'a'.repeat(40)+'.zip'},
 validation:{build:'passed',contract_coverage:'passed',code_review:'passed',synthetic:'passed',known_score:'passed',invalid_submission:'passed',clean_clone:'passed',research_data:'validated',research_evidence:{passed:true,mode:'research',commit:'a'.repeat(40),contract_sha256:'b'.repeat(64),reference_sha256:'c'.repeat(64),artifact_sha256:'d'.repeat(64),report_sha256:'e'.repeat(64),checked_by:'controlled-runtime:1234567890abcdef',checked_at:'2026-11-12T20:00:00Z',expected_fitness:1,observed_fitness:1,tolerance:1e-6,expected_basis:'Independent calculation on declared input.'}},
 human_approval:{commit:'a'.repeat(40),contract_sha256:'b'.repeat(64),research_report_sha256:'e'.repeat(64),approved_by:'f'.repeat(64),approved_at:'2026-11-12T20:01:00Z',note:'I reviewed the code and research evidence.'}};}
function harness(){
 const data=new Map([['projects/diverging-runs',{title:'Diverging runs'}]]);
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
 const r=record();if(change==='research')r.validation.research_data='not_run';if(change==='approval')r.human_approval={commit:'bad'};if(change==='commit')r.validation.research_evidence.commit='0'.repeat(40);if(change==='reference')delete r.validation.research_evidence.reference_sha256;if(change==='score')r.validation.research_evidence.observed_fitness=2;if(change==='zip')r.evaluator.zip_url='https://github.com/example/evaluator/archive/main.zip';if(change==='mode')r.validation.research_evidence.mode='synthetic';if(change==='extra_url')r.evaluator.repository+='?token=private';assert.throws(()=>factory.normalize(r));
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
 await assert.rejects(h.call({action:'update',problem_id:first.problem_id,project_id:'diverging-runs',notes:'x',archived:false},'other@example.invalid'),e=>e.code==='permission-denied');
 await h.call({action:'update',problem_id:first.problem_id,project_id:'diverging-runs',notes:'Archive for now.',archived:true});
 await h.call({action:'update',problem_id:first.problem_id,project_id:'diverging-runs',notes:'Restored.',archived:false});
 assert.equal(h.data.get('problemBank/'+first.problem_id).archived,false);
 await assert.rejects(h.registry.run({data:{action:'list'}}),e=>e.code==='unauthenticated');h.deny();
 await assert.rejects(h.call({action:'get',problem_id:first.problem_id}),e=>e.code==='permission-denied');
});
module.exports={record};

test('project is mandatory and must exist',async()=>{
 const h=harness(),r=record();delete r.project_id;assert.throws(()=>factory.normalize(r),/project ID/);
 r.project_id='missing';await assert.rejects(h.call({action:'register',registration:r}),e=>e.code==='failed-precondition');
});
test('stages reflect evidence, approval is separate, and invalid evidence cannot raise a stage',()=>{
 const r=record();delete r.human_approval;
 assert.equal(factory.normalize(r).stage,'validated');assert.equal(factory.normalize(r).approval,null);
 r.validation.research_data='not_run';delete r.validation.research_evidence;
 assert.equal(factory.normalize(r).stage,'checked');assert.equal(factory.normalize(r).research,null);
 r.validation.clean_clone='not_run';assert.equal(factory.normalize(r).stage,'implemented');
 r.validation.research_data='validated';assert.throws(()=>factory.normalize(r),/software checks/);
 r.validation.build='failed';assert.throws(()=>factory.normalize(r),/Implementation/);
});
test('no credential or arbitrary session URL enters the record',()=>{
 const r=record();r.session.url='https://evil.invalid';r.session.code='SECRET';r.details={owner:'A researcher',token:'SECRET'};
 const out=factory.normalize(r);assert.deepEqual(out.session,{application:'lite',project_id:r.source_id.slice(11)});
 assert.doesNotMatch(JSON.stringify(out),/SECRET|evil/);
 r.session.application='unknown';assert.throws(()=>factory.normalize(r),/session/);
});
test('open problems require a real project, retain history, and cannot claim an evaluator stage',async()=>{
 const h=harness();
 const input={action:'create',project_id:'missing',title:'An open question',objective:'What works?',task_kind:'custom',details:{owner:'A researcher'},stage:'validated'};
 await assert.rejects(h.call(input),e=>e.code==='failed-precondition');
 input.project_id='diverging-runs';const r=await h.call(input);
 let view=await h.call({action:'get',problem_id:r.problem_id});assert.equal(view.problem.stage,'open');assert.equal(view.history.length,1);assert.equal(view.versions.length,0);
 await h.call({action:'update',problem_id:r.problem_id,project_id:'diverging-runs',details:{owner:'A researcher'},notes:'Next step',archived:false,definition:{title:'A revised question',objective:'Measure cost',task_kind:'optimization'}});
 view=await h.call({action:'get',problem_id:r.problem_id});assert.equal(view.problem.title,'A revised question');assert.equal(view.history.length,2);
});
test('registry edits cannot change an accepted evaluation contract',async()=>{
 const h=harness(),r=await h.call({action:'register',registration:record()});
 await assert.rejects(h.call({action:'update',problem_id:r.problem_id,project_id:'diverging-runs',notes:'',archived:false,definition:{title:'Changed',objective:'Changed',task_kind:'custom'}}),e=>e.code==='failed-precondition');
});
test('registration supports a project on a publication board',async()=>{
 const h=harness(),r=record();r.project_id='card-123';r.project_board='neurips';h.data.set('boards/neurips/cards/card-123',{title:'Board project'});
 const out=await h.call({action:'register',registration:r});const p=(await h.call({action:'get',problem_id:out.problem_id})).problem;
 assert.equal(p.project_board,'neurips');assert.equal(p.project_title,'Board project');
 r.project_board='../bad';assert.throws(()=>factory.normalize(r),/board/);
});
