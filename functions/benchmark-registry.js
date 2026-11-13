// Problem Bank and pinned benchmark releases. Called through the site's normal
// Slack-authenticated callable, including approved acting tokens via boldApi.
const crypto = require('crypto');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const hex = (value, n) => typeof value === 'string' && new RegExp('^[a-f0-9]{' + n + '}$').test(value);
const canonical = value => JSON.stringify(value, function(k,v){ return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key,v[key]])) : v; });
function text(value, limit, label){
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error('Supply ' + label + ' within ' + limit + ' characters.');
  return value.trim();
}
function normalize(input){
  if (!input || input.schema !== 'bold.autokaggle.registration.v1' || Buffer.byteLength(JSON.stringify(input)) > 128000) throw new Error('Use a bounded AutoKaggle registration record.');
  if (!/^autokaggle:[a-f0-9-]{36}$/.test(input.source_id || '') || !hex(input.idempotency_key,64)) throw new Error('Supply the stable source ID and request key.');
  if (canonical(input.destinations) !== canonical(['problem_bank'])) throw new Error('Register in the Problem Bank.');
  const project_id = text(input.project_id,160,'the BOLD OS project ID');
  if (!/^[A-Za-z0-9_-]+$/.test(project_id)) throw new Error('Use a valid BOLD OS project ID.');

  const e = input.evaluator || {}, v = input.validation || {}, r = v.research_evidence || {}, a = input.human_approval || {};
  if (!hex(e.commit,40) || !hex(e.contract_sha256,64) || !Number.isSafeInteger(e.version) || e.version < 1) throw new Error('Pin the evaluator commit, contract, and version.');
  const repo = new URL(e.repository);
  if (repo.protocol !== 'https:' || repo.hostname !== 'github.com' || repo.username || repo.password || repo.port || repo.search || repo.hash || !/^\/[\w.-]+\/[\w.-]+$/.test(repo.pathname)) throw new Error('Use a GitHub repository HTTPS link without a token.');
  if (e.zip_url !== e.repository + '/archive/' + e.commit + '.zip') throw new Error('The ZIP must name the pinned evaluator commit.');
  if (['build','contract_coverage'].some(k => v[k] !== 'passed')) throw new Error('Implementation and full contract coverage must pass.');
  const checked = ['code_review','synthetic','known_score','invalid_submission','clean_clone'].every(k => v[k] === 'passed');
  const validated = v.research_data === 'validated';
  if (validated && !checked) throw new Error('Complete all software checks before research validation.');
  if (validated) {
  if (r.passed !== true || r.mode !== 'research' || r.commit !== e.commit || r.contract_sha256 !== e.contract_sha256 || !hex(r.reference_sha256,64) || !hex(r.artifact_sha256,64) || !hex(r.report_sha256,64) || !/^controlled-runtime:[a-f0-9]{16}$/.test(r.checked_by || '')) throw new Error('Research evidence must bind the assets and controlled run to this release.');
  if (![r.observed_fitness,r.expected_fitness,r.tolerance].every(Number.isFinite) || r.tolerance < 0 || r.tolerance > 1e-5 || Math.abs(r.observed_fitness-r.expected_fitness) > Math.max(r.tolerance,r.tolerance*Math.max(Math.abs(r.expected_fitness),Math.abs(r.observed_fitness)))) throw new Error('The declared and measured fitness do not agree.');
  }
  const approved = Object.keys(a).length > 0;
  if (approved && (!validated || a.commit !== e.commit || a.contract_sha256 !== e.contract_sha256 || a.research_report_sha256 !== r.report_sha256 || !hex(a.approved_by,64) || !a.approved_at)) throw new Error('A human must approve this exact release and research report.');
  // Store only the public-to-lab evidence. No file paths, email addresses, tokens,
  // raw transcripts, or arbitrary extra caller fields enter these collections.
  const clean = {schema:input.schema,source_id:input.source_id,idempotency_key:input.idempotency_key,
    project_id,project_board:boardId(input.project_board),stage:validated?'validated':checked?'checked':'implemented',
    validation:Object.fromEntries(['build','contract_coverage','code_review','synthetic','known_score','invalid_submission','clean_clone','research_data'].map(k=>[k,v[k]||'not_run'])),
    details:details(input.details),session:session(input.session,input.source_id),
    title:text(input.title,180,'the title'),objective:text(input.objective,8000,'the objective'),task_kind:text(input.task_kind,80,'the task kind'),
    evaluator:{repository:e.repository,commit:e.commit,version:e.version,zip_url:e.zip_url,contract_sha256:e.contract_sha256},
    research:validated?{reference_sha256:r.reference_sha256,artifact_sha256:r.artifact_sha256,report_sha256:r.report_sha256,checked_by:r.checked_by,
      checked_at:text(r.checked_at,80,'the validation time'),observed_fitness:r.observed_fitness,expected_fitness:r.expected_fitness,tolerance:r.tolerance,
      expected_basis:text(r.expected_basis,4000,'the expected-score basis')}:null,
    approval:approved?{approved_by:a.approved_by,approved_at:text(a.approved_at,80,'the approval time'),note:text(a.note,4000,'the approval note')}:null};
  return clean;
}
function boardId(value){if(value==null||value==='')return '';if(typeof value!=='string'||! /^[A-Za-z0-9_-]{1,160}$/.test(value))throw new Error('Invalid project board.');return value;}
const DETAIL_FIELDS = ['owner','collaborators','submission_format','metrics','run_command','dependencies','seeds','compute','data_assets','limitations','open_issues','next_action'];
function details(input={}) {
  const out={};
  for(const k of DETAIL_FIELDS) if(input[k] != null && input[k] !== '') out[k]=text(input[k],8000,k.replace(/_/g,' '));
  return out;
}
function session(input,source) {
  if(!input) return null;
  if(!['full','lite'].includes(input.application)) throw new Error('Choose AutoKaggle or AutoKaggle Lite for the session.');
  return {application:input.application,project_id:source.replace('autokaggle:','')};
}
module.exports = function({db,onCall,callerEmail,isFullWrite,access,HttpsError}){
  const error = (code,message) => new HttpsError(code,message);
  const publicRow = (doc,edit) => { const x=doc.data(); const {createdBy,updatedBy,...data}=x; return {id:doc.id,...data,can_edit:edit}; };
  function projectRef(id,board){
    if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(id))throw error('invalid-argument','Select an existing BOLD OS project.');
    try{board=boardId(board);}catch(e){throw error('invalid-argument',e.message);}
    return board?db.collection('boards').doc(board).collection('cards').doc(id):db.collection('projects').doc(id);
  }
  async function projectRecord(id,board){
    const p=await projectRef(id,board).get();
    if(!p.exists)throw error('failed-precondition','The linked BOLD OS project does not exist.');
    return {id:p.id,title:p.data().title||p.id,board:boardId(board)};
  }
  async function run(request){
    const email=callerEmail(request), d=request.data || {}, action=d.action || 'list';
    await access.requireAccess(email,'projects', ['list','get','projects'].includes(action)?'view':'change');
    const full=await isFullWrite(email), mayEdit=full || await access.can(email,'projects','change');
    if(action==='projects'){
      const [snap,boards]=await Promise.all([db.collection('projects').get(),db.collection('boards').get()]);
      const items=snap.docs.map(x=>({id:x.id,title:x.data().title||x.id,board:''}));
      for(const board of boards.docs){
        if(board.data().status==='pending')continue;
        const cards=await board.ref.collection('cards').get();
        cards.docs.forEach(x=>items.push({id:x.id,title:x.data().title||x.id,board:board.id}));
      }
      return {items:items.sort((a,b)=>a.title.localeCompare(b.title))};
    }
    if(action==='create'){
      let data;
      try {data={title:text(d.title,180,'the title'),objective:text(d.objective,8000,'the objective'),task_kind:text(d.task_kind,80,'the task kind'),details:details(d.details)};}
      catch(e){throw error('invalid-argument',e.message);}
      const project=await projectRecord(d.project_id,d.project_board);
      const id='ak-'+crypto.randomBytes(12).toString('hex'),at=Date.now();
      const value={...data,project_id:project.id,project_board:project.board,project_title:project.title,stage:'open',session:null,archived:false,notes:'',createdBy:email,createdAt:at,updatedBy:email,updatedAt:at};
      await db.collection('problemBank').doc(id).set(value);
      return {problem_id:id};
    }
    if(action==='list'){
      const col='problemBank';
      let q=db.collection(col).orderBy('__name__').limit(100);
      if(d.cursor){if(!/^[a-z0-9-]{1,100}$/.test(d.cursor))throw error('invalid-argument','Invalid page cursor.');q=q.startAfter(d.cursor);}
      const snap=await q.get();
      return {items:snap.docs.map(doc=>publicRow(doc,mayEdit&&(full||doc.data().createdBy===email))),cursor:snap.size===100?snap.docs[snap.size-1].id:null};
    }
    if(action==='get'){
      if(!/^ak-[a-f0-9]{24}$/.test(d.problem_id || ''))throw error('invalid-argument','Supply the problem ID.');
      const ref=db.collection('problemBank').doc(d.problem_id), doc=await ref.get();
      if(!doc.exists)throw error('not-found','This problem is not registered.');
      const versions=await db.collection('benchmarks').where('problem_id','==',d.problem_id).get();
      const history=await ref.collection('versions').orderBy('updatedAt','desc').limit(100).get();
      return {history:history.docs.map(x=>publicRow(x,false)),problem:publicRow(doc,mayEdit&&(full||doc.data().createdBy===email)),versions:versions.docs.map(x=>publicRow(x,false)).sort((a,b)=>b.evaluator.version-a.evaluator.version)};
    }
    if(action==='register'){
      let data;try{data=normalize(d.registration);}catch(e){throw error('invalid-argument',e.message);}
      const pid='ak-'+sha(data.source_id).slice(0,24), bid=pid+'-'+data.evaluator.commit;
      const problem=db.collection('problemBank').doc(pid), benchmark=db.collection('benchmarks').doc(bid), receipt=db.collection('benchmarkReceipts').doc(data.idempotency_key);
      const fingerprint=sha(canonical(data)), at=Date.now();
      return db.runTransaction(async tx=>{
        const [p,b,r,project]=await Promise.all([tx.get(problem),tx.get(benchmark),tx.get(receipt),tx.get(projectRef(data.project_id,data.project_board))]);
        if(!project.exists)throw error('failed-precondition','The linked BOLD OS project does not exist.');
        if(p.exists && p.data().createdBy!==email && !full)throw error('permission-denied','Only its registering account or a PI/admin can update this problem.');
        if(r.exists){if(r.data().fingerprint!==fingerprint)throw error('already-exists','This request key belongs to different evidence.');return r.data().receipt;}
        if(p.exists && p.data().latest_version>data.evaluator.version)throw error('failed-precondition','A newer release is already registered.');
        if(p.exists && p.data().latest_version===data.evaluator.version && p.data().latest_commit!==data.evaluator.commit)throw error('already-exists','This version already names another commit.');
        if(b.exists && b.data().evaluator.contract_sha256!==data.evaluator.contract_sha256)throw error('already-exists','The same commit cannot name another scientific contract.');
        const author=p.exists?p.data().createdBy:email;
        const problemData={source_id:data.source_id,title:data.title,objective:data.objective,task_kind:data.task_kind,project_id:data.project_id,project_board:data.project_board,project_title:project.data().title||data.project_id,details:data.details,session:data.session,stage:data.stage,approval:data.approval,evaluator:data.evaluator,latest_benchmark:bid,
          latest_commit:data.evaluator.commit,latest_version:data.evaluator.version,archived:p.exists?!!p.data().archived:false,
          notes:p.exists?(p.data().notes||''):'',createdBy:author,createdAt:p.exists?p.data().createdAt:at,updatedBy:email,updatedAt:at};
        const benchmarkData={problem_id:pid,source_id:data.source_id,title:data.title,task_kind:data.task_kind,evaluator:data.evaluator,
          research:data.research,approval:data.approval,stage:data.stage,validation:data.validation,createdBy:author,createdAt:b.exists?b.data().createdAt:at,updatedBy:email,updatedAt:at};
        const out={problem_id:pid,benchmark_id:bid,commit:data.evaluator.commit,idempotency_key:data.idempotency_key};
        tx.set(problem,problemData);tx.set(benchmark,benchmarkData);
        tx.set(problem.collection('versions').doc(data.idempotency_key),{...problemData,changeNote:'Registered evaluator version '+data.evaluator.version});
        tx.set(benchmark.collection('validations').doc(data.idempotency_key),{...benchmarkData,registration_key:data.idempotency_key});
        tx.set(receipt,{fingerprint,receipt:out,createdBy:email,createdAt:at});
        return out;
      });
    }
    if(action==='update'){
      if(!/^ak-[a-f0-9]{24}$/.test(d.problem_id || ''))throw error('invalid-argument','Supply the problem ID.');
      if(typeof d.notes!=='string'||d.notes.length>8000||typeof d.archived!=='boolean')throw error('invalid-argument','Supply bounded notes and the archive choice.');
      const project=await projectRecord(d.project_id,d.project_board);
      let metadata;try{metadata=details(d.details);}catch(e){throw error('invalid-argument',e.message);}
      const ref=db.collection('problemBank').doc(d.problem_id);
      await db.runTransaction(async tx=>{const doc=await tx.get(ref);if(!doc.exists)throw error('not-found','This problem is not registered.');
        if(doc.data().createdBy!==email&&!full)throw error('permission-denied','Only its registering account or a PI/admin can edit this problem.');
        const update={notes:d.notes.trim(),archived:d.archived,project_id:project.id,project_board:project.board,project_title:project.title,details:metadata,updatedBy:email,updatedAt:Date.now()};
        tx.update(ref,update);tx.set(ref.collection('versions').doc(crypto.randomUUID()),{...doc.data(),...update,changeNote:'Updated project, descriptive details, notes or archive state'});});
      return {ok:true};
    }
    throw error('invalid-argument','Unknown registry action.');
  }
  return {benchmarkRegistry:onCall({},run),run};
};
module.exports.normalize=normalize;
module.exports.canonical=canonical;
