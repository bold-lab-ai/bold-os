// The Problem Bank (problems.html) can be browsed by stage or by research objective.
// Each problem has its own page (problem.html, pages/problem.js). Read through the
// benchmarkRegistry callable (functions/benchmark-registry.js).
(function(){
  'use strict';
  if (!document.getElementById('pbList') || !BOLD.getAuth()) return;
  var esc = BOLD.escapeHtml;
  var el = function(id){ return document.getElementById(id); };
  var call = function(data){ return firebase.app().functions('europe-west2').httpsCallable('benchmarkRegistry')(data).then(function(r){ return r.data; }); };
  var VIEW_KEY = 'boldProblems:view';
  var initialObjective = new URLSearchParams(location.search).get('objective');
  var tree = BoldProblemTree.mount(call, initialObjective);
  var view = 'list', signedIn = false, listPending = false, listError = '';

  // A stage is AutoKaggle's report; an open problem has no evaluator yet.
  var STAGES = { open: 'Open problem', implemented: 'Implemented', checked: 'Checked', validated: 'Validated' };
  var rows = [], cursor = null, q = '', loaded = false, generation = 0;

  function tabOf(p){ return p.archived ? 'archived' : (STAGES[p.stage] ? p.stage : 'open'); }
  function badges(p){
    var out = [];
    if (p.stage && p.stage !== 'open') out.push('<span class="badge badge-stage">' + esc(STAGES[p.stage] || p.stage) + '</span>');
    if (p.approval) out.push('<span class="badge badge-approved">Approved</span>');
    if (p.archived) out.push('<span class="badge">Archived</span>');
    return out.join('');
  }

  /* ---------- the list ---------- */
  function matches(p){
    if (!q) return true;
    var hay = [p.title, p.objective, p.significance, p.difficulties, p.existing_solutions, (p.details || {}).collaborators, (p.projects || []).map(function(x){return x.title;}).join(' '), p.task_kind, p.project_title, (p.details || {}).owner, (p.evaluator || {}).commit].join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).every(function(w){ return hay.indexOf(w) >= 0; });
  }
  function row(p){
    var links = BoldProblemProjects.links(p.projects || []), meta = links ? [links] : [];
    if ((p.details || {}).owner) meta.push(esc(p.details.owner));
    if (p.task_kind) meta.push(esc(p.task_kind));
    if (p.evaluator) meta.push('Latest verifier v' + esc(String(p.evaluator.version)));
    var path = 'problem.html?problem=' + encodeURIComponent(p.id);
    var missing = !p.evaluator;
    return '<li><div class="proj-main"><div class="pb-card-head">' +
      '<a class="proj-title" href="problem.html?problem=' + encodeURIComponent(p.id) + '">' + esc(p.title) + '</a>' +
      (missing ? '<span class="badge pb-missing">No verifier</span>' : '') + '</div>' +
      '<span class="proj-meta">' + meta.join(' · ') + '</span>' +
      (p.objective ? '<p class="proj-abstract">' + esc(p.objective) + '</p>' : '') +
      (badges(p) ? '<div class="proj-badges">' + badges(p) + '</div>' : '') +
      (missing && !p.archived ? '<a class="pb-add-verifier" href="' + path + '#tab=releases">Add verifier →</a>' : '') + '</div></li>';
  }
  function renderList(){
    if (view === 'tree') return;
    var groups = { open: [], implemented: [], checked: [], validated: [], archived: [] };
    rows.filter(matches).forEach(function(p){ groups[tabOf(p)].push(p); });
    Object.keys(groups).forEach(function(k){
      var cap = k.charAt(0).toUpperCase() + k.slice(1);
      el('pb' + cap).innerHTML = groups[k].length ? groups[k].map(row).join('') : '<li class="proj-none"><p class="proj-empty">' + (q ? 'No problems match.' : 'No problems in this stage.') + '</p></li>';
      el('cnt' + cap).textContent = groups[k].length || (q ? '0' : '');
    });
    el('pbClear').hidden = !q;
    el('pbMore').hidden = !cursor;
    el('pbMsg').hidden = true; el('problems').hidden = false;
  }
  function loadList(more){
    var epoch = generation;
    listPending = true; listError = ''; el('pbMore').disabled = true;
    return call({ action: 'list', cursor: more ? cursor : null }).then(function(r){
      if (epoch !== generation) return;
      rows = more ? rows.concat(r.items) : r.items; cursor = r.cursor; loaded = true;
      renderList();
    }).catch(function(e){
      if (epoch !== generation) return;
      listError = 'Could not load the Problem Bank. ' + (e.message || '');
      if (view !== 'tree') { el('pbMsg').hidden = false; el('pbMsg').textContent = listError; }
    }).then(function(){ if (epoch === generation) { listPending = false; el('pbMore').disabled = false; } });
  }

  function setView(selected){
    view = selected === 'tree' || selected === 'grid' ? selected : 'list';
    var byObjective = view === 'tree';
    el('pbStageTabs').hidden = byObjective;
    el('pbTree').hidden = !byObjective;
    var searchLabel = byObjective ? 'Search objectives and problems' : 'Search problems';
    el('pbSearch').placeholder = searchLabel; el('pbSearch').setAttribute('aria-label', searchLabel);
    el('problems').setAttribute('data-view', view);
    Array.prototype.forEach.call(document.querySelectorAll('.view-btn'), function(b){ b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === view)); });
    el('problems').hidden = byObjective || !loaded;
    el('pbMsg').hidden = byObjective || (loaded && !listError);
    el('pbMsg').textContent = listError || (signedIn ? 'Loading…' : 'Sign in to see the Problem Bank.');
    if (byObjective) {
      tree.search(q);
      if (signedIn) tree.load();
    } else if (loaded) renderList();
    else if (signedIn && !listPending) loadList(false);
    try { localStorage.setItem(VIEW_KEY, view); } catch (e){}
  }
  Array.prototype.forEach.call(document.querySelectorAll('.view-btn'), function(b){ b.addEventListener('click', function(){
    var next = b.getAttribute('data-view'), url = new URL(location.href);
    if (next !== 'tree') url.searchParams.delete('objective'); else url.hash = '';
    history.replaceState(null, '', url.href); setView(next);
  }); });

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
  var stageRequested = tabs.some(function(t){ return t.getAttribute('data-tab') === hashTab; });
  if (stageRequested) setTab(hashTab);
  var savedView;
  try { savedView = localStorage.getItem(VIEW_KEY); } catch (e){}
  setView(initialObjective ? 'tree' : stageRequested && savedView === 'tree' ? 'list' : savedView);

  function search(){
    q = el('pbSearch').value.trim();
    el('pbClear').hidden = !q;
    if (view === 'tree') tree.search(q); else if (loaded) renderList();
  }
  el('pbSearch').addEventListener('input', search);
  el('pbClear').addEventListener('click', function(){ el('pbSearch').value = ''; search(); el('pbSearch').focus(); });
  el('pbMore').addEventListener('click', function(){ loadList(true); });

  /* ---------- start ---------- */
  BOLD.onUser(function(user){
    generation++; signedIn = !!user; loaded = false; listPending = false; rows = []; cursor = null; listError = '';
    tree.reset();
    setView(view);
  });
  BOLD.onAccess(function(){
    var button = el('pbAdd'), allowed = BOLD.can('projects', 'edit');
    if (allowed) button.href = 'problem-new.html'; else button.removeAttribute('href');
    button.setAttribute('aria-disabled', String(!allowed)); button.title = allowed ? '' : BOLD.cannotReason('projects', 'edit');
  });
})();
