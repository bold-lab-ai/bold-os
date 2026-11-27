const {test}=require('node:test'), assert=require('node:assert/strict');
const factory=require('../functions/benchmark-registry');
function record(){return {schema:'bold.autokaggle.registration.v1',source_id:'autokaggle:11111111-2222-3333-4444-555555555555',idempotency_key:'1'.repeat(64),destinations:['problem_bank'],project_id:'diverging-runs',session:{application:'lite'},title:'Example benchmark',objective:'Compare independently measured outcomes.',task_kind:'optimization',
 evaluator:{repository:'https://github.com/example/evaluator',commit:'a'.repeat(40),version:1,contract_sha256:'b'.repeat(64),zip_url:'https://github.com/example/evaluator/archive/'+'a'.repeat(40)+'.zip'},
 validation:{build:'passed',contract_coverage:'passed',code_review:'passed',synthetic:'passed',known_score:'passed',invalid_submission:'passed',clean_clone:'passed',research_data:'validated',research_evidence:{passed:true,mode:'research',commit:'a'.repeat(40),contract_sha256:'b'.repeat(64),reference_sha256:'c'.repeat(64),artifact_sha256:'d'.repeat(64),report_sha256:'e'.repeat(64),checked_by:'controlled-runtime:1234567890abcdef',checked_at:'2026-11-12T20:00:00Z',expected_fitness:1,observed_fitness:1,tolerance:1e-6,expected_basis:'Independent calculation on declared input.'}},
 human_approval:{commit:'a'.repeat(40),contract_sha256:'b'.repeat(64),research_report_sha256:'e'.repeat(64),approved_by:'f'.repeat(64),approved_at:'2026-11-12T20:01:00Z',note:'I reviewed the code and research evidence.'}};}
