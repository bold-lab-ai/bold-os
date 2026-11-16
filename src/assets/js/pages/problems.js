// The Problem Bank (problems.html), laid out as Projects: a list (List or Grid, tabs by stage,
// search), and one problem (?problem=<id>) as a project's page. Everything is read and
// written through the benchmarkRegistry callable (functions/benchmark-registry.js).
(function(){
  'use strict';
  if (!document.getElementById('pbList') || !BOLD.getAuth()) return;
  var esc = BOLD.escapeHtml;
  var el = function(id){ return document.getElementById(id); };
  var call = function(data){ return firebase.app().functions('europe-west2').httpsCallable('benchmarkRegistry')(data).then(function(r){ return r.data; }); };
  var VIEW_KEY = 'boldProblems:view';

  // A stage is AutoKaggle's report; an open problem has no evaluator yet.
  var STAGES = { open: 'Open problem', implemented: 'Implemented', checked: 'Checked', validated: 'Validated' };
  var FIELDS = { owner: 'Research owner', collaborators: 'Collaborators', submission_format: 'Submission format', metrics: 'Metrics and score direction',
    run_command: 'Run command', dependencies: 'Dependencies', seeds: 'Seeds', compute: 'Compute requirements',
    data_assets: 'Data and assets: source, version, access and licence', limitations: 'Known limitations', open_issues: 'Open issues',
    next_action: 'Next action and responsible person' };
  // AutoKaggle's addresses (settings/problemBank, set by PIs and admins at the foot of the list); these until one is saved.
  var urls = { autokaggleUrl: 'https://ecc962fa-2f4c-4a3f-96c4-179af273fb7a.k8s.civo.com/', autokaggleLiteUrl: 'https://lite.ecc962fa-2f4c-4a3f-96c4-179af273fb7a.k8s.civo.com/lite' };

  var rows = [], cursor = null, projects = [], q = '', loaded = false, generation = 0;
  var problemId = new URLSearchParams(location.search).get('problem');

  function when(value){ var d = new Date(value); return isNaN(d) ? 'Not recorded' : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }); }
  function external(href, label){ return '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(label) + ' ↗</a>'; }
  function projectHref(p){ return 'project.html#id=' + encodeURIComponent(p.project_id) + (p.project_board ? '&board=' + encodeURIComponent(p.project_board) : ''); }
  function tabOf(p){ return p.archived ? 'archived' : (STAGES[p.stage] ? p.stage : 'open'); }
  function badges(p){
    var out = [];
    if (p.stage && p.stage !== 'open') out.push('<span class="badge badge-stage">' + esc(STAGES[p.stage] || p.stage) + '</span>');
    if (p.approval) out.push('<span class="badge badge-approved">Approved</span>');
    if (p.archived) out.push('<span class="badge">Archived</span>');
    return out.join('');
  }
  function projectOptions(selected){
    return '<option value="">Choose a project</option>' + projects.map(function(x){
      var on = selected && selected.project_id === x.id && (selected.project_board || '') === (x.board || '');
      return '<option value="' + esc(JSON.stringify([x.id, x.board])) + '"' + (on ? ' selected' : '') + '>' + esc(x.title + (x.venue ? ' · ' + x.venue : '')) + '</option>';
    }).join('');
  }

  /* ---------- the list ---------- */
  function matches(p){
    if (!q) return true;
    var hay = [p.title, p.objective, p.task_kind, p.project_title, (p.details || {}).owner, (p.evaluator || {}).commit].join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).every(function(w){ return hay.indexOf(w) >= 0; });
  }
  function row(p){
    var meta = ['<a href="' + esc(projectHref(p)) + '">' + esc(p.project_title || p.project_id) + '</a>'];
    if ((p.details || {}).owner) meta.push(esc(p.details.owner));
    if (p.task_kind) meta.push(esc(p.task_kind));
    if (p.evaluator) meta.push('Evaluator v' + esc(String(p.evaluator.version)));
    return '<li><div class="proj-main">' +
      '<a class="proj-title" href="problems.html?problem=' + encodeURIComponent(p.id) + '">' + esc(p.title) + '</a>' +
      '<span class="proj-meta">' + meta.join(' · ') + '</span>' +
      (p.objective ? '<p class="proj-abstract">' + esc(p.objective) + '</p>' : '') +
      (badges(p) ? '<div class="proj-badges">' + badges(p) + '</div>' : '') +
      '</div></li>';
  }
  function renderList(){
    var groups = { open: [], implemented: [], checked: [], validated: [], archived: [] };
    rows.filter(matches).forEach(function(p){ groups[tabOf(p)].push(p); });
    Object.keys(groups).forEach(function(k){
      var cap = k.charAt(0).toUpperCase() + k.slice(1);
      el('pb' + cap).innerHTML = groups[k].length ? groups[k].map(row).join('') : '<li class="proj-none"><p class="proj-empty">' + (q ? 'No problems match.' : 'None') + '</p></li>';
      el('cnt' + cap).textContent = groups[k].length || (q ? '0' : '');
    });
    el('pbClear').hidden = !q;
    el('pbMore').hidden = !cursor;
    el('pbMsg').hidden = true; el('problems').hidden = false;
  }
  function loadList(more){
    var epoch = generation;
    el('pbMore').disabled = true;
    return call({ action: 'list', cursor: more ? cursor : null }).then(function(r){
      if (epoch !== generation) return;
      rows = more ? rows.concat(r.items) : r.items; cursor = r.cursor; loaded = true;
      renderList();
    }).catch(function(e){
      if (epoch !== generation) return;
      el('pbMsg').hidden = false; el('pbMsg').textContent = 'Could not load the Problem Bank. ' + (e.message || '');
    }).then(function(){ el('pbMore').disabled = false; });
  }

  /* ---------- list / grid, as Projects ---------- */
  function setView(view){
    if (view !== 'grid') view = 'list';
    el('problems').setAttribute('data-view', view);
    Array.prototype.forEach.call(document.querySelectorAll('.view-btn'), function(b){ b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === view)); });
    try { localStorage.setItem(VIEW_KEY, view); } catch (e){}
  }
  Array.prototype.forEach.call(document.querySelectorAll('.view-btn'), function(b){ b.addEventListener('click', function(){ setView(b.getAttribute('data-view')); }); });
  try { setView(localStorage.getItem(VIEW_KEY)); } catch (e){}

  /* ---------- tabs, as Projects (#validated opens that tab) ---------- */
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  function setTab(name){
    tabs.forEach(function(t){
      var on = t.getAttribute('data-tab') === name;
      t.classList.toggle('active', on); t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1;
      el(t.getAttribute('aria-controls')).hidden = !on;
    });
  }
  tabs.forEach(function(t, i){
    t.addEventListener('click', function(){ BOLD.switchTab('.tabs', el('problems').parentNode, function(){ setTab(t.getAttribute('data-tab')); }); history.replaceState(null, '', '#' + t.getAttribute('data-tab')); });
    t.addEventListener('keydown', function(e){
      var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      var next = tabs[(i + d + tabs.length) % tabs.length];
      next.click(); next.focus(); e.preventDefault();
    });
  });
  var hashTab = (location.hash || '').slice(1);
  if (tabs.some(function(t){ return t.getAttribute('data-tab') === hashTab; })) setTab(hashTab);

  el('pbSearch').addEventListener('input', function(){ q = el('pbSearch').value.trim(); if (loaded) renderList(); });
  el('pbClear').addEventListener('click', function(){ q = ''; el('pbSearch').value = ''; renderList(); });
  el('pbMore').addEventListener('click', function(){ loadList(true); });

  /* ---------- adding an open problem ---------- */
  el('pbNew').addEventListener('click', function(){ el('pbCreate').hidden = !el('pbCreate').hidden; if (!el('pbCreate').hidden) el('pbCreateTitle').focus(); });
  el('pbCreateCancel').addEventListener('click', function(){ el('pbCreate').hidden = true; });
  el('pbCreate').addEventListener('submit', function(event){
    event.preventDefault();
    var form = event.currentTarget, button = form.querySelector('[type=submit]'), project = JSON.parse(form.elements.project.value);
    button.disabled = true; el('pbCreateStatus').textContent = 'Saving…';
    call({ action: 'create', project_id: project[0], project_board: project[1], title: form.elements.title.value, objective: form.elements.objective.value,
      task_kind: form.elements.task_kind.value, details: { owner: form.elements.owner.value } })
      .then(function(r){ location.href = 'problems.html?problem=' + encodeURIComponent(r.problem_id); })
      .catch(function(e){ el('pbCreateStatus').textContent = 'Not saved. ' + e.message; button.disabled = false; });
  });

  /* ---------- AutoKaggle's addresses: everyone reads them, PIs and admins change them ---------- */
  function loadUrls(){
    return firebase.firestore(BOLD.getApp()).collection('settings').doc('problemBank').get().then(function(x){
      if (x.exists) ['autokaggleUrl', 'autokaggleLiteUrl'].forEach(function(k){ if (x.data()[k]) urls[k] = x.data()[k]; });
    }).catch(function(){}).then(function(){
      var form = el('pbUrls'), full = BOLD.isFullWrite(), why = full ? '' : 'Only a PI or admin changes them';
      el('pbLite').href = urls.autokaggleLiteUrl;
      ['autokaggleUrl', 'autokaggleLiteUrl'].forEach(function(k){ form.elements[k].value = urls[k]; form.elements[k].disabled = !full; });
      var b = form.querySelector('[type=submit]'); b.disabled = !full; b.title = why;
    });
  }
  el('pbUrls').addEventListener('submit', function(event){
    event.preventDefault();
    var form = event.currentTarget, user = BOLD.getAuth().currentUser;
    var value = { autokaggleUrl: form.elements.autokaggleUrl.value.trim(), autokaggleLiteUrl: form.elements.autokaggleLiteUrl.value.trim(),
      updatedAt: Date.now(), updatedBy: String((user && user.email) || '').toLowerCase() };
    el('pbUrlsStatus').textContent = 'Saving…';
    firebase.firestore(BOLD.getApp()).collection('settings').doc('problemBank').set(value)
      .then(function(){ urls.autokaggleUrl = value.autokaggleUrl; urls.autokaggleLiteUrl = value.autokaggleLiteUrl; el('pbLite').href = urls.autokaggleLiteUrl; el('pbUrlsStatus').textContent = 'Saved.'; })
      .catch(function(e){ el('pbUrlsStatus').textContent = 'Not saved. ' + e.message; });
  });

  /* ---------- one problem, as a project's page ---------- */
  function sessionUrl(p, handoff){
    var base = p.session.application === 'lite' ? urls.autokaggleLiteUrl : urls.autokaggleUrl;
    return base + '?project=' + encodeURIComponent(p.session.project_id) + (handoff ? '&review=handoff' : '');
  }
  function grid(pairs){
    return '<dl class="detail-grid">' + pairs.map(function(x){
      return '<dt>' + esc(x[0]) + '</dt><dd>' + (x[2] ? x[1] : BOLDRegistryLinks.formatText(x[1] == null || x[1] === '' ? 'Not recorded' : String(x[1]))) + '</dd>';
    }).join('') + '</dl>';
  }
  function release(r, canApprove){
    var e = r.evaluator, v = r.research, a = r.approval, ra = r.reported_approval;
    var checks = Object.keys(r.validation || {}).map(function(k){ return [k.replace(/_/g, ' '), r.validation[k]]; });
    if (v) checks = checks.concat([['Measured fitness', v.observed_fitness], ['Expected fitness', v.expected_fitness], ['Tolerance', v.tolerance], ['Expected-score basis', v.expected_basis],
      ['Reference SHA-256', v.reference_sha256], ['Artifact SHA-256', v.artifact_sha256], ['Validation report SHA-256', v.report_sha256], ['Controlled run', v.checked_by], ['Validated', when(v.checked_at)]]);
    if (ra) checks = checks.concat([['AutoKaggle reports approval', when(ra.approved_at)], ['Its approval note', ra.note]]);
    var approve = !a && r.stage === 'validated'
      ? ' <button type="button" class="btn-text" data-approve="' + esc(r.id) + '"' + (canApprove ? '' : ' disabled title="Only a PI or admin approves a release"') + '>Approve this release</button>' : '';
    return '<li class="pb-release"><div class="pb-release-head"><span class="pb-release-title">Evaluator version ' + esc(String(e.version)) + '</span>' +
      '<span class="badge badge-stage">' + esc(STAGES[r.stage] || r.stage) + '</span>' + (a ? '<span class="badge badge-approved">Approved</span>' : '') + '</div>' +
      '<p class="pb-release-meta">' + (a ? 'Approved by ' + esc(a.name) + ', ' + esc(when(a.at)) + (a.note ? ': ' + esc(a.note) : '') : 'Not approved in BOLD.OS') + ' · registered ' + esc(when(r.createdAt)) + approve + '</p>' +
      '<p class="pb-links">' + external(e.repository, 'Repository') + external(e.repository + '/tree/' + e.commit, 'Pinned code') + external(e.zip_url, 'Download ZIP') + '</p>' +
      '<details><summary>Checks and evidence</summary>' + grid([['Commit', e.commit], ['Contract SHA-256', e.contract_sha256]].concat(checks)) + '</details></li>';
  }
  function editForm(p){
    var off = p.can_edit ? '' : ' disabled';
    var field = function(label, html){ return '<div class="field"><label>' + esc(label) + '</label>' + html + '</div>'; };
    return '<form class="pb-form" id="pbEdit">' +
      field('Project', '<select name="project" required' + off + '>' + projectOptions(p) + '</select>') +
      (p.stage === 'open'
        ? field('Problem', '<input name="title" maxlength="180" required value="' + esc(p.title) + '"' + off + '>') +
          field('Research question', '<textarea name="objective" class="no-tags" required maxlength="8000"' + off + '>' + esc(p.objective) + '</textarea>') +
          field('Task type', '<input name="task_kind" required maxlength="80" value="' + esc(p.task_kind) + '"' + off + '>')
        : '') +
      Object.keys(FIELDS).map(function(k){ return field(FIELDS[k], '<textarea name="' + k + '" class="no-tags" maxlength="8000"' + off + '>' + esc((p.details || {})[k] || '') + '</textarea>'); }).join('') +
      field('Notes', '<textarea name="notes" class="no-tags" maxlength="8000"' + off + '>' + esc(p.notes || '') + '</textarea>') +
      '<label class="pb-check"><input name="archived" type="checkbox"' + (p.archived ? ' checked' : '') + off + '> Archive this problem</label>' +
      '<div class="pb-form-actions"><button class="btn btn-primary" type="submit"' + (p.can_edit ? '' : ' disabled title="Only whoever registered it, or a PI or admin, edits it"') + '>Save</button>' +
      '<span class="pb-status" id="pbEditStatus" role="status"></span></div>' +
      (p.stage === 'open' ? '' : '<p class="detail-hint">The problem itself is the evaluator’s contract: change it in AutoKaggle and register a new version.</p>') +
      '</form>';
  }
  function renderDetail(data){
    var p = data.problem;
    document.title = p.title + ' | BOLD Lab';
    var project = '<a href="' + esc(projectHref(p)) + '">' + esc(p.project_title || p.project_id) + '</a>';
    var session = p.session
      ? '<p class="pb-links">' + external(sessionUrl(p, false), 'Resume in AutoKaggle' + (p.session.application === 'lite' ? ' Lite' : '')) + external(sessionUrl(p, true), 'Manage session handoff') + '</p>' +
        '<p class="detail-hint">Sign in to the original session. Its owner can create a single-use handoff code, valid for 24 hours, and revoke access there. Codes are not stored in the Problem Bank.</p>'
      : '';
    el('pbBody').innerHTML =
      '<div class="detail-head"><h2>' + esc(p.title) + '</h2>' + (badges(p) ? '<div class="detail-badges">' + badges(p) + '</div>' : '') + '</div>' +
      '<p class="detail-venue">Project: ' + project + (p.stage !== 'open' ? ' · Stage reported by AutoKaggle' : '') + '</p>' +
      session +
      grid([['Research question', p.objective], ['Task type', p.task_kind]].concat(Object.keys(FIELDS).map(function(k){ return [FIELDS[k], (p.details || {})[k]]; })).concat(p.notes ? [['Notes', p.notes]] : [])) +
      '<h3 class="pb-section">Evaluator releases</h3>' +
      (data.versions.length ? '<ul class="pb-releases">' + data.versions.map(function(r){ return release(r, data.can_approve); }).join('') + '</ul>' : '<p class="detail-muted">No evaluator yet.</p>') +
      '<details class="pb-section-details"><summary>Edit</summary>' + editForm(p) + '</details>' +
      '<details class="pb-section-details"><summary>History</summary><ul class="pb-history">' + (data.history || []).map(function(h){
        return '<li><span class="pb-history-when">' + esc(when(h.updatedAt)) + '</span> ' + esc(h.changeNote || 'Changed') +
          ' · ' + esc(STAGES[h.stage] || h.stage || '') + ' · ' + esc(h.project_title || '') + (h.latest_commit ? ' · ' + esc(h.latest_commit.slice(0, 12)) : '') + '</li>';
      }).join('') + '</ul></details>';
    el('pbDetailMsg').hidden = true; el('pbBody').hidden = false;

    Array.prototype.forEach.call(el('pbBody').querySelectorAll('[data-approve]'), function(b){
      b.addEventListener('click', function(){
        if (!data.can_approve) return;
        b.disabled = true;
        call({ action: 'approve', benchmark_id: b.getAttribute('data-approve') }).then(loadDetail).catch(function(e){ b.disabled = false; b.insertAdjacentText('afterend', ' Not approved. ' + e.message); });
      });
    });
    el('pbEdit').addEventListener('submit', function(event){
      event.preventDefault();
      if (!p.can_edit) return;
      var form = event.currentTarget, button = form.querySelector('[type=submit]'), project = JSON.parse(form.elements.project.value), details = {};
      Object.keys(FIELDS).forEach(function(k){ var v = form.elements[k].value.trim(); if (v) details[k] = v; });
      var data = { action: 'update', problem_id: p.id, project_id: project[0], project_board: project[1], details: details, notes: form.elements.notes.value, archived: form.elements.archived.checked };
      if (p.stage === 'open') data.definition = { title: form.elements.title.value, objective: form.elements.objective.value, task_kind: form.elements.task_kind.value };
      button.disabled = true; el('pbEditStatus').textContent = 'Saving…';
      call(data).then(loadDetail).catch(function(e){ el('pbEditStatus').textContent = 'Not saved. ' + e.message; button.disabled = false; });
    });
  }
  function loadDetail(){
    var epoch = generation;
    return call({ action: 'get', problem_id: problemId }).then(function(data){ if (epoch === generation) renderDetail(data); })
      .catch(function(e){ if (epoch === generation) { el('pbDetailMsg').hidden = false; el('pbDetailMsg').textContent = 'Could not load this problem. ' + (e.message || ''); } });
  }

  /* ---------- start ---------- */
  el('pbHero').hidden = !!problemId; el('pbList').hidden = !!problemId; el('pbDetail').hidden = !problemId;
  BOLD.onUser(function(user){
    generation++;
    if (!user) { el('pbMsg').textContent = 'Sign in to see the Problem Bank.'; return; }
    BOLD.onAccess(function(){
      var can = BOLD.can('projects', 'edit');
      el('pbNew').disabled = !can; el('pbNew').title = can ? '' : BOLD.cannotReason('projects', 'edit');
      loadUrls();
    });
    // The project picker: one row per project, as Projects lists them.
    var picker = call({ action: 'projects' }).then(function(r){ projects = r.items; el('pbCreateProject').innerHTML = projectOptions(); }).catch(function(){});
    if (problemId) Promise.all([picker, loadUrls()]).then(loadDetail); else loadList(false);
  });
})();
