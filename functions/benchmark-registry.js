// The Problem Bank (problems.html): research problems, each linked to a BOLD.OS project, and
// the evaluator releases AutoKaggle Lite registers for them. An open problem can have several independent verifiers.
//
// problemBank/{id}            a problem: title, objective, task_kind, project_id/_board/_title,
//                             details, notes, archived, stage, and its latest release
//   versions/{key}            a full copy after each change (the page's Record history)
// benchmarks/{problem}-{commit}  one evaluator release, written once: evaluator, validation,
//                             research, reported_approval, stage, fingerprint, approval
//   validations/{key}         a full copy of each registration and approval
// benchmarkReceipts/{key}     the answer to each registration, for idempotent retries
//
// Everything is written here, never by a page (firestore.rules), and read here too, so
// people's emails (createdBy, updatedBy, approvedBy) never reach a page or an agent.
//
// What AutoKaggle sends (validation, research evidence, its approval) is its report: the
// server checks that it hangs together, not that it's true. The stage is labelled as reported
// by AutoKaggle, and only a PI or admin approves a release, here ('approve'). Called through
// the site's Slack-signed-in callable and, for agents, boldApi's acting tokens; each
// registration is recorded as whoever's token sent it (docs/BENCHMARK_REGISTRY.md).
const crypto = require('crypto');
const {isPastPaper, registerPastPaper} = require('./past-paper');

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hex = (value, n) => typeof value === 'string' && new RegExp('^[a-f0-9]{' + n + '}$').test(value);
// JSON with object keys sorted, so the same content always gives the same fingerprint.
const canonical = (value) => JSON.stringify(value, function(k, v){
  return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v;
});
function text(value, limit, label){
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error('Supply ' + label + ' within ' + limit + ' characters.');
  return value.trim();
}
function problemId(value){
  if (typeof value !== 'string' || !/^ak-[a-f0-9]{24}$/.test(value)) throw new Error('Supply the Problem Bank ID.');
  return value;
}
function boardId(value){
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw new Error('Invalid project board.');
  return value;
}

const CHECKS = ['build', 'contract_coverage', 'code_review', 'synthetic', 'known_score', 'invalid_submission', 'clean_clone', 'research_data'];
const SOFTWARE = ['code_review', 'synthetic', 'known_score', 'invalid_submission', 'clean_clone'];
const DETAIL_FIELDS = ['owner', 'collaborators', 'submission_format', 'metrics', 'score_format', 'constraints', 'run_command', 'dependencies', 'seeds', 'compute', 'data_assets', 'limitations', 'open_issues', 'next_action'];

function details(input){
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Details must be an object.');
  const out = {};
  for (const k of DETAIL_FIELDS) if (input[k] != null && input[k] !== '') out[k] = text(input[k], 8000, k.replace(/_/g, ' '));
  return out;
}
// Every verifier starts in an AutoKaggle Lite session (docs/BENCHMARK_REGISTRY.md).
function session(input, source){
  if (!input || input.application !== 'lite') throw new Error('Register a problem through an AutoKaggle Lite session.');
  return { application: input.application, project_id: source.replace('autokaggle:', '') };
}