function harness(allowed = () => true, readDirectory = async includePapers => ({projects:[],papers:includePapers ? new Map() : null})){
 const data=new Map([['projects/diverging-runs',{title:'Diverging runs'}],
  // Northstars and a moonshot (#248): the family tree's objectives are projects with a level.
  ['projects/ns-bp',{title:'Beyond Backpropagation',level:'northstar'}],['projects/ns-el',{title:'Embodied Learning',level:'northstar'}],
  ['projects/ns-hcld',{title:'Human-Centric Learning & Discovery',level:'northstar'}],['projects/moon',{title:'Moon',level:'moonshot',parents:['ns-el']}],['people/UDEFINER',{name:'Demo Researcher'}]]);
 const snap=p=>({id:p.split('/').pop(),exists:data.has(p),data:()=>structuredClone(data.get(p))});
 const doc=p=>({id:p.split('/').pop(),path:p,get:async()=>snap(p),collection:n=>col(p+'/'+n)});
 const kids=p=>[...data.keys()].filter(k=>k.startsWith(p+'/')&&k.split('/').length===p.split('/').length+1).map(snap);
 const col=p=>({get:async()=>({docs:kids(p)}),select:()=>({get:async()=>({docs:kids(p)})}),doc:id=>doc(p+'/'+id),orderBy:()=>({limit:()=>({get:async()=>({docs:[...data.keys()].filter(k=>k.startsWith(p+'/')&&k.split('/').length===p.split('/').length+1).map(snap)})})}),where:(key,op,value)=>({get:async()=>({docs:[...data.keys()].filter(k=>k.startsWith(p+'/')&&k.split('/').length===p.split('/').length+1&&data.get(k)[key]===value).map(snap)})})});
 const db={collection:col,runTransaction:async fn=>{const writes=[];const result=await fn({get:async ref=>ref.path?snap(ref.path):ref.get(),set:(ref,x)=>writes.push(()=>data.set(ref.path,structuredClone(x))),delete:ref=>writes.push(()=>data.delete(ref.path)),update:(ref,x)=>writes.push(()=>data.set(ref.path,{...data.get(ref.path),...structuredClone(x)}))});writes.forEach(f=>f());return result;}};
 class ErrorWithCode extends Error{constructor(code,message){super(message);this.code=code;}}
 let denied=false;
 const registry=factory({db,readDirectory,onCall:(_,fn)=>fn,callerEmail:r=>{if(!r.auth?.slack)throw new ErrorWithCode('unauthenticated','Slack required');return r.auth.email;},isFullWrite:async e=>e==='admin@example.invalid',access:{requireAccess:async(email,page,op)=>{if(denied || !allowed(page,op))throw new ErrorWithCode('permission-denied','Access denied');},can:async(email,page,op)=>!denied && allowed(page,op)},HttpsError:ErrorWithCode});
 const call=(value,email='owner@example.invalid')=>registry.run({auth:{slack:true,email},data:value});
 return {call,data,db,registry,deny:()=>{denied=true;}};
}
for(const change of ['research','approval','commit','reference','score','zip','mode','extra_url'])test('registration rejects '+change,()=>{
 const r=record();if(change==='research')r.validation.research_data='not_run';if(change==='approval')r.human_approval={commit:'bad'};if(change==='commit')r.validation.research_evidence.commit='0'.repeat(40);if(change==='reference')delete r.validation.research_evidence.reference_sha256;if(change==='score')r.validation.research_evidence.observed_fitness=2;if(change==='zip')r.evaluator.zip_url='https://github.com/example/evaluator/archive/main.zip';if(change==='mode')r.validation.research_evidence.mode='synthetic';if(change==='extra_url')r.evaluator.repository+='?token=private';assert.throws(()=>factory.normalize(r));
});
test('list and detail expose separate paper links only with Internal Review access', async()=>{
 const {papersByProblem} = require('../functions/past-paper');
 const first='ak-'+'a'.repeat(24), second='ak-'+'b'.repeat(24);
 const boards=[{id:'a',label:'Venue A'},{id:'z',label:'Venue Z',status:'approved'},{id:'p',status:'pending'},{id:'archived',archived:true}];
 const card=(id,boardId,openProblemId,extra={})=>({id,boardId,data:{title:'Same title',registrationKind:'past_paper',openProblemId,reviewNotes:'Private notes',...extra}});
 const cards=[card('z-card','z',first),card('a-card','a',first),card('other-card','a',second),
   card('pending','p',first),card('old','archived',first),card('deleted-venue','missing',first),card('project-card','a',first,{registrationKind:undefined})];
 const linkedProject={id:'project-card',title:'Existing project',openProblemId:first,board:'a'};
 let mayReadPapers=true;
 const h=harness((page,op)=>page!=='ml-cycle' || (op==='view' && mayReadPapers),async includePapers=>({
   projects:[linkedProject],papers:includePapers ? papersByProblem(boards,cards) : null
 }));
 for(const id of [first,second]) h.data.set('problemBank/'+id,{title:'Open question',projects:[]});
 const expected=[{id:'a-card',board:'a',venue:'Venue A',title:'Same title'},{id:'z-card',board:'z',venue:'Venue Z',title:'Same title'}];
 const list=await h.call({action:'list'}), detail=await h.call({action:'get',problem_id:first});
 assert.deepEqual(list.items[0].papers,expected);
 assert.deepEqual(detail.problem.papers,expected);
 assert.equal(list.items[1].papers[0].id,'other-card');
 assert.deepEqual(detail.problem.projects,[linkedProject]);assert.deepEqual(detail.versions,[]);
 assert.deepEqual(detail.problem.selected_projects,[]);
 cards.splice(0,cards.length);
 assert.deepEqual((await h.call({action:'get',problem_id:first})).problem.papers,[]);
 mayReadPapers=false;
 assert.equal((await h.call({action:'get',problem_id:first})).problem.papers,null);
 assert.ok((await h.call({action:'list'})).items.every(p=>p.papers===null));
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

test('a project is optional; a supplied project must be valid and exist',async()=>{
 const h=harness(),r=record();delete r.project_id;
 for (const value of ['', false, '../other', 2]) assert.throws(()=>factory.normalize({...r,project_id:value}), /project ID/);
 assert.throws(()=>factory.normalize({...r,project_board:'venue'}), /board/i);
 const receipt=await h.call({action:'register',registration:r});
 assert.deepEqual(await h.call({action:'register',registration:r}),receipt);
 const detail=await h.call({action:'get',problem_id:receipt.problem_id});
 assert.equal(detail.problem.stage,'validated');assert.deepEqual(detail.problem.projects,[]);
 assert.equal(detail.versions[0].project_id,'');assert.ok(detail.versions[0].reported_approval);
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
const openProblem = { action:'create', projects:[{id:'diverging-runs'}], title:'Estimate kinetics', owner_id:'UDEFINER', difficulties:'Sparse observations',
 significance:'A faster measurement', existing_solutions:'Least squares on clean signals', reminders:true, request_id:'98c689be-0660-4a12-9e63-be3abce09910' };
test('a problem can get a verifier before it gets a project',async()=>{
 const h=harness(), {problem_id}=await h.call({...openProblem,projects:[]});
 const registration={...record(),problem_id}; delete registration.project_id;
 const submit=(changes={},email)=>h.call({action:'register',registration:{...registration,...changes}},email);
 const first=await submit(), pinned=structuredClone(h.data.get('benchmarks/'+first.benchmark_id));
 assert.equal(first.problem_id,problem_id);
 assert.deepEqual(await submit(),first);
 const detail=await h.call({action:'get',problem_id});
 assert.equal(detail.problem.title,openProblem.title); assert.equal(detail.problem.stage,'validated');assert.deepEqual(detail.problem.projects,[]);
 await assert.rejects(submit({},'other@example.invalid'),{code:'permission-denied'});
 const key='5'.repeat(64),project_id='diverging-runs';
 await assert.rejects(submit({project_id,idempotency_key:key}),{code:'failed-precondition'});
 await h.call({action:'update',problem_id,changes:{projects:[{id:project_id}]}});
 assert.equal((await submit({project_id,idempotency_key:key})).benchmark_id,first.benchmark_id);
 assert.deepEqual(h.data.get('benchmarks/'+first.benchmark_id),pinned);
 await h.call({action:'update',problem_id,changes:{projects:[]}});
 await h.call({action:'update',problem_id,changes:{archived:true}});
 await assert.rejects(submit({source_id:'autokaggle:88888888-1111-2222-3333-444444444444',idempotency_key:'6'.repeat(64)}),{code:'failed-precondition'});
});
test('a definition needs a definer, scientific context and an explicit reminder choice; retries save one record',async()=>{
 const h=harness();
 for (const key of ['title','significance','existing_solutions','difficulties','owner_id','reminders','request_id']) {
   const bad={...openProblem};delete bad[key];await assert.rejects(h.call(bad),e=>e.code==='invalid-argument');
 }
 const saved=await h.call(openProblem);assert.deepEqual(await h.call(openProblem),saved);
 await assert.rejects(h.call({...openProblem,title:'Other'}),e=>e.code==='already-exists');
 const view=await h.call({action:'get',problem_id:saved.problem_id});
 assert.equal(view.problem.stage,'open');assert.equal(view.versions.length,0);assert.equal(view.history.length,1);
 assert.equal(view.problem.significance,openProblem.significance);assert.doesNotMatch(JSON.stringify(view),/@example|createFingerprint/);
});
test('two independent verifier sessions can each register version one without changing the research definition',async()=>{
 const h=harness(), {problem_id}=await h.call(openProblem);
 const r={...record(),problem_id};const a=await h.call({action:'register',registration:r},'other@example.invalid');
 const r2={...r,source_id:'autokaggle:99999999-2222-3333-4444-555555555555',idempotency_key:'9'.repeat(64)};
 const b=await h.call({action:'register',registration:r2});
 assert.notEqual(a.benchmark_id,b.benchmark_id);assert.equal(a.problem_id,b.problem_id);
 assert.deepEqual(a,await h.call({action:'register',registration:r},'other@example.invalid'));
 await assert.rejects(h.call({action:'register',registration:r}),e=>e.code==='permission-denied');
 const view=await h.call({action:'get',problem_id});
 assert.equal(view.versions.length,2);assert.equal(view.problem.title,openProblem.title);assert.equal(view.problem.can_edit,true);
 assert.equal(view.problem.significance,openProblem.significance);assert.equal(view.history[0].createdBy,undefined);
 assert.equal(h.data.get('problemBank/'+problem_id).verifierNoticeDue,null);
 const second=await h.call({...openProblem,request_id:'99999999-2222-3333-4444-555555555555'});
 await assert.rejects(h.call({action:'register',registration:{...r,problem_id:second.problem_id}},'other@example.invalid'),e=>e.code==='failed-precondition');
 h.data.set('projects/other',{title:'Other'});
 await assert.rejects(h.call({action:'register',registration:{...r2,source_id:'autokaggle:12345678-1234-1234-1234-123456789012',project_id:'other',idempotency_key:'8'.repeat(64)}}),e=>e.code==='failed-precondition');
 await assert.rejects(h.call({action:'register',registration:{...r,problem_id:'ak-'+'0'.repeat(24)}}),e=>e.code==='not-found');
});
test('only the submitter sets reminders; retries, paused problems and actual verifier registration control delivery',async()=>{
 const h=harness(),{problem_id}=await h.call(openProblem),ref=h.db.collection('problemBank').doc(problem_id);
 const {sendDue,WEEK}=require('../functions/problem-reminders'), sends=[];
 const start=h.data.get(ref.path).verifierNoticeDue, notify=x=>sends.push(x);
 await sendDue(h.db,ref,notify,start);await sendDue(h.db,ref,notify,start);await sendDue(h.db,ref,notify,start+WEEK-1);
 assert.equal(sends.length,1);await sendDue(h.db,ref,notify,start+WEEK);assert.equal(sends.length,2);assert.equal(sends[0].email,'owner@example.invalid');
 const pref={action:'reminders',problem_id,reminders:false};
 await assert.rejects(h.call(pref,'admin@example.invalid'),e=>e.code==='permission-denied');await h.call(pref);
 await sendDue(h.db,ref,notify,start+2*WEEK);assert.equal(sends.length,2);
 await h.call({...pref,reminders:true});const edit={action:'update',problem_id,project_id:'diverging-runs',notes:'',archived:true};
 await h.call(edit);await sendDue(h.db,ref,notify,start+3*WEEK);assert.equal(sends.length,2);
 await h.call({...edit,archived:false});await sendDue(h.db,ref,notify,start+3*WEEK);assert.equal(sends.length,3);
 await h.call({action:'register',registration:{...record(),problem_id}});await sendDue(h.db,ref,notify,start+4*WEEK);assert.equal(sends.length,3);
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
 await assert.rejects(h.call({action:'create',project_id:'diverging-runs',title:'Q',objective:'O',task_kind:'k',owner_id:'UOWNER1'},'admin@example.invalid'),e=>e.code==='invalid-argument');
});

test('define a problem first, add projects later, and release independent verifier contracts', async()=>{
 const h=harness(); h.data.set('people/UOWNER1',{name:'Rae'});h.data.set('projects/second',{title:'Second project'});
 const proposal={...openProblem,projects:[],owner_id:'UOWNER1',difficulties:'Sparse observations',collaborators:'Lin'};
 delete proposal.objective;delete proposal.project_id;
 for (const field of ['difficulties','owner_id','existing_solutions','significance']) await assert.rejects(h.call({...proposal,[field]:''}));
 const {problem_id}=await h.call(proposal);
 const view=()=>h.call({action:'get',problem_id});
 assert.deepEqual((await view()).problem.projects,[]);assert.equal((await view()).problem.details.owner,'Rae');
 await assert.rejects(h.call({action:'update',problem_id,changes:{projects:[{id:'missing'}]}}));
 const change=changes=>h.call({action:'update',problem_id,changes});
 await change({projects:[{id:'diverging-runs'},{id:'second'},{id:'second'}]});await change({difficulties:'Noisy traces'});
 assert.equal((await view()).problem.projects.length,2);assert.equal((await view()).problem.details.collaborators,'Lin');
 const reg={...record(),problem_id,project_id:'second',details:{data_assets:'Reference traces',metrics:'MAE',score_format:'JSON fitness',submission_format:'CSV',constraints:'CPU only'}};
 await h.call({action:'register',registration:reg});
 const result=await view();assert.equal(result.problem.project_id,'diverging-runs');assert.equal(result.problem.details.metrics,undefined);assert.deepEqual(result.versions[0].details,reg.details);
 await assert.rejects(change({projects:[{id:'diverging-runs'}]}),/Keep the project/);
 await assert.rejects(h.call({action:'register',registration:{...reg,idempotency_key:'8'.repeat(64),details:{metrics:'RMSE'}}}),/different evidence/);
 assert.ok((await h.call({action:'open_choices'})).items.some(p=>p.id===problem_id));
});

const familyInput = (parents = [], related = []) => ({parents,related});
function createFamilyProblem(h, title, family){
  return h.call({...openProblem, title, family, request_id:require('node:crypto').randomUUID()}).then(row => row.problem_id);
}
test('family spans all problem stages, reads northstars and moonshots from Projects and keeps audit fields private',async()=>{
  const h=harness();
  const a=await createFamilyProblem(h,'Market simulation',familyInput(['ns-bp','ns-el']));
  const b=await createFamilyProblem(h,'Trading cost',familyInput([a]));
  const c=await createFamilyProblem(h,'Price response',familyInput([b,'ns-hcld'],[a]));
  h.data.get('problemBank/'+c).stage='validated';
  const graph=await h.call({action:'family'});
  assert.equal(graph.problems.find(x=>x.id===c).stage,'validated');
  assert.deepEqual(graph.objectives.map(x=>[x.title,x.kind]).sort(),[['Beyond Backpropagation','northstar'],['Embodied Learning','northstar'],['Human-Centric Learning & Discovery','northstar'],['Moon','moonshot']]);
  assert.equal(graph.can_manage_objectives,false);
  assert.ok(graph.edges.some(e=>e.from==='moon' && e.to==='ns-el' && e.kind==='contributes_to'),'a moonshot under its northstar');
  assert.equal(graph.edges.length,7);
  assert.equal(graph.edges.filter(e=>e.kind==='related_to').length,1);
  assert.deepEqual(graph.edges.find(e=>e.kind==='related_to'),{kind:'related_to',from:[a,c].sort()[0],to:[a,c].sort()[1]});
  assert.doesNotMatch(JSON.stringify(graph),/@example|createdBy|updatedBy/);
  const d={...openProblem,title:'Fourth',request_id:require('node:crypto').randomUUID(),family:familyInput([a,'ns-el'])};
  const saved=await h.call(d);
  assert.deepEqual(await h.call({...d,family:familyInput(['ns-el',a])}),saved);
  await assert.rejects(h.call({...d,family:familyInput([a])}),e=>e.code==='already-exists');
  const view=await h.call({action:'get',problem_id:saved.problem_id});
  assert.deepEqual(view.history[0].familyChange.after, familyInput([a,'ns-el'].sort()));
  assert.doesNotMatch(JSON.stringify(view),/@example/);
});
test('family changes detect stale edits and reject invalid links and cycles without losing other changes',async()=>{
  const h=harness();const a=await createFamilyProblem(h,'A');const b=await createFamilyProblem(h,'B');const c=await createFamilyProblem(h,'C');
  const set=(problem_id,family,previous=familyInput(),email)=>h.call({action:'set_family',problem_id,family,previous},email);
  await assert.rejects(set(a,familyInput([b]),familyInput(),'other@example.invalid'),e=>e.code==='permission-denied');
  await set(a,familyInput([b]));await set(b,familyInput([c]));
  await assert.rejects(set(c,familyInput([a])),e=>e.code==='failed-precondition');
  await assert.rejects(set(c,familyInput(['ak-'+'2'.repeat(24)])),e=>e.code==='failed-precondition');
  await assert.rejects(set(c,familyInput([b],[b])),e=>e.code==='invalid-argument');
  await assert.rejects(set(c,familyInput([],[b])),e=>e.code==='invalid-argument');
  await assert.rejects(set(c,familyInput([c])),e=>e.code==='invalid-argument');
  await assert.rejects(set(c,familyInput(['not an id!'])),e=>e.code==='invalid-argument');
  await assert.rejects(set(c,familyInput(['nowhere'])),e=>e.code==='failed-precondition');
  await assert.rejects(set(c,familyInput(['diverging-runs'])),e=>e.code==='failed-precondition'); // a stepping stone is no objective
  await assert.rejects(set(a,familyInput(['ns-bp'])),e=>e.code==='aborted');
  const oldHistory=(await h.call({action:'get',problem_id:a})).history.length;
  await set(a,familyInput([b])); // retry after a lost success response
  assert.equal((await h.call({action:'get',problem_id:a})).history.length,oldHistory);
  await set(a,familyInput(['ns-bp'],[c]),familyInput([b]));
  await set(c,familyInput(),familyInput([],[a]));
  const graph=await h.call({action:'family'}); assert.equal(graph.edges.filter(x=>x.kind==='related_to').length,0);
  const reg=record();reg.problem_id=a;const receipt=await h.call({action:'register',registration:reg});
  await set(a,familyInput(['ns-el']),familyInput(['ns-bp']),'admin@example.invalid');
  const view=await h.call({action:'get',problem_id:a});
  assert.equal(view.versions[0].id,receipt.benchmark_id);assert.equal(view.problem.stage,'validated');assert.equal(view.problem.projects[0].id,'diverging-runs');
  assert.equal(view.can_approve,false);
});
test('a problem contributes to a moonshot project, and the moonshot must still be one',async()=>{
  const h=harness();
  const a=await createFamilyProblem(h,'A',familyInput(['moon']));
  const g=await h.call({action:'family'});
  assert(g.edges.some(e=>e.from===a && e.to==='moon'));
  const b=await createFamilyProblem(h,'B');
  const set=(id,family,previous=familyInput())=>h.call({action:'set_family',problem_id:id,family,previous});
  h.data.get('projects/moon').level=undefined; // made a stepping stone
  await assert.rejects(set(b,familyInput(['moon'])),e=>e.code==='failed-precondition');
  await set(a,familyInput(),familyInput(['moon'])); // removing the old link is still fine
});
test('a researcher can edit a problem with more than 100 incoming related links',async()=>{
  const h=harness(), central=await createFamilyProblem(h,'Shared research theme'), peers=[];
  for (let i=0;i<104;i++) peers.push(await createFamilyProblem(h,'Contributor '+i,familyInput([],[central])));
  await h.call({action:'set_family',problem_id:central,previous:familyInput([],peers),family:familyInput(['ns-el'],peers.slice(3))});
  const edges=(await h.call({action:'family'})).edges;
  assert.equal(edges.filter(x=>x.kind==='related_to').length,101);
  assert(edges.some(x=>x.from===central && x.to==='ns-el'));
});

const verificationSource = 'ak-'+'8'.repeat(24), researchQuestion = 'ak-'+'9'.repeat(24);
function proposalRequest(plan) {
 const email='owner@example.invalid';
 return {action:'create_project_proposal',project_id:'card-new-test',card:{submittedBy:{email},title:'Learning signals',abstractText:'Test the conditions for a reliable result.',openProblemId:researchQuestion, verificationPlan:plan,proposal:{status:'proposed',more:false,by:email},setUpSkipped:['repo','channel']}};
}
function proposalFixtures(h) {
 h.data.set('problemBank/'+researchQuestion,{title:'Question',stage:'checked',archived:false});
 h.data.set('problemBank/'+verificationSource,{title:'Existing protocol',stage:'implemented',archived:false});
 return ['a','b'].map((char,index)=>{
  const id='ak-'+'2'.repeat(24)+'-'+char.repeat(40);
  h.data.set('benchmarks/'+id,{title:'Reusable protocol',problem_id:verificationSource,evaluator:{version:index+1}});
  return id;
 });
}
test('new projects pin release IDs and canonical summaries from another active problem in requested order',async()=>{
 const h=harness(), ids=proposalFixtures(h).reverse(), req=proposalRequest({mode:'linked',releaseIds:ids});
 const out=await h.call(req);assert.deepEqual(out,{project_id:req.project_id});
 const stored=h.data.get('projects/'+req.project_id);
 assert.equal(stored.openProblemId,researchQuestion);
 assert.deepEqual(stored.verificationPlan.releases,ids.map((id,i)=>({id,problem_id:verificationSource,title:'Reusable protocol',version:2-i})));
 assert.deepEqual(stored.verificationPlan.releaseIds,ids);
 assert.deepEqual(stored.setUpSkipped,['repo','channel']); assert.equal(stored.status,'register');
 assert.equal(stored.submittedBy.email,'owner@example.invalid'); assert.equal(stored.proposal.more,false);
 assert.deepEqual(await h.call(req),out);
 h.data.delete('projects/'+req.project_id);assert.deepEqual(await h.call(req),out);assert.equal(h.data.has('projects/'+req.project_id),false);
 req.card.title='Changed after first submission';await assert.rejects(h.call(req),{code:'already-exists'});
});
test('deferred projects require a reason and expected onboarding time and retain the GPU allowance checks',async()=>{
 const h=harness();proposalFixtures(h);
 const plan={mode:'deferred',reason:'  The licence is pending. ',expectedOnboarding:'Within two weeks of data access.'}, req=proposalRequest(plan);
 for(const invalid of [undefined,{}, {...plan,reason:' '},{...plan,expectedOnboarding:''},{...plan,releaseIds:[]},{mode:'linked',releaseIds:[]}]){
  await assert.rejects(h.call({...req,card:{...req.card,verificationPlan:invalid}}),{code:'invalid-argument'});
 }
 for(const bad of [{status:'approved',more:false},{status:'proposed',more:true,gpuHours:0},{status:'proposed',more:false,gpuHours:100},{status:'proposed',more:true},{status:'proposed',more:true,gpuHours:1e8},{status:'proposed',more:true,gpuHours:2,dueAt:1}]){
  await assert.rejects(h.call({...req,card:{...req.card,proposal:bad}}),{code:'invalid-argument'});
 }
 await assert.rejects(h.call(req,'other@example.invalid'),{code:'permission-denied'});
 await h.call({...req,card:{...req.card,proposal:{status:'proposed',more:true,gpuHours:12}}});
 const saved=h.data.get('projects/'+req.project_id);
 assert.equal(saved.verificationPlan.reason,'The licence is pending.');
 assert.equal(saved.verificationPlan.expectedOnboarding,plan.expectedOnboarding);assert.equal(saved.proposal.gpuHours,12);
});
test('missing or archived source, forged summaries, duplicate release IDs and archived research questions are rejected',async()=>{
 const h=harness(), ids=proposalFixtures(h), req=proposalRequest({mode:'linked',releaseIds:ids});
 for (const selection of [{mode:'linked',releaseIds:[ids[0],ids[0]]},{mode:'linked',releaseIds:ids,releases:[{title:'Forged'}]}]) {
  await assert.rejects(h.call({...req,card:{...req.card,verificationPlan:selection}}),{code:'invalid-argument'});
 }
 for(const key of [verificationSource,researchQuestion]) {
  const doc=h.data.get('problemBank/'+key);doc.archived=true;await assert.rejects(h.call(req),{code:'failed-precondition'});doc.archived=false;
 }
 h.data.delete('benchmarks/'+ids[0]);await assert.rejects(h.call(req),{code:'failed-precondition'});
 assert.equal(h.data.has('projects/'+req.project_id),false);assert.equal(h.data.has('projectProposalReceipts/'+req.project_id),false);
});

const paperProblem = 'ak-'+'3'.repeat(24);
function paperRequest(){
  return {action:'register_past_paper', board:'venue-1', problem_id:paperProblem,
    request_id:require('node:crypto').randomUUID(), title:'  Forecasting tidal power ', compute_estimate:'6 CPU hours', note:'Archived experiment.'};
}
function paperFixture(h) {
  h.data.set('boards/venue-1',{status:'approved'});
  h.data.set('problemBank/'+paperProblem,{title:'Predict tidal generation',stage:'validated',createdBy:'private@example.invalid',notes:'private'});
}
test('Internal Review and Projects editors can register existing work without a project or a verifier',async()=>{
  for (const area of ['ml-cycle','projects']){
    const h=harness((page,op)=>page===area && op==='edit');paperFixture(h);
    h.data.set('problemBank/ak-'+'4'.repeat(24),{title:'Old question',archived:true});
    h.data.set('problemBank/bad-id',{title:'Malformed import'});
    const expected={items:[{id:paperProblem,title:'Predict tidal generation'}]};
    assert.deepEqual(await h.call({action:'past_paper_problem_choices'}),expected);
    await assert.rejects(h.call({action:'get',problem_id:paperProblem}),{code:'permission-denied'});
    const before=[...h.data.keys()], req=paperRequest(), result=await h.call(req), key='boards/venue-1/cards/'+result.card_id;
    assert.deepEqual(result,{board:'venue-1',card_id:result.card_id});
    assert.match(result.card_id,/^paper-[a-f0-9]{24}$/);
    const paper = h.data.get(key);
    assert.equal(paper.title,'Forecasting tidal power');assert.equal(paper.openProblemId,paperProblem);
    assert.equal(paper.openProblemTitle,'Predict tidal generation');assert.equal(paper.registrationKind,'past_paper');
    assert.equal(paper.submittedBy.email,'owner@example.invalid');assert.equal(paper.status,'register');
    assert.equal(paper.history[0].note,req.note);assert.equal(paper.computeEstimate,req.compute_estimate);
    for(const field of ['projectId','proposal','verificationPlan','setUpRepo']) assert.equal(paper[field],undefined);
    assert.deepEqual([...h.data.keys()].filter(k=>!before.includes(k)).sort(),[key,'paperRegistrationReceipts/'+result.card_id]);
    assert.deepEqual(await h.call(req),result);
    for(const changes of [{title:'A different paper'},{board:'another-venue'}])
      await assert.rejects(h.call({...req,...changes}),{code:'already-exists'});
    h.data.delete(key);await assert.rejects(h.call(req),{code:'not-found'});
  }
});
test('paper registration checks scientific problem and venue and rejects forged project or review fields',async()=>{
  const h=harness(), req=paperRequest();paperFixture(h);
  for (const change of [{title:' '},{request_id:'1'},{board:'venue/1'},{problem_id:'bad'},{note:'x'.repeat(4001)},
    {openProblemTitle:'Injected'},{submittedBy:{email:'other@example.invalid'}},{proposal:{status:'approved'}},
    {verificationPlan:{mode:'deferred'}},{projectId:'project'},{registrationKind:'something_else'},{status:'conference'}])
    await assert.rejects(h.call({...req,...change}),{code:'invalid-argument'});
  for(const patch of [{status:'pending'},{archived:true},{status:'rejected'}]){
    h.data.set('boards/venue-1',patch);await assert.rejects(h.call(req),{code:'failed-precondition'});
  }
  h.data.delete('boards/venue-1');await assert.rejects(h.call(req),{code:'failed-precondition'});
  h.data.set('boards/venue-1',{});h.data.get('problemBank/'+paperProblem).archived=true;
  await assert.rejects(h.call(req),{code:'failed-precondition'});
  h.data.delete('problemBank/'+paperProblem);await assert.rejects(h.call(req),{code:'failed-precondition'});
  assert.equal([...h.data.keys()].some(k=>k.startsWith('paperRegistrationReceipts/')),false);
  const denied=harness((page,op)=>op==='view');
  await assert.rejects(denied.call({action:'past_paper_problem_choices'}),{code:'permission-denied'});
  await assert.rejects(denied.call(req),{code:'permission-denied'});
  await assert.rejects(h.registry.run({data:req}),{code:'unauthenticated'});
});
test('a standalone review paper cannot stand in for the project sponsoring a benchmark',async()=>{
  const h=harness();paperFixture(h);
  const {card_id,board}=await h.call(paperRequest());
  const registration={...record(),project_id:card_id,project_board:board};
  await assert.rejects(h.call({action:'register',registration}),{code:'failed-precondition'});
});

test('benchmark-building problems skip verifier registration and notices without acquiring validation evidence', async () => {
  const h = harness();
  const create = {...openProblem, builds_benchmark:true};
  const saved = await h.call(create), id = saved.problem_id;
  assert.deepEqual(await h.call({...create,reminders:false}),saved);
  const automatic={...create}; delete automatic.reminders;
  assert.deepEqual(await h.call(automatic),saved);
  await assert.rejects(h.call({...create,builds_benchmark:false}),{code:'already-exists'});
  await assert.rejects(h.call({...create,builds_benchmark:'true'}),{code:'invalid-argument'});
  const detail = await h.call({action:'get',problem_id:id});
  assert.equal(detail.problem.builds_benchmark,true);
  assert.equal(detail.problem.stage,'open');
  assert.deepEqual(detail.versions,[]);
  assert.equal(detail.problem.evaluator,undefined);
  assert.equal(detail.problem.reminders,false);
  assert.equal(detail.can_manage_reminders,false);
  for (const data of [(await h.call({action:'open_choices'})).items,(await h.call({action:'list'})).items,(await h.call({action:'family'})).problems])
    assert.equal(data.find(p=>p.id===id).builds_benchmark,true);
  assert.deepEqual((await h.call({action:'past_paper_problem_choices'})).items,[{id,title:create.title}]);
  const path = 'problemBank/'+id, ref = h.db.collection('problemBank').doc(id);
  assert.equal(h.data.get(path).verifierNoticeDue,null);
  await assert.rejects(h.call({action:'reminders',problem_id:id,reminders:true}),{code:'failed-precondition'});
  // An old queued notice must also respect the current purpose of the problem.
  Object.assign(h.data.get(path),{reminders:true,verifierNoticeDue:1});
  const {sendDue} = require('../functions/problem-reminders');
  assert.equal(await sendDue(h.db,ref,()=>assert.fail('unexpected reminder'),2),false);
  const registration={...record(),problem_id:id};
  await assert.rejects(h.call({action:'register',registration}),{code:'failed-precondition'});
  assert.ok([...h.data.keys()].every(path=>!path.startsWith('benchmark')));
});

test('changing the purpose keeps existing releases and receipts and cancels pending reminders', async () => {
  const h = harness(), {problem_id} = await h.call(openProblem);
  const registration = {...record(),problem_id};
  const first = await h.call({action:'register',registration});
  const edit = changes=>({action:'update',problem_id,changes});
  await assert.rejects(h.call(edit({builds_benchmark:true}),'other@example.invalid'),{code:'permission-denied'});
  await assert.rejects(h.call(edit({builds_benchmark:'false'})),{code:'invalid-argument'});
  await h.call(edit({builds_benchmark:true}));
  assert.deepEqual(await h.call({action:'register',registration}),first);
  const prior = await h.call({action:'get',problem_id});
  assert.equal(prior.problem.stage,'validated'); assert.equal(prior.versions[0].id,first.benchmark_id);
  const next = {...registration,source_id:'autokaggle:88888888-1111-2222-3333-444444444444',idempotency_key:'7'.repeat(64)};
  await assert.rejects(h.call({action:'register',registration:next}),{code:'failed-precondition'});
  await h.call(edit({builds_benchmark:false}));
  assert.equal((await h.call({action:'get',problem_id})).problem.reminders,false);
  assert.equal((await h.call({action:'register',registration:next})).problem_id,problem_id);
  const another = await h.call({...openProblem,request_id:'99999999-7777-6666-5555-444444444444'});
  const path = 'problemBank/'+another.problem_id;
  assert.ok(h.data.get(path).verifierNoticeDue);
  await h.call({action:'update',problem_id:another.problem_id,changes:{builds_benchmark:true,archived:true}});
  await h.call({action:'update',problem_id:another.problem_id,changes:{archived:false}});
  assert.equal(h.data.get(path).verifierNoticeDue,null); assert.equal(h.data.get(path).verifierNoticeCycle,null);
  await h.call({action:'update',problem_id:another.problem_id,changes:{builds_benchmark:false}});
  assert.equal((await h.call({action:'get',problem_id:another.problem_id})).can_manage_reminders,true);
  await h.call({action:'reminders',problem_id:another.problem_id,reminders:true});
  assert.ok(h.data.get(path).verifierNoticeDue>0);
});

test('a project can explicitly build a benchmark or inherit that purpose from its problem', async () => {
  const h = harness(), ids = proposalFixtures(h), problem = h.data.get('problemBank/'+researchQuestion);
  const req = proposalRequest({mode:'benchmark'});
  for (const invalid of [{mode:'benchmark',releaseIds:ids},{mode:'benchmark',reason:'pending'}])
    await assert.rejects(h.call(proposalRequest(invalid)),{code:'invalid-argument'});
  await h.call(req);
  assert.deepEqual(h.data.get('projects/'+req.project_id).verificationPlan,{mode:'benchmark'});
  assert.equal(problem.builds_benchmark,undefined);
  // Removing an explicit project-level decision changes the request. An old receipt cannot confirm that change.
  await assert.rejects(h.call(proposalRequest(undefined)),{code:'already-exists'});
  problem.builds_benchmark = true;
  for (const stale of [{mode:'linked',releaseIds:ids},{mode:'deferred',reason:'pending',expectedOnboarding:'next week'}])
    await assert.rejects(h.call({...proposalRequest(stale),project_id:'card-benchmark-child'}),{code:'failed-precondition'});
  const inherited = {...proposalRequest(undefined),project_id:'card-benchmark-child'};
  const saved = await h.call(inherited);
  assert.deepEqual(h.data.get('projects/'+inherited.project_id).verificationPlan,{mode:'benchmark'});
  assert.deepEqual(await h.call(inherited),saved);
  problem.archived = true;
  await assert.rejects(h.call({...inherited,project_id:'card-closed'}),{code:'failed-precondition'});
});

test('a disabled handoff never issues a credential or accepts a service release', {skip:process.env.BOLD_LINKED_VERIFIER_HANDOFF_ENABLED === 'true'}, async () => {
  const h=harness(), {problem_id}=await h.call(openProblem);
  // The default config omits both the enable flag and service token digest.
  const view=await h.call({action:'get',problem_id});
  assert.equal(view.handoff_enabled,false);assert.equal(view.problem.handoff_enabled,false);
  await assert.rejects(h.call({action:'issue_verifier_handoff',problem_id}),{code:'failed-precondition'});
  await assert.rejects(h.registry.runLinkedService('register_linked_verifier',{registration:record()}),{code:'failed-precondition'});
  assert.ok([...h.data.keys()].every(key=>!key.startsWith('verifierHandoffs/')));
});

test('required handoffs distinguish incomplete deployment from insufficient Problem Bank access', async () => {
  const flag='BOLD_LINKED_VERIFIER_HANDOFF_ENABLED', digest='BOLD_LINKED_VERIFIER_SERVICE_TOKEN_SHA256';
  const previous={[flag]:process.env[flag],[digest]:process.env[digest]};
  try {
    process.env[flag]='true'; process.env[digest]='incomplete';
    const h=harness(), {problem_id}=await h.call(openProblem), query={action:'get',problem_id};
    const partial=await h.call(query);
    assert.equal(partial.handoff_enabled,true); assert.equal(partial.problem.handoff_enabled,false);
    assert.match(partial.problem.handoff_unavailable_reason,/administrator.*configuring/i);
    await assert.rejects(h.call({action:'issue_verifier_handoff',problem_id}),{code:'failed-precondition'});
    process.env[digest]='a'.repeat(64);
    const readonly=harness((page,op)=>op==='view');
    readonly.data.set('problemBank/'+problem_id,h.data.get('problemBank/'+problem_id));
    const blocked=await readonly.call(query);
    assert.equal(blocked.handoff_enabled,true); assert.equal(blocked.problem.handoff_enabled,false);
    assert.match(blocked.problem.handoff_unavailable_reason,/permission to edit the Problem Bank/);
    await assert.rejects(readonly.call({action:'issue_verifier_handoff',problem_id}),{code:'permission-denied'});
    const ready=await h.call(query);
    assert.equal(ready.problem.handoff_enabled,true); assert.equal(ready.problem.handoff_unavailable_reason,undefined);
  } finally {
    for (const [k,v] of Object.entries(previous)) {if(v===undefined) delete process.env[k]; else process.env[k]=v;}
  }
});

// The Problem Bank has its own row in Who can do what (2026-11-27): PAN-BOLD reads and adds
// problems without Projects access, and gets nothing of Projects through it.
const directoryWithVenue = async includePapers => ({projects:[{id:'diverging-runs',stable_id:'diverging-runs',board:'',title:'Diverging runs',venue:'ICLR 2027',openProblemId:''}],papers:includePapers ? new Map() : null});
test('Problem Bank access alone reads, adds and edits problems', async () => {
  const h = harness(page => page === 'problem-bank', directoryWithVenue);
  const {problem_id} = await h.call(openProblem);
  assert.equal((await h.call({action:'list'})).items.length, 1);
  assert.equal((await h.call({action:'get',problem_id})).problem.title, openProblem.title);
  assert.ok((await h.call({action:'search'})).items.some(x => x.problem_id === problem_id));
  assert.ok((await h.call({action:'family'})).problems.some(x => x.id === problem_id));
  assert.ok((await h.call({action:'open_choices'})).items.some(x => x.id === problem_id));
  await h.call({action:'update',problem_id,changes:{title:'Estimate kinetics from sparse data'}});
  assert.equal(h.data.get('problemBank/'+problem_id).title, 'Estimate kinetics from sparse data');
});
test('Problem Bank access alone gives no Projects action and no venue', async () => {
  const h = harness(page => page === 'problem-bank', directoryWithVenue);
  const {problem_id} = await h.call(openProblem);
  await assert.rejects(h.call({action:'create_project_proposal'}), {code:'permission-denied'});
  await assert.rejects(h.call({action:'register_past_paper'}), {code:'permission-denied'});
  await assert.rejects(h.call({action:'past_paper_problem_choices'}), {code:'permission-denied'});
  const titles = [(await h.call({action:'projects'})).items, (await h.call({action:'get',problem_id})).problem.projects, (await h.call({action:'list'})).items[0].projects];
  for (const rows of titles) { assert.equal(rows[0].title, 'Diverging runs'); assert.equal('venue' in rows[0], false); }
  const all = harness(() => true, directoryWithVenue);
  assert.equal((await all.call({action:'projects'})).items[0].venue, 'ICLR 2027');
});
test('Projects access alone keeps the project form’s choices and gets no Problem Bank page', async () => {
  const h = harness(page => page === 'projects', directoryWithVenue);
  assert.deepEqual((await h.call({action:'open_choices'})).items, []);
  await assert.rejects(h.call({action:'list'}), {code:'permission-denied'});
  await assert.rejects(h.call(openProblem), {code:'permission-denied'});
});
test('Lite claims a handoff for a member with Problem Bank access, not Projects access', async () => {
  const flag='BOLD_LINKED_VERIFIER_HANDOFF_ENABLED', digest='BOLD_LINKED_VERIFIER_SERVICE_TOKEN_SHA256';
  const previous={[flag]:process.env[flag],[digest]:process.env[digest]};
  try {
    process.env[flag]='true'; process.env[digest]='a'.repeat(64);
    const claim = h => h.registry.runLinkedService('claim_verifier_handoff',{email:'owner@example.invalid',handoff:'none',session_id:'none'});
    await assert.rejects(claim(harness(page => page === 'projects')), {code:'permission-denied'});
    await assert.rejects(claim(harness(page => page === 'problem-bank')), e => e.code !== 'permission-denied');
  } finally {
    for (const [k,v] of Object.entries(previous)) {if(v===undefined) delete process.env[k]; else process.env[k]=v;}
  }
});
