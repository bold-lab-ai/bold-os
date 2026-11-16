// The Problem Bank (problems.html): research problems, each linked to a BOLD.OS project, and
// the evaluator releases AutoKaggle Lite registers for them. Problems start in Lite, never here.
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
function boardId(value){
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw new Error('Invalid project board.');
  return value;
}

const CHECKS = ['build', 'contract_coverage', 'code_review', 'synthetic', 'known_score', 'invalid_submission', 'clean_clone', 'research_data'];
const SOFTWARE = ['code_review', 'synthetic', 'known_score', 'invalid_submission', 'clean_clone'];
const DETAIL_FIELDS = ['owner', 'collaborators', 'submission_format', 'metrics', 'run_command', 'dependencies', 'seeds', 'compute', 'data_assets', 'limitations', 'open_issues', 'next_action'];

function details(input){
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Details must be an object.');
  const out = {};
  for (const k of DETAIL_FIELDS) if (input[k] != null && input[k] !== '') out[k] = text(input[k], 8000, k.replace(/_/g, ' '));
  return out;
}
// Every problem starts in an AutoKaggle Lite session (docs/BENCHMARK_REGISTRY.md).
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
// Pure: what makes a release itself; registering it again must match exactly.
const releaseFingerprint = (data) => sha(canonical({ evaluator: data.evaluator, validation: data.validation, research: data.research, reported_approval: data.reported_approval, stage: data.stage }));