// Pure: a bold.autokaggle.registration.v1 record → what's stored, or throws. Only the
// fields named here are kept: no file paths, emails, tokens or extra fields.
function normalize(input){
  if (!input || input.schema !== 'bold.autokaggle.registration.v1' || Buffer.byteLength(JSON.stringify(input)) > 128000) throw new Error('Use a bounded AutoKaggle registration record.');
  if (!/^autokaggle:[a-f0-9-]{36}$/.test(input.source_id || '') || !hex(input.idempotency_key, 64)) throw new Error('Supply the stable source ID and request key.');
  if (canonical(input.destinations) !== canonical(['problem_bank'])) throw new Error('Register in the Problem Bank.');
  const project_id = text(input.project_id, 160, 'the BOLD OS project ID');
  if (!/^[A-Za-z0-9_-]+$/.test(project_id)) throw new Error('Use a valid BOLD OS project ID.');

  const e = input.evaluator || {}, v = input.validation || {}, r = v.research_evidence || {}, a = input.human_approval || {};
  if (!hex(e.commit, 40) || !hex(e.contract_sha256, 64) || !Number.isSafeInteger(e.version) || e.version < 1) throw new Error('Pin the evaluator commit, contract, and version.');
  const repo = new URL(e.repository);
  if (repo.protocol !== 'https:' || repo.hostname !== 'github.com' || repo.username || repo.password || repo.port || repo.search || repo.hash || !/^\/[\w.-]+\/[\w.-]+$/.test(repo.pathname)) throw new Error('Use a GitHub repository HTTPS link without a token.');
  if (e.zip_url !== e.repository + '/archive/' + e.commit + '.zip') throw new Error('The ZIP must name the pinned evaluator commit.');
  if (['build', 'contract_coverage'].some((k) => v[k] !== 'passed')) throw new Error('Implementation and full contract coverage must pass.');

  const checked = SOFTWARE.every((k) => v[k] === 'passed');
  const validated = v.research_data === 'validated';
  if (validated && !checked) throw new Error('Complete all software checks before research validation.');
  if (validated) {
    if (r.passed !== true || r.mode !== 'research' || r.commit !== e.commit || r.contract_sha256 !== e.contract_sha256 || !hex(r.reference_sha256, 64) || !hex(r.artifact_sha256, 64) || !hex(r.report_sha256, 64) || !/^controlled-runtime:[a-f0-9]{16}$/.test(r.checked_by || '')) throw new Error('Research evidence must bind the assets and controlled run to this release.');
    const close = Math.abs(r.observed_fitness - r.expected_fitness) <= Math.max(r.tolerance, r.tolerance * Math.max(Math.abs(r.expected_fitness), Math.abs(r.observed_fitness)));
    if (![r.observed_fitness, r.expected_fitness, r.tolerance].every(Number.isFinite) || r.tolerance < 0 || r.tolerance > 1e-5 || !close) throw new Error('The declared and measured fitness do not agree.');
  }
  // AutoKaggle's own approval, kept as what it reports. Approval in BOLD.OS is 'approve'.
  const reported = Object.keys(a).length > 0;
  if (reported && (!validated || a.commit !== e.commit || a.contract_sha256 !== e.contract_sha256 || a.research_report_sha256 !== r.report_sha256 || !hex(a.approved_by, 64) || !a.approved_at)) throw new Error('A reported approval must name this exact release and research report.');

  return {
    ...(input.problem_id === undefined ? {} : { problem_id: problemId(input.problem_id) }),
    schema: input.schema, source_id: input.source_id, idempotency_key: input.idempotency_key,
    project_id, project_board: boardId(input.project_board),
    stage: validated ? 'validated' : checked ? 'checked' : 'implemented',
    validation: Object.fromEntries(CHECKS.map((k) => [k, v[k] || 'not_run'])),
    details: details(input.details), session: session(input.session, input.source_id),
    title: text(input.title, 180, 'the title'), objective: text(input.objective, 8000, 'the objective'), task_kind: text(input.task_kind, 80, 'the task kind'),
    evaluator: { repository: e.repository, commit: e.commit, version: e.version, zip_url: e.zip_url, contract_sha256: e.contract_sha256 },
    research: validated ? { reference_sha256: r.reference_sha256, artifact_sha256: r.artifact_sha256, report_sha256: r.report_sha256, checked_by: r.checked_by,
      checked_at: text(r.checked_at, 80, 'the validation time'), observed_fitness: r.observed_fitness, expected_fitness: r.expected_fitness, tolerance: r.tolerance,
      expected_basis: text(r.expected_basis, 4000, 'the expected-score basis') } : null,
    reported_approval: reported ? { approved_by: a.approved_by, approved_at: text(a.approved_at, 80, 'the approval time'), note: text(a.note, 4000, 'the approval note') } : null,
  };
}
function storedProjects(p){
  return p.projects || (p.project_id ? [{ id: p.project_id, board: p.project_board || '', title: p.project_title || p.project_id }] : []);
}
function sameProject(a, b){
  if (a.id === b.id && (a.board || '') === (b.board || '')) return true;
  const left = a.stable_id || (!a.board && a.id);
  const right = b.stable_id || (!b.board && b.id);
  return Boolean(left && left === right);
}
function linkedProjects(problem, choices){
  const links = storedProjects(problem).map(link => choices.find(choice => sameProject(link, choice)) || link);
  for (const choice of choices) {
    if (choice.openProblemId === problem.id && !links.some(link => sameProject(link, choice))) links.push(choice);
  }
  return links;
}
function primary(links){
  const first = links[0] || {};
  return { project_id: first.id || '', project_board: first.board || '', project_title: first.title || '' };
}
// Pure: what makes a release itself; registering it again must match exactly.
const releaseFingerprint = (data) => sha(canonical({ evaluator: data.evaluator, validation: data.validation, research: data.research, reported_approval: data.reported_approval, stage: data.stage }));

