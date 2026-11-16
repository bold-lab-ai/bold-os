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
 const kids=p=>[...data.keys()].filter(k=>k.startsWith(p+'/')&&k.split('/').length===p.split('/').length+1).map(snap);
 const col=p=>({get:async()=>({docs:kids(p)}),doc:id=>doc(p+'/'+id),orderBy:()=>({limit:()=>({get:async()=>({docs:[...data.keys()].filter(k=>k.startsWith(p+'/')&&k.split('/').length===p.split('/').length+1).map(snap)})})}),where:(key,op,value)=>({get:async()=>({docs:[...data.keys()].filter(k=>k.startsWith(p+'/')&&k.split('/').length===p.split('/').length+1&&data.get(k)[key]===value).map(snap)})})});
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
 const same=record();same.idempotency_key='3'.repeat(64);assert.deepEqual((await h.call({action:'register',registration:same})).benchmark_id,first.benchmark_id);
 const changed=record();changed.idempotency_key='5'.repeat(64);changed.validation.code_review='not_run';changed.validation.research_data='not_run';delete changed.validation.research_evidence;delete changed.human_approval;
 await assert.rejects(h.call({action:'register',registration:changed}),e=>e.code==='already-exists');
 const older=record();older.idempotency_key='6'.repeat(64);older.evaluator.commit='6'.repeat(40);older.evaluator.zip_url='https://github.com/example/evaluator/archive/'+older.evaluator.commit+'.zip';older.validation.research_evidence.commit=older.evaluator.commit;older.human_approval.commit=older.evaluator.commit;
 await assert.rejects(h.call({action:'register',registration:older}),e=>e.code==='failed-precondition');
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
module.exports={record,harness};

