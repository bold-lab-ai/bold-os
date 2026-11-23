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
  var urls = BOLDRegistryLinks.defaults;

  var p = null, releases = [], history = [], canApprove = false, canRemind = false, projects = [], projectsLoaded = false, editing = false, busy = false;
  var userEpoch = 0, familyGraph = null, familyError = '', familySaving = false, familyRead = 0;
  var tab = (location.hash.match(/[#&]tab=([^&]+)/) || [])[1];
  var initialRelease = tab === 'releases' ? new URLSearchParams(location.hash.slice(1)).get('release') : null;
  var TABS = [['overview', 'Overview'], ['papers', 'Papers'], ['releases', 'Verifiers'], ['history', 'History']];
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
  function verifierLink(project){
    var base = BOLDRegistryLinks.serviceUrl(urls.autokaggleLiteUrl);
    if (!base) return '';
    var url = new URL(base);
    url.pathname = (url.pathname.replace(/\/$/, '') || '/lite') + '/from-problem';
    var fields = new URLSearchParams({ problem: p.id,
      title: p.title, question: [p.objective || p.title, p.significance && 'Why it matters: ' + p.significance, p.difficulties && 'Difficulties: ' + p.difficulties, p.existing_solutions && 'Frontier: ' + p.existing_solutions].filter(Boolean).join('\n').slice(0,4000) });
    if (project) { fields.set('project', project.id); if (project.board) fields.set('board', project.board); }
    url.hash = fields.toString();
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
  function external(href, label){ return '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(label) + ' ↗</a>'; }

  function familySection(){
    var html = '<section class="pb-family-panel" aria-label="Research family tree"><h3>Research family tree</h3>' +
      '<a href="problems.html?view=graph&amp;focus=' + encodeURIComponent(id) + '">Explore this problem in the graph</a>';
    if (!familyGraph) return html + (familyError ? '<p role="status">Could not load family links. <button type="button" class="btn-text" id="retryFamily">Try again</button></p>' : '<p role="status">Loading family links…</p>') + '</section>';
    if (editing === 'family') return html + '<fieldset id="familyEditor" aria-label="Family links"></fieldset>' + saveCancelHtml() + '</section>';
    var links = BoldProblemFamily.connections(familyGraph, id), nodes = BoldProblemFamily.index(familyGraph);
    var groups = [['parents','Contributes to'],['children','Problems that contribute to this'],['related','Related problems']];
    var items = groups.map(function(group){
      var linked = links[group[0]].map(function(to){return nodes.get(to);}).filter(Boolean);
      linked.sort(function(a,b){return a.title.localeCompare(b.title);});
      return linked.length ? row(group[1],linked.map(BoldProblemFamily.link).join(' · ')) : '';
    }).join('');
    var why = !canEdit() ? NOT_EDITOR : p.archived ? 'Restore this problem to change its links.' : familySaving ? 'Saving family links…' : '';
    return html + (items ? '<dl class="detail-grid">'+items+'</dl>' : '<p class="detail-muted">No family links yet.</p>') +
      '<button class="btn-text" data-edit="family" type="button"' + (why ? ' disabled title="' + esc(why) + '"' : '') + '>Edit family links</button></section>';
  }

  /* ---------- the tabs ---------- */
  var PANELS = {
    overview: function(){
      var d = p.details || {};
      var html = '<dl class="detail-grid">';
      html += editableRow('owner','Problem definer', d.owner ? (p.owner_id ? '<a href="person.html?id=' + encodeURIComponent(p.owner_id) + '">' + esc(d.owner) + '</a>' : esc(d.owner)) : missing(),
        '<select id="fieldInput" aria-label="Problem definer"></select>');
      [['significance','Why it matters'],['difficulties','What are the difficulties?'],['existing_solutions','Where is the frontier?']].forEach(function(f){
        html += editableRow(f[0],f[1],text(p[f[0]]),'<textarea id="fieldInput" aria-label="' + esc(f[1]) + '" maxlength="8000">' + esc(p[f[0]] || '') + '</textarea>');
      });
      html += editableRow('projects','Projects',(BoldProblemProjects.links(p.projects) || 'No linked projects') + ' · <a href="projects.html">All projects</a>',
        '<div id="fieldInput" class="pb-project-options" role="group" aria-label="Projects">' + BoldProblemProjects.fields(projects,p.selected_projects,p.id) + '</div>',projectsLoaded ? '' : 'Loading projects');
      html += editableRow('collaborators','Collaborators',text(d.collaborators),'<input id="fieldInput" aria-label="Collaborators" maxlength="8000" value="' + esc(d.collaborators || '') + '">');
      html += '</dl>';
      if (p.objective && p.objective !== p.title) html += '<p class="detail-abstract">' + text(p.objective) + '</p>';
      return html + familySection();
    },
    papers: function(){
      return p.papers.length ? BoldProblemPapers.list(p.papers) : '<p class="detail-muted">No papers registered for this problem.</p>';
    },
    releases: function(){
      if (!releases.length) return '<p class="detail-muted">Registered verifiers and their checks will appear here.</p>';
      return '<ul class="talk-list">' + releases.map(function(r){
        var e = r.evaluator, a = r.approval, ra = r.reported_approval, v = r.research;
        var details = r.details || (p.latest_benchmark === r.id && !p.has_linked_verifiers ? p.details : {}) || {};
        var contract = [['Data and assets',details.data_assets],['Verifier repository',external(e.repository,'GitHub repository')],
          ['Metrics and score format',[details.metrics,details.score_format].filter(Boolean).join(' · ')],['Submission format',details.submission_format],
          ['Constraints',[details.constraints || details.compute,details.seeds,details.limitations].filter(Boolean).join(' · ')]];
        var checks = Object.keys(r.validation || {}).map(function(k){ return [k.replace(/_/g, ' '), r.validation[k]]; });
        if (v) checks = checks.concat([['Measured fitness', v.observed_fitness], ['Expected fitness', v.expected_fitness], ['Tolerance', v.tolerance], ['Expected-score basis', v.expected_basis],
          ['Reference SHA-256', v.reference_sha256], ['Artifact SHA-256', v.artifact_sha256], ['Report SHA-256', v.report_sha256], ['Controlled run', v.checked_by]]);
        if (ra) checks = checks.concat([['AutoKaggle reports approval', ra.approved_at], ['Its approval note', ra.note]]);
        var approve = !a && r.stage === 'validated'
          ? '<button class="btn-text" type="button" data-approve="' + esc(r.id) + '"' + (canApprove ? '' : ' disabled title="Only a PI or admin approves a release"') + '>Approve</button>' : '';
        return '<li id="release-' + esc(r.id) + '"><div class="talk-when">Registered ' + esc(when(r.createdAt)) + ' · ' + esc(STAGES[r.stage] || r.stage) + ', reported by AutoKaggle</div>' +
          '<div class="talk-title">' + esc(r.title) + ' · version ' + esc(String(e.version)) + '</div>' +
          '<div class="talk-when">' + (a ? 'Approved by ' + esc(a.name) + ', ' + esc(when(a.at)) + (a.note ? ': ' + esc(a.note) : '') : 'Not approved in BOLD.OS') + '</div>' +
          '<dl class="detail-grid">' + contract.map(function(f){return row(f[0],f[0]==='Verifier repository' ? f[1] : text(f[1]));}).join('') + '</dl>' +
          '<div class="talk-actions">' + external(e.repository + '/tree/' + e.commit, 'Pinned code') + external(e.zip_url, 'ZIP') + external(urls.autokaggleLiteUrl + '?project=' + encodeURIComponent(r.source_id.slice(11)), 'Lite session') + external(urls.autokaggleLiteUrl + '?project=' + encodeURIComponent(r.source_id.slice(11)) + '&review=handoff', 'Manage handoff access') + approve + '</div>' +
          '<details><summary class="detail-muted">Checks and evidence</summary><dl class="detail-grid">' +
          [['Commit', e.commit], ['Contract SHA-256', e.contract_sha256], ['Run command', details.run_command], ['Dependencies', details.dependencies]].concat(checks).map(function(x){ return row(x[0], text(x[1] == null ? '' : x[1])); }).join('') +
          '</dl></details></li>';
      }).join('') + '</ul>';
    },
    history: function(){
      if (!history.length) return '<p class="detail-muted">No changes yet.</p>';
      return '<ul class="talk-list">' + history.map(function(h){
        return '<li><div class="talk-when">' + esc(new Date(h.updatedAt).toLocaleString()) + '</div><div class="talk-title">' + esc(h.changeNote || 'Changed') + '</div>' + (h.notes ? '<p>' + text(h.notes) + '</p>' : '') +
          '<div class="talk-when">' + esc([STAGES[h.stage], h.project_title, h.latest_commit ? h.latest_commit.slice(0, 12) : ''].filter(Boolean).join(' · ')) + '</div></li>';
      }).join('') + '</ul>';
    }
  };

  function render(){
    var paperReason = BoldProblemPapers.unavailableReason(p.papers);
    if (tab === 'papers' && paperReason) {
      if (Array.isArray(p.papers) && !BOLD.myGroup()) return; // Wait for this viewer's access.
      tab = 'overview'; history_replace('');
      if (!familyGraph && !familyError) return loadFamily();
    }
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
    var links=p.projects;
    html += '<ol class="pb-steps" aria-label="Problem onboarding"><li>Problem defined</li><li>';
    if(links.length) html += '<label for="verifierProject">Project (optional)</label> <select id="verifierProject"><option value="">No project</option>' +
      links.map(function(x,i){return '<option value="'+i+'">'+esc(x.title)+'</option>';}).join('')+'</select> ';
    var blocked = p.archived ? 'Restore this problem first.' : !BOLD.can('projects','edit') ? BOLD.cannotReason('projects','edit') : '';
    html += '<button type="button" class="btn-primary btn-box" id="addVerifier"' + (blocked ? ' disabled title="'+esc(blocked)+'"' : '')+'>' + (p.evaluator?'Add another verifier':'Add verifier') + '</button>';
    html += '</li><li>Autoresearch baseline <small>Coming soon</small></li></ol>';
    if (canRemind && !p.archived && !p.evaluator) html += '<p><button type="button" class="btn-text" id="toggleReminder">' +
      (p.reminders ? 'Turn off my weekly reminders' : 'Remind me to add a verifier') + '</button></p>';
    html += '<div class="tabs" role="tablist" aria-label="Problem">' + TABS.map(function(t){
      var on = t[0] === tab;
      var disabled = t[0] === 'papers' && paperReason;
      var count = t[0] === 'papers' && !disabled ? p.papers.length : t[0] === 'releases' ? releases.length : 0;
      return '<button class="tab' + (on ? ' active' : '') + '" type="button" role="tab" id="tab-' + t[0] + '" data-tab="' + t[0] + '" aria-controls="problemPanel" aria-selected="' + on + '"' + (on ? '' : ' tabindex="-1"') + (disabled ? ' disabled title="' + esc(paperReason) + '"' : '') + '>' +
        t[1] + (count ? '<span class="proj-count"> ' + count + '</span>' : '') + '</button>';
    }).join('') + '</div>';
    html += '<div class="tab-panel" id="problemPanel" role="tabpanel" aria-labelledby="tab-' + tab + '">' + PANELS[tab]() + '</div>';
    el('problemBody').innerHTML = html; el('problemBody').hidden = false; el('detailMsg').hidden = true;
    document.title = p.title + ' | BOLD Lab';
    wire();
    if (initialRelease && tab === 'releases') {
      var releaseId = 'release-' + initialRelease;
      initialRelease = null;
      requestAnimationFrame(function(){ var item = el(releaseId); if (item) item.scrollIntoView({block:'start'}); });
    }
  }

  function setTab(name, focus){
    if (name === tab) return;
    initialRelease = null;
    try { history_replace(name === 'overview' ? '' : '#tab=' + name); } catch (e){}
    BOLD.switchTab('.tabs', el('problemBody'), function(){
      tab = name; editing = false;
      if (name === 'overview' && !familyGraph && !familyError) loadFamily(); else render();
    });
    if (focus) document.querySelector('.tab.active').focus();
  }
  function history_replace(hash){ window.history.replaceState(null, '', location.pathname + location.search + hash); }

  /* ---------- editing one field at a time ---------- */
  function save(patch){
    return call({action:'update',problem_id:p.id,changes:patch}).then(load);
  }
  function failer(){ var e = el('detailEditError'); return function(msg){ if (e) { e.textContent = msg; e.hidden = false; } }; }

  function wireFamilyEditor(){
    var epoch = userEpoch, graph = familyGraph, editor = el('familyEditor'), saveButton = el('fieldSave');
    var selection = BoldProblemFamily.picker(editor, graph, id), previous = selection();
    editor.querySelector('summary').focus();
    saveButton.onclick = async function(){
      if (familySaving) return;
      familySaving = true; editor.disabled = true; saveButton.disabled = true; el('editCancel').disabled = true;
      var errorBox = el('detailEditError'); errorBox.hidden = true;
      try {
        await call({action:'set_family', problem_id:id, family:selection(), previous:previous});
      } catch (error) {
        if (epoch !== userEpoch) return;
        familySaving = false;
        if (!editor.isConnected) return;
        el('editCancel').disabled = false; editor.disabled = false;
        errorBox.hidden = false;
        if (/(^|\/)aborted$/.test(error.code || '')) {
          errorBox.textContent = 'The saved links changed while you were editing. ';
          var reload = document.createElement('button'); reload.type = 'button'; reload.className = 'btn-text';
          reload.textContent = 'Discard these edits and load the saved links';
          reload.onclick = function(){ editing = false; loadFamily(); }; errorBox.appendChild(reload);
        } else { saveButton.disabled = false; errorBox.textContent = error.message || 'Could not save family links. Try again.'; }
        return;
      }
      if (epoch !== userEpoch) return;
      familySaving = false;
      if (editing === 'family') editing = false;
      loadFamily();
      load().catch(function(){ if (epoch === userEpoch) alertLine(new Error('Family links saved. Reload the page to refresh the problem history.')); });
    };
  }

  function wire(){
    if (el('retryFamily')) el('retryFamily').onclick = loadFamily;
    Array.prototype.forEach.call(el('problemBody').querySelectorAll('.tab:not(:disabled)'), function(t, i, all){
      t.addEventListener('click', function(){ setTab(t.getAttribute('data-tab')); });
      t.addEventListener('keydown', function(e){
        var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (d) { e.preventDefault(); setTab(all[(i + d + all.length) % all.length].getAttribute('data-tab'), true); }
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-edit]'), function(btn){
      btn.addEventListener('click', function(){ if (canEdit() && !familySaving && !btn.disabled) { editing = btn.getAttribute('data-edit'); render(); } });
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
      var picker = el('verifierProject');
      var project = picker && picker.value !== '' ? p.projects[Number(picker.value)] : null;
      var url = verifierLink(project);
      if (!url) return alertLine(new Error('Check the AutoKaggle Lite address in Settings.'));
      var ok = await BOLD.confirmAction({ title: 'Open AutoKaggle Lite?', always: true, go: 'Open Lite',
        effects: ['Share the problem ID, title, and research question' + (project ? ', plus the selected project ID' : '') + ' with AutoKaggle Lite.'] });
      if (ok) location.assign(url);
    };
    if (!editing) return;
    var input = el('fieldInput'), fail = failer();
    el('editCancel').addEventListener('click', function(){ editing = false; render(); });
    if (editing === 'family') { wireFamilyEditor(); return; }
    if (editing === 'owner') BoldPeopleSelect.load().then(function(list){input.innerHTML=BoldPeopleSelect.options(list,p.owner_id,'Choose the problem definer');}).catch(function(e){fail(e.message);});
    if (input && input.focus) input.focus();
    el('fieldSave').addEventListener('click', function(){
      var v = input.value, patch = {};
      if (editing === 'projects') patch.projects=BoldProblemProjects.selected(input,projects);
      else if (editing === 'owner') { if (!v) return fail('Choose the problem definer.'); patch.owner_id=v; }
      else { if (!v.trim() && editing!=='collaborators') return fail('Enter a value.'); patch[editing]=v.trim(); }
      el('fieldSave').disabled = true;
      save(patch).then(function(){ editing = false; render(); }).catch(function(e){ el('fieldSave').disabled = false; fail((e && e.message) || 'Could not save — try again.'); });
    });
  }
  function alertLine(e){ el('detailMsg').hidden = false; el('detailMsg').textContent = (e && e.message) || 'Please try again.'; }

  /* ---------- loading ---------- */
  function load(){
    var epoch = userEpoch;
    return call({ action: 'get', problem_id: id }).then(function(data){
      if (epoch !== userEpoch) return;
      p = data.problem; releases = data.versions || []; history = data.history || []; canApprove = !!data.can_approve; canRemind = !!data.can_manage_reminders; busy = false;
      render();
    });
  }
  function loadFamily(){
    var request = ++familyRead;
    familyError = ''; familyGraph = null;
    if (p && !editing && tab === 'overview') render();
    return call({action:'family'}).then(function(graph){ if (request === familyRead) familyGraph = graph; })
      .catch(function(){ if (request === familyRead) familyError = 'unavailable'; })
      .then(function(){ if (request === familyRead && p && !editing && tab === 'overview') render(); });
  }
  function loadUrls(){
    return BOLDRegistryLinks.loadServiceUrls().then(function(config){ urls = config; }).catch(function(){});
  }
  BOLD.onAccess(function(){ if (p && !editing) render(); });
  BOLD.onUser(function(user){
    var epoch = ++userEpoch;
    familyRead++; familyGraph = null; familyError = ''; familySaving = false; p = null; editing = false;
    projects = []; projectsLoaded = false; el('problemBody').replaceChildren(); el('problemBody').hidden = true;
    el('detailMsg').hidden = false; el('detailMsg').textContent = user ? 'Loading…' : 'Sign in to view this problem.';
    if (!user) return;
    if (!/^ak-[a-f0-9]{24}$/.test(id)) { el('detailMsg').textContent = 'No such problem.'; return; }
    if (tab === 'overview') loadFamily();
    call({ action: 'projects' }).then(function(r){ if (epoch !== userEpoch) return; projects = r.items; projectsLoaded=true; if (p && !editing) render(); }).catch(function(){});
    loadUrls().then(function(){ if (epoch === userEpoch) return load(); }).catch(function(e){ if (epoch === userEpoch) el('detailMsg').textContent = 'Could not load this problem. ' + ((e && e.message) || ''); });
  });
})();