module.exports = function({ db, onCall, callerEmail, isFullWrite, access, HttpsError, readDirectory }){
  const error = (code, message) => new HttpsError(code, message);
  const family = require('./problem-family')(db,error);
  // What a page or agent sees of a document: no emails.
  const publicRow = (doc, edit) => {
    const { createdBy, updatedBy, approvedBy, createFingerprint, verifierNoticeDue, verifierNoticeCycle, ...data } = doc.data();
    return Object.assign({ id: doc.id }, data, edit === undefined ? {} : { can_edit: edit });
  };
  function projectRef(id, board){
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw error('invalid-argument', 'Select an existing BOLD OS project.');
    try { board = boardId(board); } catch (e) { throw error('invalid-argument', e.message); }
    return board ? db.collection('boards').doc(board).collection('cards').doc(id) : db.collection('projects').doc(id);
  }
  async function projectRecord(id, board){
    const p = await projectRef(id, board).get();
    if (!p.exists || isPastPaper(p.data())) throw error('failed-precondition', 'The linked BOLD OS project does not exist.');
    return { id: p.id, title: p.data().title || p.id, board: boardId(board) };
  }
  // The research owner, chosen from the lab's people (the Slack roster) by Slack ID: the
  // name is the roster's, never what the page sends. None: null.
  async function ownerOf(id){
    if (id == null || id === '') return null;
    if (typeof id !== 'string' || !/^[A-Z0-9]{5,20}$/.test(id)) throw error('invalid-argument', 'Choose the research owner from the lab’s people.');
    const person = await db.collection('people').doc(id).get();   // people/{Slack ID}
    if (!person.exists) throw error('invalid-argument', 'Choose the research owner from the lab’s people.');
    return { owner_id: id, owner: person.data().name || 'A lab member' };
  }
  function projectRefs(list){
    if (!Array.isArray(list) || list.length > 100) throw error('invalid-argument','Choose up to 100 projects.');
    return list.map(x => projectRef(x && x.id, x && x.board));
  }
  async function readLinks(tx, refs, list){
    const docs = await Promise.all(refs.map(ref => tx.get(ref)));
    const links = [];
    docs.forEach((doc, i) => {
      if (!doc.exists || isPastPaper(doc.data())) throw error('failed-precondition','A selected project no longer exists.');
      const link = { id: doc.id, board: list[i].board || '', title: doc.data().title || doc.id, stable_id: doc.data().projectId || doc.id };
      if (!links.some(x => sameProject(x,link))) links.push(link);
    });
    return links;
  }
  async function nameOf(email){
    const m = await db.collection('members').doc(email).get();
    return (m.exists && m.data().name) || 'A PI or admin';
  }

  async function activeProblemChoices(){
    const snap = await db.collection('problemBank').select('title','archived').get();
    const items = snap.docs.filter(doc => /^ak-[a-f0-9]{24}$/.test(doc.id) && !doc.data().archived && typeof doc.data().title === 'string' && doc.data().title)
      .map(doc => ({id:doc.id,title:doc.data().title})).sort((a,b)=>a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    return {items};
  }

  async function run(request){
    const email = callerEmail(request), d = request.data || {}, action = d.action || 'list';
    if (action === 'register_past_paper' || action === 'past_paper_problem_choices') {
      if (!(await access.can(email,'ml-cycle','edit'))) await access.requireAccess(email,'projects','edit');
      if (action === 'past_paper_problem_choices') return activeProblemChoices();
      return registerPastPaper({db,error,fingerprint:value=>sha(canonical(value))},d,email,request.auth?.token?.name);
    }
    const permission = ['open_choices','benchmark_catalogue'].includes(action) ? 'list' : ['list', 'get', 'projects', 'search', 'family'].includes(action) ? 'view' : 'change';
    await access.requireAccess(email, 'projects', permission);
    const full = await isFullWrite(email);
    const mayEdit = full || await access.can(email, 'projects', 'change');
    const canEdit = (doc) => mayEdit && (full || doc.data().createdBy === email);
    async function problemDirectory(){
      return readDirectory(await access.can(email,'ml-cycle','view'));
    }
    function withLinks(doc, directory){
      const p = publicRow(doc,canEdit(doc));
      return {...p,projects:linkedProjects(p,directory.projects),papers:directory.papers ? (directory.papers.get(p.id) || []) : null};
    }

    if (['request_baseline', 'claim_baseline', 'finish_baseline'].includes(action)) {
      return require('./autoastra-baseline').changeBaseline({db, error, publicRow, full, canEdit, email}, d);
    }
    if (action === 'create_project_proposal') {
      return require('./project-verification-plan').createProposal({db,error,fingerprint:value=>sha(canonical(value))},d,email,request.auth?.token?.name);
    }
    if (action === 'family') return family.list(full);
    if (action === 'set_family') return family.setFamily(d,email,canEdit);
    if (action === 'save_moonshot') return family.saveMoonshot(d,email,full);
    if (action === 'benchmark_catalogue') return require('./benchmark-catalogue').listBenchmarkReleases(db,d,error);
    if (action === 'projects') return { items:(await readDirectory(false)).projects };

    if (action === 'open_choices') return activeProblemChoices();
    if (action === 'search') {
      // For search.js and agents' search: problems not archived, and their releases.
      const [problems, releases] = await Promise.all([db.collection('problemBank').get(), db.collection('benchmarks').get()]);
      const live = new Set(problems.docs.filter((x) => !x.data().archived).map((x) => x.id));
      return { items: problems.docs.filter((x) => live.has(x.id)).map((x) => {
        const p = x.data();
        return { kind: 'problems', problem_id: x.id, title: p.title, label: 'Problem Bank', text: [p.objective, p.significance, p.existing_solutions, p.difficulties, (p.details || {}).owner, (p.details || {}).collaborators, p.task_kind, p.notes].filter(Boolean).join(' ') };
      }).concat(releases.docs.filter((x) => live.has(x.data().problem_id)).map((x) => {
        const b = x.data();
        return { kind: 'benchmarks', problem_id: b.problem_id, title: b.title, label: 'Evaluator version ' + b.evaluator.version,
          text: [b.task_kind, b.evaluator.commit, (b.research || {}).expected_basis].filter(Boolean).join(' ') };
      })) };
    }

    if (action === 'create') {
      const modern = d.projects !== undefined || d.difficulties !== undefined;
      const owner = modern ? await ownerOf(d.owner_id) : null;
      if (modern && !owner) throw error('invalid-argument','Choose the problem definer.');
      let definition, collaborators;
      try {
        const required = modern ? ['title', 'significance', 'difficulties', 'existing_solutions'] : ['title', 'objective', 'significance', 'existing_solutions'];
        definition = Object.fromEntries(required.map(k => [k, text(d[k], k === 'title' ? 180 : 8000, k)]));
        collaborators = d.collaborators ? text(d.collaborators,8000,'collaborators') : '';
      } catch (e) { throw error('invalid-argument',e.message); }
      if (typeof d.reminders !== 'boolean' || typeof d.request_id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(d.request_id))
        throw error('invalid-argument', 'Confirm the reminder choice and supply a request ID.');
      const list = modern ? (d.projects === undefined ? [] : d.projects) : [{id:d.project_id,board:d.project_board || ''}];
      const refs = projectRefs(list);
      const id = 'ak-' + sha('problem:' + email + ':' + d.request_id).slice(0, 24);
      const ref = db.collection('problemBank').doc(id), at = Date.now();
      const selection = d.family === undefined ? null : family.normalize(d.family,id);
      const inputs = modern ? [definition,owner.owner_id,collaborators,list,d.reminders] : [definition,d.project_id,d.project_board || '',d.reminders];
      // Preserve the fingerprint of older creates that had no relationships.
      const hasLinks = selection && (selection.parents.length || selection.related.length);
      if (hasLinks) inputs.push(selection);
      const fingerprint = sha(canonical(inputs));
      return db.runTransaction(async tx => {
        const previous = await tx.get(ref);
        if (previous.exists) {
          if (previous.data().createFingerprint !== fingerprint) throw error('already-exists', 'This request already saved a different problem.');
          return { problem_id: id };
        }
        if (!modern) throw error('invalid-argument', 'Reload the form to select the problem definer and describe the difficulties.');
        const links = await readLinks(tx,refs,list);
        const familyChange = hasLinks ? await family.replace(tx,id,selection,null,email,at) : null;
        const row = { ...definition, origin: 'problem_bank', stage: 'open', archived: false, task_kind: '',
          ...primary(links), projects:links, owner_id:owner ? owner.owner_id : null,
          details:owner ? {owner:owner.owner,collaborators} : {}, notes: '', createdBy: email, updatedBy: email, createdAt: at, updatedAt: at, reminders: d.reminders };
        tx.set(ref, { ...row, createFingerprint: fingerprint, verifierNoticeDue: d.reminders ? at : null });
        tx.set(ref.collection('versions').doc('created'), { ...row, changeNote: 'Defined the open problem', ...(familyChange ? {familyChange} : {}) });
        return { problem_id: id };
      });
    }

    if (action === 'list') {
      let q = db.collection('problemBank').orderBy('__name__').limit(100);
      if (d.cursor) {
        if (!/^[a-z0-9-]{1,100}$/.test(d.cursor)) throw error('invalid-argument', 'Invalid page cursor.');
        q = q.startAfter(d.cursor);
      }
      const [snap, directory] = await Promise.all([q.get(), problemDirectory()]);
      const items = snap.docs.map(doc => withLinks(doc,directory));
      return { items, cursor: snap.size === 100 ? snap.docs[snap.size - 1].id : null };
    }

    if (action === 'get') {
      if (!/^ak-[a-f0-9]{24}$/.test(d.problem_id || '')) throw error('invalid-argument', 'Supply the problem ID.');
      const ref = db.collection('problemBank').doc(d.problem_id), doc = await ref.get();
      if (!doc.exists) throw error('not-found', 'This problem is not registered.');
      const [releases, history, directory] = await Promise.all([
        db.collection('benchmarks').where('problem_id', '==', d.problem_id).get(),
        ref.collection('versions').orderBy('updatedAt', 'desc').limit(100).get(), problemDirectory(),
      ]);
      const problem = withLinks(doc,directory);
      problem.selected_projects = storedProjects(doc.data());
      return { can_manage_reminders: mayEdit && doc.data().createdBy === email, history: history.docs.map((x) => publicRow(x)), problem, can_approve: full,
        versions: releases.docs.map((x) => publicRow(x)).sort((a, b) => b.createdAt - a.createdAt || b.evaluator.version - a.evaluator.version) };
    }

    if (action === 'register') {
      let data;
      try { data = normalize(d.registration); } catch (e) { throw error('invalid-argument', e.message); }
      const sourceKey = 'ak-' + sha(data.source_id).slice(0, 24);
      const pid = data.problem_id || sourceKey, bid = sourceKey + '-' + data.evaluator.commit;
      const stream = db.collection('benchmarkSources').doc(sourceKey);
      const problem = db.collection('problemBank').doc(pid), benchmark = db.collection('benchmarks').doc(bid), receipt = db.collection('benchmarkReceipts').doc(data.idempotency_key);
      const fingerprint = sha(canonical(data)), release = releaseFingerprint(data), at = Date.now();
      const out = { problem_id: pid, benchmark_id: bid, commit: data.evaluator.commit, idempotency_key: data.idempotency_key };
      return db.runTransaction(async (tx) => {
        const [p, b, r, project, streamDoc, legacy] = await Promise.all([tx.get(problem), tx.get(benchmark), tx.get(receipt),
          tx.get(projectRef(data.project_id, data.project_board)), tx.get(stream),
          pid !== sourceKey ? tx.get(db.collection('problemBank').doc(sourceKey)) : null]);
        if (!project.exists || isPastPaper(project.data())) throw error('failed-precondition', 'The linked BOLD OS project does not exist.');
        const prior = p.exists ? p.data() : {};
        const linked = !!data.problem_id;
        if (linked && !p.exists) throw error('not-found', 'The open problem no longer exists.');
        if ((streamDoc.exists && streamDoc.data().problem_id !== pid) || (legacy && legacy.exists))
          throw error('failed-precondition', 'This verifier session belongs to another problem.');
        const streamOwner = streamDoc.exists ? streamDoc.data().createdBy : (!linked || prior.source_id === data.source_id ? prior.createdBy : null);
        if (streamOwner && streamOwner !== email && !full) throw error('permission-denied', 'Only its registering account or a PI/admin can update this problem.');
        if (r.exists) {
          if (r.data().fingerprint !== fingerprint) throw error('already-exists', 'This request key belongs to different evidence.');
          return r.data().receipt;
        }
        // A release is written once: the same commit again must be the same release.
        if (b.exists) {
          if (b.data().fingerprint !== release || (b.data().details !== undefined && canonical(b.data().details) !== canonical(data.details))) throw error('already-exists', 'This commit is already registered with different evidence. Register the change as a new version.');
          tx.set(receipt, { fingerprint, receipt: out, createdBy: email, createdAt: at });
          return out;
        }
        const target = {id:data.project_id, board:data.project_board, stable_id:project.data().projectId || data.project_id};
        if (linked && (prior.archived || (!storedProjects(prior).some(link => sameProject(link,target)) && project.data().openProblemId !== pid)))
          throw error('failed-precondition', 'Choose an active problem in the same BOLD OS project.');
        const previousVersion = streamDoc.exists ? streamDoc.data().version : (prior.source_id === data.source_id ? prior.latest_version : 0);
        if (previousVersion >= data.evaluator.version) throw error('failed-precondition', 'Version ' + data.evaluator.version + ' or a newer one is already registered.');
        const author = p.exists ? p.data().createdBy : email;
        const problemData = { source_id: data.source_id, title: data.title, objective: data.objective, task_kind: data.task_kind,
          project_id: data.project_id, project_board: data.project_board, project_title: project.data().title || data.project_id,
          details: Object.assign({}, p.exists ? p.data().details : {}, data.details), session: data.session, stage: data.stage,
          reported_approval: data.reported_approval, approval: null, evaluator: data.evaluator,
          latest_benchmark: bid, latest_commit: data.evaluator.commit, latest_version: data.evaluator.version,
          archived: p.exists ? !!p.data().archived : false, notes: p.exists ? (p.data().notes || '') : '',
          createdBy: author, createdAt: p.exists ? p.data().createdAt : at, updatedBy: email, updatedAt: at };
        const benchmarkData = { problem_id: pid, source_id: data.source_id, title: data.title, task_kind: data.task_kind, evaluator: data.evaluator,
          details: data.details, project_id:data.project_id, project_board:data.project_board, project_stable_id:target.stable_id, research: data.research, reported_approval: data.reported_approval, approval: null, stage: data.stage, validation: data.validation,
          fingerprint: release, createdBy: streamOwner || email, createdAt: at, updatedBy: email, updatedAt: at };
        // A verifier release cannot replace the scientific definition or its submitter.
        if (linked && !prior.has_linked_verifiers && prior.source_id && prior.source_id !== data.source_id) {
          const original = db.collection('benchmarkSources').doc('ak-' + sha(prior.source_id).slice(0, 24));
          tx.set(original, { problem_id: pid, createdBy: prior.createdBy, version: prior.latest_version });
        }
        if (linked) Object.assign(problemData, { ...primary(storedProjects(prior)), has_linked_verifiers: true, title: prior.title, objective: prior.objective || '', task_kind: prior.task_kind || '',
          details: prior.details || {}, verifierNoticeDue: null });
        tx.set(stream, { problem_id: pid, version: data.evaluator.version, createdBy: streamOwner || email });
        tx.set(problem, { ...prior, ...problemData });
        tx.set(benchmark, benchmarkData);
        tx.set(problem.collection('versions').doc(data.idempotency_key), Object.assign({}, prior, problemData, { changeNote: 'Registered evaluator version ' + data.evaluator.version }));
        tx.set(benchmark.collection('validations').doc(data.idempotency_key), Object.assign({}, benchmarkData, { registration_key: data.idempotency_key }));
        tx.set(receipt, { fingerprint, receipt: out, createdBy: email, createdAt: at });
        return out;
      });
    }

    if (action === 'approve') {
      // A PI or admin approves a validated release, on its page. Not offered to agents.
      if (!full) throw error('permission-denied', 'Only a PI or admin approves a release.');
      if (typeof d.benchmark_id !== 'string' || !/^ak-[a-f0-9]{24}-[a-f0-9]{40}$/.test(d.benchmark_id)) throw error('invalid-argument', 'Supply the release ID.');
      const note = typeof d.note === 'string' ? d.note.trim().slice(0, 4000) : '';
      const benchmark = db.collection('benchmarks').doc(d.benchmark_id), name = await nameOf(email), at = Date.now();
      await db.runTransaction(async (tx) => {
        const b = await tx.get(benchmark);
        if (!b.exists) throw error('not-found', 'This release is not registered.');
        if (b.data().stage !== 'validated') throw error('failed-precondition', 'Only a release validated on the actual task can be approved.');
        if (b.data().approval) throw error('already-exists', 'This release is already approved.');
        const problem = db.collection('problemBank').doc(b.data().problem_id), p = await tx.get(problem);
        const approval = { name, at, note };
        tx.update(benchmark, { approval, approvedBy: email, updatedBy: email, updatedAt: at });
        tx.set(benchmark.collection('validations').doc(crypto.randomUUID()), Object.assign({}, b.data(), { approval, approvedBy: email, updatedBy: email, updatedAt: at, changeNote: 'Approved' }));
        if (p.exists && p.data().latest_benchmark === d.benchmark_id) {
          tx.update(problem, { approval, updatedBy: email, updatedAt: at });
          tx.set(problem.collection('versions').doc(crypto.randomUUID()), Object.assign({}, p.data(), { approval, updatedBy: email, updatedAt: at,
            changeNote: 'Approved evaluator version ' + b.data().evaluator.version }));
        }
      });
      return { ok: true };
    }

    if (action === 'reminders') {
      let id;
      try { id = problemId(d.problem_id); } catch (e) { throw error('invalid-argument', e.message); }
      if (typeof d.reminders !== 'boolean') throw error('invalid-argument', 'Choose whether to receive reminders.');
      const ref = db.collection('problemBank').doc(id);
      await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw error('not-found', 'This problem no longer exists.');
        const p = snap.data();
        if (p.createdBy !== email) throw error('permission-denied', 'Only the submitter can change their reminders.');
        if (p.evaluator || p.archived) throw error('failed-precondition', 'Reminders apply to active problems without a verifier.');
        if (!!p.reminders === d.reminders) return;
        tx.update(ref, { reminders: d.reminders, verifierNoticeDue: d.reminders ? Date.now() : null, verifierNoticeCycle: null });
      });
      return { ok: true };
    }

    if (action === 'update' && d.changes) {
      let id;
      try { id=problemId(d.problem_id); } catch (e){throw error('invalid-argument',e.message);}
      const changes=d.changes, keys=Object.keys(changes);
      if (!keys.length || keys.some(k=>!['title','significance','difficulties','existing_solutions','owner_id','collaborators','projects','archived'].includes(k)))
        throw error('invalid-argument','Choose a problem field to edit.');
      const owner='owner_id' in changes ? await ownerOf(changes.owner_id) : null;
      if ('owner_id' in changes && !owner) throw error('invalid-argument','Choose the problem definer.');
      const refs='projects' in changes ? projectRefs(changes.projects) : null;
      const ref=db.collection('problemBank').doc(id);
      await db.runTransaction(async tx=>{
        const doc=await tx.get(ref);
        if (!doc.exists) throw error('not-found','This problem no longer exists.');
        if (!canEdit(doc)) throw error('permission-denied','Only the submitter or a PI/admin can edit the problem.');
        const was = doc.data(), at = Date.now();
        const patch = { updatedAt: at, updatedBy: email };
        if ('title' in changes && was.stage !== 'open' && was.origin !== 'problem_bank')
          throw error('failed-precondition', 'Change a released evaluator title through AutoKaggle.');
        try {
          for (const key of ['title', 'significance', 'difficulties', 'existing_solutions']) {
            if (key in changes) patch[key] = text(changes[key], key === 'title' ? 180 : 8000, key);
          }
          if (owner || 'collaborators' in changes) {
            patch.details = { ...was.details };
            if (owner) {
              patch.owner_id = owner.owner_id;
              patch.details.owner = owner.owner;
            }
            if ('collaborators' in changes) patch.details.collaborators = changes.collaborators === '' ? '' : text(changes.collaborators, 8000, 'collaborators');
          }
        } catch (e) { throw error('invalid-argument', e.message); }
        if (refs) {
          const links = await readLinks(tx, refs, changes.projects);
          if (was.evaluator) {
            const versions = await tx.get(db.collection('benchmarks').where('problem_id', '==', id));
            const pinned = versions.docs.map(doc => {
              const version = doc.data();
              return { id: version.project_id || was.project_id, board: version.project_board ?? was.project_board ?? '', stable_id:version.project_stable_id || '' };
            });
            const removed = storedProjects(was).filter(link => !links.some(x => sameProject(x, link)));
            if (removed.some(link => pinned.some(x => sameProject(x, link))))
              throw error('failed-precondition', 'Keep the project used by a registered verifier.');
          }
          Object.assign(patch, primary(links), { projects: links });
        }
        if ('archived' in changes) {
          if (typeof changes.archived !== 'boolean') throw error('invalid-argument', 'Supply the archive choice.');
          patch.archived = changes.archived;
          if (patch.archived !== !!was.archived && was.reminders && !was.evaluator)
            Object.assign(patch, { verifierNoticeDue: patch.archived ? null : at, verifierNoticeCycle: null });
        }
        tx.update(ref,patch);
        tx.set(ref.collection('versions').doc(crypto.randomUUID()),{...was,...patch,changeNote:'Updated the problem definition'});
      });
      return {ok:true};
    }
    if (action === 'update') {
      if (!/^ak-[a-f0-9]{24}$/.test(d.problem_id || '')) throw error('invalid-argument', 'Supply the problem ID.');
      if (typeof d.notes !== 'string' || d.notes.length > 8000 || typeof d.archived !== 'boolean') throw error('invalid-argument', 'Supply bounded notes and the archive choice.');
      const project = await projectRecord(d.project_id, d.project_board);
      let metadata;
      try { metadata = details(d.details); } catch (e) { throw error('invalid-argument', e.message); }
      const owner = await ownerOf(d.owner_id);
      const ref = db.collection('problemBank').doc(d.problem_id);
      await db.runTransaction(async (tx) => {
        const [doc, linked] = await Promise.all([tx.get(ref), tx.get(projectRef(d.project_id, d.project_board))]);
        if (!linked.exists || isPastPaper(linked.data())) throw error('failed-precondition', 'The linked project no longer exists.');
        if (!doc.exists) throw error('not-found', 'This problem is not registered.');
        if (doc.data().createdBy !== email && !full) throw error('permission-denied', 'Only its registering account or a PI/admin can edit this problem.');
        // The owner: chosen from the roster (owner_id), or else kept as it was.
        const was = doc.data();
        if (owner) metadata.owner = owner.owner;
        else if ((was.details || {}).owner) metadata.owner = was.details.owner;
        else delete metadata.owner;
        const update = { notes: d.notes.trim(), archived: d.archived, project_id: project.id, project_board: project.board, project_title: project.title,
          details: metadata, owner_id: owner ? owner.owner_id : (was.owner_id || null), updatedBy: email, updatedAt: Date.now() };
        if (was.projects && (was.project_id !== project.id || (was.project_board || '') !== project.board))
          update.projects = [project,...was.projects.filter(link=>!sameProject(link,project) && !(link.id===was.project_id && (link.board||'')===(was.project_board||'')))];
        if (was.has_linked_verifiers && (was.project_id !== project.id || (was.project_board || '') !== project.board))
          throw error('failed-precondition', 'A problem with registered verifiers must keep its project.');
        if (d.archived !== !!was.archived && was.reminders && !was.evaluator)
          Object.assign(update, { verifierNoticeDue: d.archived ? null : Date.now(), verifierNoticeCycle: null });
        if (d.definition) {
          if (was.stage !== 'open' && was.origin !== 'problem_bank') throw error('failed-precondition', 'Change an evaluator contract through AutoKaggle.');
          try {
            for (const [key, limit] of [['title', 180], ['objective', 8000], ['task_kind', 80], ['significance', 8000], ['existing_solutions', 8000]]) {
              if (d.definition[key] !== undefined && !(key === 'task_kind' && !d.definition[key]))
                update[key] = text(d.definition[key], limit, key);
            }
          }
          catch (e) { throw error('invalid-argument', e.message); }
        }
        tx.update(ref, update);
        tx.set(ref.collection('versions').doc(crypto.randomUUID()), Object.assign({}, doc.data(), update, { changeNote: 'Updated project, descriptive details, notes or archive state' }));
      });
      return { ok: true };
    }

    throw error('invalid-argument', 'Unknown registry action.');
  }
  return { benchmarkRegistry: onCall({}, run), run };
};
module.exports.normalize = normalize;
module.exports.canonical = canonical;