// projectChoices(): one row per project, its latest card ({ id, board, title, venue }),
// from functions/index.js (allProjectsFromCards, as the Projects page lists them).
module.exports = function({ db, onCall, callerEmail, isFullWrite, access, HttpsError, projectChoices }){
  const error = (code, message) => new HttpsError(code, message);
  // What a page or agent sees of a document: no emails.
  const publicRow = (doc, edit) => {
    const { createdBy, updatedBy, approvedBy, ...data } = doc.data();
    return Object.assign({ id: doc.id }, data, edit === undefined ? {} : { can_edit: edit });
  };
  function projectRef(id, board){
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw error('invalid-argument', 'Select an existing BOLD OS project.');
    try { board = boardId(board); } catch (e) { throw error('invalid-argument', e.message); }
    return board ? db.collection('boards').doc(board).collection('cards').doc(id) : db.collection('projects').doc(id);
  }
  async function projectRecord(id, board){
    const p = await projectRef(id, board).get();
    if (!p.exists) throw error('failed-precondition', 'The linked BOLD OS project does not exist.');
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
  async function nameOf(email){
    const m = await db.collection('members').doc(email).get();
    return (m.exists && m.data().name) || 'A PI or admin';
  }

  async function run(request){
    const email = callerEmail(request), d = request.data || {}, action = d.action || 'list';
    await access.requireAccess(email, 'projects', ['list', 'get', 'projects', 'search'].includes(action) ? 'view' : 'change');
    const full = await isFullWrite(email);
    const mayEdit = full || await access.can(email, 'projects', 'change');
    const canEdit = (doc) => mayEdit && (full || doc.data().createdBy === email);

    if (action === 'projects') return { items: await projectChoices() };

    if (action === 'search') {
      // For search.js and agents' search: problems not archived, and their releases.
      const [problems, releases] = await Promise.all([db.collection('problemBank').get(), db.collection('benchmarks').get()]);
      const live = new Set(problems.docs.filter((x) => !x.data().archived).map((x) => x.id));
      return { items: problems.docs.filter((x) => live.has(x.id)).map((x) => {
        const p = x.data();
        return { kind: 'problems', problem_id: x.id, title: p.title, label: 'Problem Bank', text: [p.objective, p.task_kind, p.notes].filter(Boolean).join(' ') };
      }).concat(releases.docs.filter((x) => live.has(x.data().problem_id)).map((x) => {
        const b = x.data();
        return { kind: 'benchmarks', problem_id: b.problem_id, title: b.title, label: 'Evaluator version ' + b.evaluator.version,
          text: [b.task_kind, b.evaluator.commit, (b.research || {}).expected_basis].filter(Boolean).join(' ') };
      })) };
    }

    // New problems start in AutoKaggle Lite, never here: not even for PIs and admins.
    if (action === 'create') throw error('failed-precondition', 'Add problems through AutoKaggle Lite. Direct creation in the Problem Bank is disabled.');

    if (action === 'list') {
      let q = db.collection('problemBank').orderBy('__name__').limit(100);
      if (d.cursor) {
        if (!/^[a-z0-9-]{1,100}$/.test(d.cursor)) throw error('invalid-argument', 'Invalid page cursor.');
        q = q.startAfter(d.cursor);
      }
      const snap = await q.get();
      return { items: snap.docs.map((doc) => publicRow(doc, canEdit(doc))), cursor: snap.size === 100 ? snap.docs[snap.size - 1].id : null };
    }

    if (action === 'get') {
      if (!/^ak-[a-f0-9]{24}$/.test(d.problem_id || '')) throw error('invalid-argument', 'Supply the problem ID.');
      const ref = db.collection('problemBank').doc(d.problem_id), doc = await ref.get();
      if (!doc.exists) throw error('not-found', 'This problem is not registered.');
      const [releases, history] = await Promise.all([
        db.collection('benchmarks').where('problem_id', '==', d.problem_id).get(),
        ref.collection('versions').orderBy('updatedAt', 'desc').limit(100).get(),
      ]);
      return { history: history.docs.map((x) => publicRow(x)), problem: publicRow(doc, canEdit(doc)), can_approve: full,
        versions: releases.docs.map((x) => publicRow(x)).sort((a, b) => b.evaluator.version - a.evaluator.version) };
    }

    if (action === 'register') {
      let data;
      try { data = normalize(d.registration); } catch (e) { throw error('invalid-argument', e.message); }
      const pid = 'ak-' + sha(data.source_id).slice(0, 24), bid = pid + '-' + data.evaluator.commit;
      const problem = db.collection('problemBank').doc(pid), benchmark = db.collection('benchmarks').doc(bid), receipt = db.collection('benchmarkReceipts').doc(data.idempotency_key);
      const fingerprint = sha(canonical(data)), release = releaseFingerprint(data), at = Date.now();
      const out = { problem_id: pid, benchmark_id: bid, commit: data.evaluator.commit, idempotency_key: data.idempotency_key };
      return db.runTransaction(async (tx) => {
        const [p, b, r, project] = await Promise.all([tx.get(problem), tx.get(benchmark), tx.get(receipt), tx.get(projectRef(data.project_id, data.project_board))]);
        if (!project.exists) throw error('failed-precondition', 'The linked BOLD OS project does not exist.');
        if (p.exists && p.data().createdBy !== email && !full) throw error('permission-denied', 'Only its registering account or a PI/admin can update this problem.');
        if (r.exists) {
          if (r.data().fingerprint !== fingerprint) throw error('already-exists', 'This request key belongs to different evidence.');
          return r.data().receipt;
        }
        // A release is written once: the same commit again must be the same release.
        if (b.exists) {
          if (b.data().fingerprint !== release) throw error('already-exists', 'This commit is already registered with different evidence. Register the change as a new version.');
          tx.set(receipt, { fingerprint, receipt: out, createdBy: email, createdAt: at });
          return out;
        }
        if (p.exists && p.data().latest_version >= data.evaluator.version) throw error('failed-precondition', 'Version ' + data.evaluator.version + ' or a newer one is already registered.');
        const author = p.exists ? p.data().createdBy : email;
        const problemData = { source_id: data.source_id, title: data.title, objective: data.objective, task_kind: data.task_kind,
          project_id: data.project_id, project_board: data.project_board, project_title: project.data().title || data.project_id,
          details: Object.assign({}, p.exists ? p.data().details : {}, data.details), session: data.session, stage: data.stage,
          reported_approval: data.reported_approval, approval: null, evaluator: data.evaluator,
          latest_benchmark: bid, latest_commit: data.evaluator.commit, latest_version: data.evaluator.version,
          archived: p.exists ? !!p.data().archived : false, notes: p.exists ? (p.data().notes || '') : '',
          createdBy: author, createdAt: p.exists ? p.data().createdAt : at, updatedBy: email, updatedAt: at };
        const benchmarkData = { problem_id: pid, source_id: data.source_id, title: data.title, task_kind: data.task_kind, evaluator: data.evaluator,
          research: data.research, reported_approval: data.reported_approval, approval: null, stage: data.stage, validation: data.validation,
          fingerprint: release, createdBy: author, createdAt: at, updatedBy: email, updatedAt: at };
        tx.set(problem, problemData);
        tx.set(benchmark, benchmarkData);
        tx.set(problem.collection('versions').doc(data.idempotency_key), Object.assign({}, problemData, { changeNote: 'Registered evaluator version ' + data.evaluator.version }));
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
        if (!linked.exists) throw error('failed-precondition', 'The linked project no longer exists.');
        if (!doc.exists) throw error('not-found', 'This problem is not registered.');
        if (doc.data().createdBy !== email && !full) throw error('permission-denied', 'Only its registering account or a PI/admin can edit this problem.');
        // The owner: chosen from the roster (owner_id), or else kept as it was.
        const was = doc.data();
        if (owner) metadata.owner = owner.owner;
        else if ((was.details || {}).owner) metadata.owner = was.details.owner;
        else delete metadata.owner;
        const update = { notes: d.notes.trim(), archived: d.archived, project_id: project.id, project_board: project.board, project_title: project.title,
          details: metadata, owner_id: owner ? owner.owner_id : (was.owner_id || null), updatedBy: email, updatedAt: Date.now() };
        if (d.definition) {
          if (doc.data().stage !== 'open') throw error('failed-precondition', 'Change an evaluator contract through AutoKaggle.');
          try { for (const [key, limit] of [['title', 180], ['objective', 8000], ['task_kind', 80]]) update[key] = text(d.definition[key], limit, key); }
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
