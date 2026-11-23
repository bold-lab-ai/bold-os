// The Problem Bank (problems.html), laid out as Projects: List or Grid, tabs by stage, search.
// Each problem has its own page (problem.html, pages/problem.js). Read through the
// benchmarkRegistry callable (functions/benchmark-registry.js).
(function(){
  'use strict';
  if (!document.getElementById('pbList') || !BOLD.getAuth()) return;
  var esc = BOLD.escapeHtml;
  var el = function(id){ return document.getElementById(id); };
  var call = function(data){ return firebase.app().functions('europe-west2').httpsCallable('benchmarkRegistry')(data).then(function(r){ return r.data; }); };
  var VIEW_KEY = 'boldProblems:view';

  // A stage is AutoKaggle's report; an open problem has no evaluator yet.
  var STAGES = { open: 'Open problem', implemented: 'Implemented', checked: 'Checked', validated: 'Validated' };
  var rows = [], cursor = null, q = '', loaded = false, generation = 0;

  function projectHref(p){ return 'project.html#id=' + encodeURIComponent(p.project_id) + (p.project_board ? '&board=' + encodeURIComponent(p.project_board) : ''); }
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
    var hay = [p.title, p.objective, p.significance, p.existing_solutions, p.task_kind, p.project_title, (p.details || {}).owner, (p.evaluator || {}).commit].join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).every(function(w){ return hay.indexOf(w) >= 0; });
  }
  function row(p){
    var meta = ['<a href="' + esc(projectHref(p)) + '">' + esc(p.project_title || p.project_id) + '</a>'];
    if ((p.details || {}).owner) meta.push(esc(p.details.owner));
    if (p.task_kind) meta.push(esc(p.task_kind));
    if (p.evaluator) meta.push('Evaluator v' + esc(String(p.evaluator.version)));
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

  /* ---------- start ---------- */
  BOLD.onUser(function(user){
    generation++;
    if (!user) { el('pbMsg').textContent = 'Sign in to see the Problem Bank.'; return; }
    BOLD.onAccess(function(){
      var button = el('pbAdd'), allowed = BOLD.can('projects', 'edit');
      if (allowed) button.href = 'problem-new.html'; else button.removeAttribute('href');
      button.setAttribute('aria-disabled', String(!allowed)); button.title = allowed ? '' : BOLD.cannotReason('projects', 'edit');
    });
    // The project picker: one row per project, as Projects lists them.
    loadList(false);
  });
})();
