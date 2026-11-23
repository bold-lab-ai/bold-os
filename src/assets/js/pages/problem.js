// One problem in the Problem Bank (problem.html?problem=<id>), laid out and edited as a
// project's page (pages/project.js, project.css): the title and its badges, then tabs.
// Overview is a grid of fields, each edited in place (Edit, then Save or Cancel), with the
// research question below it as a project's abstract. Read and saved through the
// benchmarkRegistry callable (functions/benchmark-registry.js).
(function(){
  'use strict';
  if (!document.getElementById('problemBody') || !BOLD.getAuth()) return;
  var esc = BOLD.escapeHtml;
  var el = function(id){ return document.getElementById(id); };
  var call = function(data){ return firebase.app().functions('europe-west2').httpsCallable('benchmarkRegistry')(data).then(function(r){ return r.data; }); };
  var id = new URLSearchParams(location.search).get('problem') || '';

  var NOT_EDITOR = 'Only whoever added it, PIs and admins can do this';
  var CONTRACT = 'It’s the evaluator’s contract: change it in AutoKaggle and register a new version';
  var STAGES = { open: 'Open problem', implemented: 'Implemented', checked: 'Checked', validated: 'Validated' };
  // The fields edited as text, in order: label, and whether it's one line.
  var TEXT = [['collaborators', 'Collaborators'], ['submission_format', 'Submission format'], ['metrics', 'Metrics and score direction'],
    ['run_command', 'Run command'], ['dependencies', 'Dependencies'], ['seeds', 'Seeds'], ['compute', 'Compute requirements'],
    ['data_assets', 'Data and assets'], ['limitations', 'Known limitations'], ['open_issues', 'Open issues'], ['next_action', 'Next action']];
  // AutoKaggle's addresses (settings/problemBank, set on Settings › Problem Bank); these until they're saved.
  var urls = { autokaggleUrl: 'https://ecc962fa-2f4c-4a3f-96c4-179af273fb7a.k8s.civo.com/', autokaggleLiteUrl: 'https://lite.ecc962fa-2f4c-4a3f-96c4-179af273fb7a.k8s.civo.com/lite' };

  var p = null, releases = [], history = [], canApprove = false, canRemind = false, projects = [], people = [], editing = false, busy = false;
  var tab = (location.hash.match(/[#&]tab=([^&]+)/) || [])[1];
  var TABS = [['overview', 'Overview'], ['releases', 'Evaluator releases'], ['history', 'History']];
  if (!TABS.some(function(t){ return t[0] === tab; })) tab = 'overview';

  /* ---------- the project page's pieces (pages/project.js) ---------- */
  function missing(){ return '<span class="detail-muted">Not set</span>'; }
  function act(html){ return '<span class="detail-act">' + html + '</span>'; }
  function row(label, valueHtml){
    var acts = [];
    var value = String(valueHtml).replace(/\s*<span class="detail-act">([\s\S]*?)<\/span>/g, function(m, inner){ acts.push(inner.trim()); return ''; });
    return '<dt>' + esc(label) + '</dt><dd>' + value + (acts.length ? act(acts.join('<span class="detail-or">or</span>')) : '') + '</dd>';
  }
  function when(ms){ return ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
  function canEdit(){ return !!(p && p.can_edit); }
  function isOpen(){ return p && p.stage === 'open'; }
  function editableDefinition(){ return isOpen() || p.origin === 'problem_bank'; }
  function verifierLink(){
    var url = new URL(urls.autokaggleLiteUrl);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    url.pathname = url.pathname.replace(/\/$/, '') + '/from-problem';
    url.hash = new URLSearchParams({ problem: p.id, project: p.project_id, board: p.project_board || '',
      title: p.title, question: (p.objective || '').slice(0, 4000) }).toString();
    return url.href;
  }
  function editButton(what, why){
    var off = !canEdit() ? NOT_EDITOR : (why || '');
    return ' ' + act('<button class="btn-text detail-inline-edit" type="button" data-edit="' + what + '"' + (off ? ' disabled title="' + esc(off) + '"' : '') + '>Edit</button>');
  }
  function saveCancelHtml(){
    return '<div class="field-error" id="detailEditError" hidden></div>' +
      '<div class="stage-fields-actions"><button class="btn" type="button" id="fieldSave">Save</button><button class="btn" type="button" id="editCancel">Cancel</button></div>';
  }
  // A row with an Edit button; while it's being edited, its editor (with Save and Cancel) replaces the value.
  function editableRow(key, label, valueHtml, editorHtml, why){
    return editing === key ? row(label, editorHtml + saveCancelHtml()) : row(label, valueHtml + editButton(key, why));
  }
  function text(v){ return v ? BOLDRegistryLinks.formatText(String(v)) : missing(); }
  function projectHref(){ return 'project.html#id=' + encodeURIComponent(p.project_id) + (p.project_board ? '&board=' + encodeURIComponent(p.project_board) : ''); }
  function sessionUrl(handoff){
    var base = p.session.application === 'lite' ? urls.autokaggleLiteUrl : urls.autokaggleUrl;
    return base + '?project=' + encodeURIComponent(p.session.project_id) + (handoff ? '&review=handoff' : '');
  }
  function external(href, label){ return '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(label) + ' ↗</a>'; }

  /* ---------- the tabs ---------- */
  var PANELS = {
    overview: function(){
      var d = p.details || {};
      var html = '<dl class="detail-grid">';
      html += editableRow('project', 'Project', '<a href="' + esc(projectHref()) + '">' + esc(p.project_title || p.project_id) + '</a>',
        '<select id="fieldInput"><option value="">Loading projects…</option></select>', p.has_linked_verifiers ? 'Linked verifiers use this project.' : '');
      html += editableRow('owner', 'Research owner',
        d.owner ? (p.owner_id ? '<a href="person.html?id=' + encodeURIComponent(p.owner_id) + '">' + esc(d.owner) + '</a>' : esc(d.owner)) : missing(),
        '<select id="fieldInput"><option value="">Loading the lab’s people…</option></select>');
      html += editableRow('task_kind', 'Task type', p.task_kind ? esc(p.task_kind) : missing(),
        '<input type="text" id="fieldInput" maxlength="80" value="' + esc(p.task_kind || '') + '">', isOpen() ? '' : CONTRACT);
      ['significance', 'existing_solutions'].forEach(function(key){
        if (!editableDefinition() && !p[key]) return;
        html += editableRow(key, key === 'significance' ? 'Why it matters' : 'Existing methods and the gap', text(p[key]),
          '<textarea class="no-tags" id="fieldInput" maxlength="8000">' + esc(p[key] || '') + '</textarea>', editableDefinition() ? '' : CONTRACT);
      });
      TEXT.forEach(function(f){
        html += editableRow(f[0], f[1], text(d[f[0]]), '<div class="field"><textarea id="fieldInput" class="no-tags" maxlength="8000">' + esc(d[f[0]] || '') + '</textarea></div>');
      });
      if (p.session) html += row('AutoKaggle', external(sessionUrl(false), 'Resume the session') + ' · ' + external(sessionUrl(true), 'Manage its handoff'));
      html += editableRow('notes', 'Notes', text(p.notes), '<div class="field"><textarea id="fieldInput" class="no-tags" maxlength="8000">' + esc(p.notes || '') + '</textarea></div>');
      html += row('Added', p.createdAt ? esc(when(p.createdAt)) : missing());
      html += '</dl>';
      // The research question, as a project's abstract.
      html += editing === 'objective'
        ? '<div class="detail-abstract"><div class="field"><label for="fieldInput">Research question</label><textarea id="fieldInput" class="no-tags" maxlength="8000">' + esc(p.objective || '') + '</textarea></div>' + saveCancelHtml() + '</div>'
        : '<div class="detail-abstract"><div class="detail-abstract-label">Research question' + editButton('objective', editableDefinition() ? '' : CONTRACT) + '</div>' +
          (p.objective ? '<div class="abstract-render">' + esc(p.objective) + '</div>' : missing()) + '</div>';
      return html;
    },
    releases: function(){
      if (!releases.length) return '<p class="detail-muted">Registered verifiers and their checks will appear here.</p>';
      return '<ul class="talk-list">' + releases.map(function(r){
        var e = r.evaluator, a = r.approval, ra = r.reported_approval, v = r.research;
        var checks = Object.keys(r.validation || {}).map(function(k){ return [k.replace(/_/g, ' '), r.validation[k]]; });
        if (v) checks = checks.concat([['Measured fitness', v.observed_fitness], ['Expected fitness', v.expected_fitness], ['Tolerance', v.tolerance], ['Expected-score basis', v.expected_basis],
          ['Reference SHA-256', v.reference_sha256], ['Artifact SHA-256', v.artifact_sha256], ['Report SHA-256', v.report_sha256], ['Controlled run', v.checked_by]]);
        if (ra) checks = checks.concat([['AutoKaggle reports approval', ra.approved_at], ['Its approval note', ra.note]]);
        var approve = !a && r.stage === 'validated'
          ? '<button class="btn-text" type="button" data-approve="' + esc(r.id) + '"' + (canApprove ? '' : ' disabled title="Only a PI or admin approves a release"') + '>Approve</button>' : '';
        return '<li><div class="talk-when">Registered ' + esc(when(r.createdAt)) + ' · ' + esc(STAGES[r.stage] || r.stage) + ', reported by AutoKaggle</div>' +
          '<div class="talk-title">' + esc(r.title) + ' · version ' + esc(String(e.version)) + '</div>' +
          '<div class="talk-when">' + (a ? 'Approved by ' + esc(a.name) + ', ' + esc(when(a.at)) + (a.note ? ': ' + esc(a.note) : '') : 'Not approved in BOLD.OS') + '</div>' +
          '<div class="talk-actions">' + external(e.repository, 'Repository') + external(e.repository + '/tree/' + e.commit, 'Pinned code') + external(e.zip_url, 'ZIP') + external(urls.autokaggleLiteUrl + '?project=' + encodeURIComponent(r.source_id.slice(11)), 'Lite session') + approve + '</div>' +
          '<details><summary class="detail-muted">Checks and evidence</summary><dl class="detail-grid">' +
          [['Commit', e.commit], ['Contract SHA-256', e.contract_sha256]].concat(checks).map(function(x){ return row(x[0], text(x[1] == null ? '' : x[1])); }).join('') +
          '</dl></details></li>';
      }).join('') + '</ul>';
    },
    history: function(){
      if (!history.length) return '<p class="detail-muted">No changes yet.</p>';
      return '<ul class="talk-list">' + history.map(function(h){
        return '<li><div class="talk-when">' + esc(new Date(h.updatedAt).toLocaleString()) + '</div><div class="talk-title">' + esc(h.changeNote || 'Changed') + '</div>' +
          '<div class="talk-when">' + esc([STAGES[h.stage], h.project_title, h.latest_commit ? h.latest_commit.slice(0, 12) : ''].filter(Boolean).join(' · ')) + '</div></li>';
      }).join('') + '</ul>';
    }
  };

  function render(){
    var html = '<div class="detail-head">' + (editing === 'title'
      ? '<div class="detail-title-edit"><input type="text" id="fieldInput" maxlength="180" value="' + esc(p.title || '') + '" aria-label="Title">' + saveCancelHtml() + '</div>'
      : '<h2>' + esc(p.title) + editButton('title', editableDefinition() ? '' : CONTRACT) + '</h2>');
    if (!p.evaluator) html += '<span class="badge pb-missing">No verifier</span>';
    html += '<div class="detail-badges">';
    if (!isOpen()) html += '<span class="badge badge-stage">' + esc(STAGES[p.stage] || p.stage) + '</span>';
    if (p.approval) html += '<span class="badge">Approved</span>';
    if (p.archived) html += '<span class="badge">Archived</span>';
    // Archiving (or restoring) it: a plain edit, telling nobody.
    html += '<button class="btn-box detail-remove" type="button" id="archiveProblem"' + (canEdit() && !busy ? '' : ' disabled title="' + esc(canEdit() ? 'Saving…' : NOT_EDITOR) + '"') + '>' +
      (p.archived ? 'Restore problem' : 'Archive problem') + '</button>';
    html += '</div></div>';
    // Under the title: its project, its owner, and where its stage comes from.
    var owner = (p.details || {}).owner;
    html += '<p class="detail-venue">Project: <a href="' + esc(projectHref()) + '">' + esc(p.project_title || p.project_id) + '</a>' +
      (owner ? ' · ' + (p.owner_id ? '<a href="person.html?id=' + encodeURIComponent(p.owner_id) + '">' + esc(owner) + '</a>' : esc(owner)) : '') +
      (isOpen() ? '' : ' · Latest verifier stage reported by AutoKaggle') + '</p>';
    html += '<ol class="pb-steps" aria-label="Problem onboarding"><li>Problem defined</li><li>' +
      (p.archived || !BOLD.can('projects', 'edit') ? '<button class="btn-box" disabled title="' + esc(p.archived ? 'Restore this problem first.' : BOLD.cannotReason('projects', 'edit')) + '">Add verifier</button>'
        : '<button type="button" class="btn-primary btn-box" id="addVerifier">' + (p.evaluator ? 'Add another verifier' : 'Add verifier') + '</button>') +
      '</li><li>Autoresearch baseline <small>Coming soon</small></li></ol>';
    if (canRemind && !p.archived && !p.evaluator) html += '<p><button type="button" class="btn-text" id="toggleReminder">' +
      (p.reminders ? 'Turn off my weekly reminders' : 'Remind me to add a verifier') + '</button></p>';
    html += '<div class="tabs" role="tablist" aria-label="Problem">' + TABS.map(function(t){
      var on = t[0] === tab;
      return '<button class="tab' + (on ? ' active' : '') + '" type="button" role="tab" data-tab="' + t[0] + '" aria-selected="' + on + '"' + (on ? '' : ' tabindex="-1"') + '>' +
        t[1] + (t[0] === 'releases' && releases.length ? '<span class="proj-count">' + releases.length + '</span>' : '') + '</button>';
    }).join('') + '</div>';
    html += '<div class="tab-panel" id="problemPanel">' + PANELS[tab]() + '</div>';
    el('problemBody').innerHTML = html; el('problemBody').hidden = false; el('detailMsg').hidden = true;
    document.title = p.title + ' | BOLD Lab';
    wire();
  }

  function setTab(name, focus){
    if (name === tab) return;
    try { history_replace(name === 'overview' ? '' : '#tab=' + name); } catch (e){}
    BOLD.switchTab('.tabs', el('problemBody'), function(){ tab = name; editing = false; render(); });
    if (focus) document.querySelector('.tab.active').focus();
  }
  function history_replace(hash){ window.history.replaceState(null, '', location.pathname + location.search + hash); }

  /* ---------- editing one field at a time ---------- */
  // The server takes the whole record; the field being edited is changed in it.
  function save(patch){
    var d = Object.assign({}, p.details || {}); delete d.owner;
    var data = { action: 'update', problem_id: p.id, project_id: p.project_id, project_board: p.project_board || '', details: d, owner_id: '', notes: p.notes || '', archived: !!p.archived };
    if ('project' in patch) { data.project_id = patch.project[0]; data.project_board = patch.project[1] || ''; }
    if ('owner_id' in patch) data.owner_id = patch.owner_id;
    if ('notes' in patch) data.notes = patch.notes;
    if ('archived' in patch) data.archived = patch.archived;
    if ('details' in patch) Object.keys(patch.details).forEach(function(k){ if (patch.details[k]) d[k] = patch.details[k]; else delete d[k]; });
    ['title', 'objective', 'task_kind', 'significance', 'existing_solutions'].forEach(function(k){
      if (k in patch) { data.definition = data.definition || {}; data.definition[k] = patch[k]; }
    });
    return call(data).then(load);
  }
  function failer(){ var e = el('detailEditError'); return function(msg){ if (e) { e.textContent = msg; e.hidden = false; } }; }

  function wire(){
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function(t, i, all){
      t.addEventListener('click', function(){ setTab(t.getAttribute('data-tab')); });
      t.addEventListener('keydown', function(e){
        var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (d) { e.preventDefault(); setTab(all[(i + d + all.length) % all.length].getAttribute('data-tab'), true); }
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-edit]'), function(btn){
      btn.addEventListener('click', function(){ if (canEdit() && !btn.disabled) { editing = btn.getAttribute('data-edit'); render(); } });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-approve]'), function(b){
      b.addEventListener('click', function(){
        if (!canApprove) return;
        b.disabled = true;
        call({ action: 'approve', benchmark_id: b.getAttribute('data-approve') }).then(load).catch(function(e){ b.disabled = false; b.insertAdjacentText('afterend', ' Not approved. ' + e.message); });
      });
    });
    el('archiveProblem').addEventListener('click', function(){
      if (!canEdit() || busy) return;
      busy = true; render();
      save({ archived: !p.archived }).catch(function(e){ busy = false; render(); alertLine(e); });
    });
    if (el('toggleReminder')) el('toggleReminder').onclick = async function(){
      var button = this, enable = !p.reminders;
      button.disabled = true;
      try {
        if (enable && !await BOLD.confirmAction({ title: 'Enable verifier reminders?', always: true, go: 'Enable reminders',
          effects: ['Remind you on Slack now and every week until this problem has a verifier. Your notification settings apply.'] })) return;
        await call({ action: 'reminders', problem_id: id, reminders: enable }); await load();
      } catch (e){ alertLine(e); } finally { button.disabled = false; }
    };
    if (el('addVerifier')) el('addVerifier').onclick = async function(){
      var url = verifierLink();
      if (!url) return alertLine(new Error('Check the AutoKaggle Lite address in Settings.'));
      var ok = await BOLD.confirmAction({ title: 'Open AutoKaggle Lite?', always: true, go: 'Open Lite',
        effects: ['Share this title, research question, and project and problem IDs with AutoKaggle Lite to start a verifier.'] });
      if (ok) location.assign(url);
    };
    if (!editing) return;
    var input = el('fieldInput'), fail = failer();
    el('editCancel').addEventListener('click', function(){ editing = false; render(); });
    if (editing === 'project') {
      input.innerHTML = '<option value="">Choose a project</option>' + projects.map(function(x){
        var on = x.id === p.project_id && (x.board || '') === (p.project_board || '');
        return '<option value="' + esc(JSON.stringify([x.id, x.board])) + '"' + (on ? ' selected' : '') + '>' + esc(x.title + (x.venue ? ' · ' + x.venue : '')) + '</option>';
      }).join('');
    }
    if (editing === 'owner') BoldPeopleSelect.load().then(function(list){ input.innerHTML = BoldPeopleSelect.options(list, p.owner_id, 'Choose the research owner'); });
    if (input && input.focus) input.focus();
    el('fieldSave').addEventListener('click', function(){
      var v = input.value, patch = {};
      if (editing === 'project') { if (!v) return fail('Choose its project.'); patch.project = JSON.parse(v); }
      else if (editing === 'owner') { if (!v) return fail('Choose the research owner.'); patch.owner_id = v; }
      else if (editing === 'title' || editing === 'objective' || editing === 'task_kind' || editing === 'significance' || editing === 'existing_solutions') { if (!v.trim()) return fail('This can’t be empty.'); patch[editing] = v.trim(); }
      else if (editing === 'notes') patch.notes = v;
      else { patch.details = {}; patch.details[editing] = v.trim(); }
      el('fieldSave').disabled = true;
      save(patch).then(function(){ editing = false; render(); }).catch(function(e){ el('fieldSave').disabled = false; fail((e && e.message) || 'Could not save — try again.'); });
    });
  }
  function alertLine(e){ el('detailMsg').hidden = false; el('detailMsg').textContent = 'Could not save. ' + ((e && e.message) || ''); }

  /* ---------- loading ---------- */
  function load(){
    return call({ action: 'get', problem_id: id }).then(function(data){
      p = data.problem; releases = data.versions || []; history = data.history || []; canApprove = !!data.can_approve; canRemind = !!data.can_manage_reminders; busy = false;
      render();
    });
  }
  function loadUrls(){
    return firebase.firestore(BOLD.getApp()).collection('settings').doc('problemBank').get().then(function(x){
      if (x.exists) ['autokaggleUrl', 'autokaggleLiteUrl'].forEach(function(k){ if (x.data()[k]) urls[k] = x.data()[k]; });
    }).catch(function(){});
  }
  BOLD.onAccess(function(){ if (p && !editing) render(); });
  BOLD.onUser(function(user){
    if (!user) return;
    if (!/^ak-[a-f0-9]{24}$/.test(id)) { el('detailMsg').textContent = 'No such problem.'; return; }
    call({ action: 'projects' }).then(function(r){ projects = r.items; if (editing === 'project') render(); }).catch(function(){});
    Promise.all([loadUrls()]).then(load).catch(function(e){ el('detailMsg').textContent = 'Could not load this problem. ' + ((e && e.message) || ''); });
  });
})();
