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
  if (canonical(input.destinations) !== canonical(['problem_bank','benchmarks'])) throw new Error('Register the problem and benchmark together.');
  const e = input.evaluator || {}, v = input.validation || {}, r = v.research_evidence || {}, a = input.human_approval || {};
  if (!hex(e.commit,40) || !hex(e.contract_sha256,64) || !Number.isSafeInteger(e.version) || e.version < 1) throw new Error('Pin the evaluator commit, contract, and version.');
  const repo = new URL(e.repository);
  if (repo.protocol !== 'https:' || repo.hostname !== 'github.com' || repo.username || repo.password || repo.port || repo.search || repo.hash || !/^\/[\w.-]+\/[\w.-]+$/.test(repo.pathname)) throw new Error('Use a GitHub repository HTTPS link without a token.');
  if (e.zip_url !== e.repository + '/archive/' + e.commit + '.zip') throw new Error('The ZIP must name the pinned evaluator commit.');
  if (['build','contract_coverage','code_review','synthetic'].some(k => v[k] !== 'passed') || v.research_data !== 'validated') throw new Error('Software checks and declared research-data validation must pass.');
  if (r.passed !== true || r.mode !== 'research' || r.commit !== e.commit || r.contract_sha256 !== e.contract_sha256 || !hex(r.reference_sha256,64) || !hex(r.artifact_sha256,64) || !hex(r.report_sha256,64) || !/^controlled-runtime:[a-f0-9]{16}$/.test(r.checked_by || '')) throw new Error('Research evidence must bind the assets and controlled run to this release.');
  if (![r.observed_fitness,r.expected_fitness,r.tolerance].every(Number.isFinite) || r.tolerance < 0 || r.tolerance > 1e-5 || Math.abs(r.observed_fitness-r.expected_fitness) > Math.max(r.tolerance,r.tolerance*Math.abs(r.expected_fitness))) throw new Error('The declared and measured fitness do not agree.');
  if (a.commit !== e.commit || a.contract_sha256 !== e.contract_sha256 || a.research_report_sha256 !== r.report_sha256 || !hex(a.approved_by,64) || !a.approved_at) throw new Error('A human must approve this exact release and research report.');
  // Store only the public-to-lab evidence. No file paths, email addresses, tokens,
  // raw transcripts, or arbitrary extra caller fields enter these collections.
  const clean = {schema:input.schema,source_id:input.source_id,idempotency_key:input.idempotency_key,
    title:text(input.title,180,'the title'),objective:text(input.objective,8000,'the objective'),task_kind:text(input.task_kind,80,'the task kind'),
    evaluator:{repository:e.repository,commit:e.commit,version:e.version,zip_url:e.zip_url,contract_sha256:e.contract_sha256},
    research:{reference_sha256:r.reference_sha256,artifact_sha256:r.artifact_sha256,report_sha256:r.report_sha256,checked_by:r.checked_by,
      checked_at:text(r.checked_at,80,'the validation time'),observed_fitness:r.observed_fitness,expected_fitness:r.expected_fitness,tolerance:r.tolerance,
      expected_basis:text(r.expected_basis,4000,'the expected-score basis')},
    approval:{approved_by:a.approved_by,approved_at:text(a.approved_at,80,'the approval time'),note:text(a.note,4000,'the approval note')}};
  return clean;
}
module.exports = function({db,onCall,callerEmail,isFullWrite,access,HttpsError}){
  const error = (code,message) => new HttpsError(code,message);
  const publicRow = (doc,edit) => { const x=doc.data(); const {createdBy,updatedBy,...data}=x; return {id:doc.id,...data,can_edit:edit}; };
  async function run(request){
    const email=callerEmail(request), d=request.data || {}, action=d.action || 'list';
    await access.requireAccess(email,'projects', ['list','get'].includes(action)?'view':'change');
    const full=await isFullWrite(email), mayEdit=full || await access.can(email,'projects','change');
    if(action==='list'){
      const col=d.kind==='benchmarks'?'benchmarks':'problemBank';
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
      return {problem:publicRow(doc,mayEdit&&(full||doc.data().createdBy===email)),versions:versions.docs.map(x=>publicRow(x,false)).sort((a,b)=>b.evaluator.version-a.evaluator.version)};
    }
    if(action==='register'){
      let data;try{data=normalize(d.registration);}catch(e){throw error('invalid-argument',e.message);}
      const pid='ak-'+sha(data.source_id).slice(0,24), bid=pid+'-'+data.evaluator.commit;
      const problem=db.collection('problemBank').doc(pid), benchmark=db.collection('benchmarks').doc(bid), receipt=db.collection('benchmarkReceipts').doc(data.idempotency_key);
      const fingerprint=sha(canonical(data)), at=Date.now();
      return db.runTransaction(async tx=>{
        const [p,b,r]=await Promise.all([tx.get(problem),tx.get(benchmark),tx.get(receipt)]);
        if(p.exists && p.data().createdBy!==email && !full)throw error('permission-denied','Only its registering account or a PI/admin can update this problem.');
        if(r.exists){if(r.data().fingerprint!==fingerprint)throw error('already-exists','This request key belongs to different evidence.');return r.data().receipt;}
        if(p.exists && p.data().latest_version>data.evaluator.version)throw error('failed-precondition','A newer release is already registered.');
        if(p.exists && p.data().latest_version===data.evaluator.version && p.data().latest_commit!==data.evaluator.commit)throw error('already-exists','This version already names another commit.');
        if(b.exists && b.data().evaluator.contract_sha256!==data.evaluator.contract_sha256)throw error('already-exists','The same commit cannot name another scientific contract.');
        const author=p.exists?p.data().createdBy:email;
        const problemData={source_id:data.source_id,title:data.title,objective:data.objective,task_kind:data.task_kind,latest_benchmark:bid,
          latest_commit:data.evaluator.commit,latest_version:data.evaluator.version,archived:p.exists?!!p.data().archived:false,
          notes:p.exists?(p.data().notes||''):'',createdBy:author,createdAt:p.exists?p.data().createdAt:at,updatedBy:email,updatedAt:at};
        const benchmarkData={problem_id:pid,source_id:data.source_id,title:data.title,task_kind:data.task_kind,evaluator:data.evaluator,
          research:data.research,approval:data.approval,status:'validated_and_approved',createdBy:author,createdAt:b.exists?b.data().createdAt:at,updatedBy:email,updatedAt:at};
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
      const ref=db.collection('problemBank').doc(d.problem_id);
      await db.runTransaction(async tx=>{const doc=await tx.get(ref);if(!doc.exists)throw error('not-found','This problem is not registered.');
        if(doc.data().createdBy!==email&&!full)throw error('permission-denied','Only its registering account or a PI/admin can edit this problem.');
        const update={notes:d.notes.trim(),archived:d.archived,updatedBy:email,updatedAt:Date.now()};
        tx.update(ref,update);tx.set(ref.collection('versions').doc(crypto.randomUUID()),{...doc.data(),...update,changeNote:'Updated registry notes or archive state'});});
      return {ok:true};
    }
    throw error('invalid-argument','Unknown registry action.');
  }
  return {benchmarkRegistry:onCall({},run),run};
};
module.exports.normalize=normalize;
module.exports.canonical=canonical;