test('project is mandatory and must exist',async()=>{
 const h=harness(),r=record();delete r.project_id;assert.throws(()=>factory.normalize(r),/project ID/);
 r.project_id='missing';await assert.rejects(h.call({action:'register',registration:r}),e=>e.code==='failed-precondition');
});
test('stages reflect evidence, approval is separate, and invalid evidence cannot raise a stage',()=>{
 const r=record();delete r.human_approval;
 assert.equal(factory.normalize(r).stage,'validated');assert.equal(factory.normalize(r).reported_approval,null);
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
test('direct problem creation is disabled for members and administrators without writes',async()=>{
 const h=harness(),before=[...h.data.entries()];
 const input={action:'create',project_id:'diverging-runs',title:'An open question',objective:'What works?',task_kind:'custom',details:{owner:'A researcher'}};
 for(const email of ['owner@example.invalid','admin@example.invalid'])await assert.rejects(h.call(input,email),e=>e.code==='failed-precondition'&&/AutoKaggle Lite/.test(e.message));
 assert.deepEqual([...h.data.entries()],before);
});
test('registration requires a Lite session and rejects other origins without writes',async()=>{
 const h=harness(),before=[...h.data.entries()];
 for(const session of [undefined,null,{}, {application:'full'},{application:'unknown'}]){
  const r=record();r.session=session;
  await assert.rejects(h.call({action:'register',registration:r}),e=>e.code==='invalid-argument'&&/AutoKaggle Lite/.test(e.message));
 }
 assert.deepEqual([...h.data.entries()],before);
 const r=await h.call({action:'register',registration:record()});
 assert.equal((await h.call({action:'get',problem_id:r.problem_id})).problem.session.application,'lite');
});
test('existing open problems remain readable and editable with history',async()=>{
 const h=harness();
 const r={problem_id:'ak-'+ 'a'.repeat(24)},path='problemBank/'+r.problem_id;
 const value={title:'An open question',objective:'What works?',task_kind:'custom',stage:'open',project_id:'diverging-runs',project_board:'',project_title:'Diverging runs',createdBy:'owner@example.invalid',updatedAt:1};
 h.data.set(path,value);h.data.set(path+'/versions/legacy',{...value,changeNote:'Created open problem'});
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

test('AutoKaggle\'s approval is only its report; a PI or admin approves a validated release, once',async()=>{
 const h=harness(),out=await h.call({action:'register',registration:record()});
 let view=await h.call({action:'get',problem_id:out.problem_id});
 assert.equal(view.versions[0].approval,null);assert.ok(view.versions[0].reported_approval);assert.equal(view.can_approve,false);
 await assert.rejects(h.call({action:'approve',benchmark_id:out.benchmark_id}),e=>e.code==='permission-denied');
 h.data.set('members/admin@example.invalid',{name:'Ada Admin'});
 await h.call({action:'approve',benchmark_id:out.benchmark_id,note:'Read the report.'},'admin@example.invalid');
 view=await h.call({action:'get',problem_id:out.problem_id},'admin@example.invalid');
 assert.equal(view.versions[0].approval.name,'Ada Admin');assert.equal(view.problem.approval.name,'Ada Admin');assert.equal(view.can_approve,true);
 assert.doesNotMatch(JSON.stringify(view),/@example/);
 await assert.rejects(h.call({action:'approve',benchmark_id:out.benchmark_id},'admin@example.invalid'),e=>e.code==='already-exists');
 const r=record();r.source_id='autokaggle:99999999-2222-3333-4444-555555555555';r.idempotency_key='7'.repeat(64);r.validation.research_data='not_run';delete r.validation.research_evidence;delete r.human_approval;
 const checked=await h.call({action:'register',registration:r});
 await assert.rejects(h.call({action:'approve',benchmark_id:checked.benchmark_id},'admin@example.invalid'),e=>e.code==='failed-precondition');
});
test('search leaves out archived problems and their releases; null details are none',async()=>{
 const h=harness(),out=await h.call({action:'register',registration:record()});
 let s=(await h.call({action:'search'})).items;assert.deepEqual(s.map(x=>x.kind).sort(),['benchmarks','problems']);
 await h.call({action:'update',problem_id:out.problem_id,project_id:'diverging-runs',details:null,notes:'',archived:true});
 s=(await h.call({action:'search'})).items;assert.equal(s.length,0);
});

test('the research owner is one of the lab\'s people, by Slack ID, named as the roster names them',async()=>{
 const h=harness();h.data.set('people/UOWNER1',{name:'Rae Researcher',slackId:'UOWNER1'});h.data.set('people/UOWNER2',{name:'Sam Second',slackId:'UOWNER2'});
 const r=await h.call({action:'register',registration:record()}),edit={action:'update',problem_id:r.problem_id,project_id:'diverging-runs',notes:'',archived:false};
 await assert.rejects(h.call({...edit,owner_id:'UNOBODY'}),e=>e.code==='invalid-argument');
 await assert.rejects(h.call({...edit,owner_id:'<script>'}),e=>e.code==='invalid-argument');
 await h.call({...edit,owner_id:'UOWNER1',details:{owner:'Someone typed'}});
 let p=(await h.call({action:'get',problem_id:r.problem_id})).problem;
 assert.equal(p.details.owner,'Rae Researcher');assert.equal(p.owner_id,'UOWNER1');
 await h.call(edit);
 p=(await h.call({action:'get',problem_id:r.problem_id})).problem;assert.equal(p.details.owner,'Rae Researcher');assert.equal(p.owner_id,'UOWNER1');
 await h.call({...edit,owner_id:'UOWNER2'});
 p=(await h.call({action:'get',problem_id:r.problem_id})).problem;assert.equal(p.details.owner,'Sam Second');assert.equal(p.owner_id,'UOWNER2');
 await assert.rejects(h.call({action:'create',project_id:'diverging-runs',title:'Q',objective:'O',task_kind:'k',owner_id:'UOWNER1'},'admin@example.invalid'),e=>e.code==='failed-precondition');
});
