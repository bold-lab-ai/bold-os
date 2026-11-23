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
  var params = new URLSearchParams(location.search);
  var initialObjective = params.get('objective');
  var focusId = params.get('focus') || initialObjective, revealArchive = !!focusId;
  var family = null, archived = false, diagram = null, drawnFamily = null;
  var tree = BoldProblemTree.mount(call, initialObjective, familyChanged);
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
    var paperTerms = BoldProblemPapers.unavailableReason(p.papers) ? '' : p.papers.map(function(paper){ return paper.title + ' ' + paper.venue; }).join(' ');
    var hay = [p.title, p.objective, p.significance, p.difficulties, p.existing_solutions, (p.details || {}).collaborators, (p.projects || []).map(function(x){return x.title;}).join(' '), paperTerms, p.task_kind, p.project_title, (p.details || {}).owner, (p.evaluator || {}).commit].join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).every(function(w){ return hay.indexOf(w) >= 0; });
  }
  function row(p, expanded){
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
      (!BoldProblemPapers.unavailableReason(p.papers) && p.papers.length ? '<details class="pb-papers" data-problem="' + esc(p.id) + '"' + (expanded.has(p.id) ? ' open' : '') + '><summary>Papers (' + p.papers.length + ')</summary>' +
        BoldProblemPapers.list(p.papers) + '</details>' : '') +
      (badges(p) ? '<div class="proj-badges">' + badges(p) + '</div>' : '') +
      (missing && !p.archived ? '<a class="pb-add-verifier" href="' + path + '#tab=releases">Add verifier →</a>' : '') + '</div></li>';
  }
  function familyView(name){return name === 'tree' || name === 'graph';}
  function renderList(){
    var groups = { open: [], implemented: [], checked: [], validated: [], archived: [] };
    var expanded = new Set(Array.from(el('problems').querySelectorAll('.pb-papers[open]'), function(item){ return item.dataset.problem; }));
    rows.filter(matches).forEach(function(p){ groups[tabOf(p)].push(p); });
    Object.keys(groups).forEach(function(k){
      var cap = k.charAt(0).toUpperCase() + k.slice(1);
      el('pb' + cap).innerHTML = groups[k].length ? groups[k].map(function(p){ return row(p,expanded); }).join('') : '<li class="proj-none"><p class="proj-empty">' + (q ? 'No problems match.' : 'No problems in this stage.') + '</p></li>';
      el('cnt' + cap).textContent = groups[k].length || (q ? '0' : '');
    });
    if (familyView(view)) return;
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
      if (!familyView(view)) { el('pbMsg').hidden = false; el('pbMsg').textContent = listError; }
    }).then(function(){ if (epoch === generation) { listPending = false; el('pbMore').disabled = false; } });
  }

  function graphUrl(url){
    url.searchParams.set('view', 'graph');
    url.searchParams.delete('objective');
    if (focusId) url.searchParams.set('focus', focusId); else url.searchParams.delete('focus');
    url.hash = '';
  }
  function selectGraphNode(id){
    focusId = id; revealArchive = false;
    el('pbGraphNotice').hidden = true;
    var url = new URL(location.href);
    graphUrl(url); history.replaceState(null, '', url.href);
    el('pbSearch').value = ''; q = ''; el('pbClear').hidden = true;
    diagram.search(''); diagram.setFocus(id);
  }
  function showGraph(){
    var host = el('pbGraph');
    var notice = el('pbGraphNotice');
    host.hidden = view !== 'graph' || !family;
    if (host.hidden) { notice.hidden = true; return; }
    if (!diagram) diagram = BoldResearchGraph.mount(host, {onFocus:selectGraphNode});
    if (focusId) {
      var target = family.problems.find(function(n){return n.id === focusId;}) || family.objectives.find(function(n){return n.id === focusId;});
      if (target && target.archived && !archived && revealArchive) {
        revealArchive = false; tree.includeArchived(); return;
      }
      revealArchive = false;
      if (!target || (target.archived && !archived)) {
        focusId = null;
        var url = new URL(location.href); graphUrl(url); history.replaceState(null, '', url.href);
        notice.textContent = target ? 'The selected item is archived. Showing active connections.' : 'This item could not be found. Showing the graph overview.';
        notice.hidden = false;
      }
    }
    if (drawnFamily !== family) { diagram.setData(family); drawnFamily = family; }
    diagram.setArchived(archived); diagram.setFocus(focusId); diagram.search(q);
    if (diagram.resize) diagram.resize();
  }
  function familyChanged(data, includeArchived){
    family = data; archived = includeArchived;
    if (!data) { drawnFamily = null; if (diagram) diagram.reset(); }
    showGraph();
  }
  function setView(selected){
    view = familyView(selected) || selected === 'grid' ? selected : 'list';
    var byObjective = familyView(view);
    el('pbStageTabs').hidden = byObjective;
    el('pbTree').hidden = !byObjective;
    el('pbTreeBranches').hidden = view !== 'tree';
    showGraph();
    var searchLabel = byObjective ? 'Search objectives and problems' : 'Search problems';
    el('pbSearch').placeholder = searchLabel; el('pbSearch').setAttribute('aria-label', searchLabel);
    el('problems').setAttribute('data-view', view);
    Array.prototype.forEach.call(document.querySelectorAll('.view-btn'), function(b){ b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === view)); });
    el('problems').hidden = byObjective || !loaded;
    el('pbMsg').hidden = byObjective || (loaded && !listError);
    el('pbMsg').textContent = listError || (signedIn ? 'Loading…' : 'Sign in to see the Problem Bank.');
    if (byObjective) {
      if (view === 'tree') tree.search(q);
      if (signedIn) tree.load();
    } else if (loaded) renderList();
    else if (signedIn && !listPending) loadList(false);
    try { localStorage.setItem(VIEW_KEY, view); } catch (e){}
  }
  Array.prototype.forEach.call(document.querySelectorAll('.view-btn'), function(b){ b.addEventListener('click', function(){
    var next = b.getAttribute('data-view'), url = new URL(location.href);
    if (next === 'graph') graphUrl(url);
    else {
      url.searchParams.delete('view'); url.searchParams.delete('focus');
      if (next !== 'tree') url.searchParams.delete('objective'); else url.hash = '';
    }
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
  if (params.get('view') === 'graph') setView('graph');
  else if (initialObjective) setView('tree');
  else setView(stageRequested && familyView(savedView) ? 'list' : savedView);

  function search(){
    q = el('pbSearch').value.trim();
    el('pbClear').hidden = !q;
    if (view === 'graph') { if (diagram) diagram.search(q); }
    else if (view === 'tree') tree.search(q);
    else if (loaded) renderList();
  }
  el('pbSearch').addEventListener('input', search);
  el('pbClear').addEventListener('click', function(){ el('pbSearch').value = ''; search(); el('pbSearch').focus(); });
  el('pbMore').addEventListener('click', function(){ loadList(true); });

  /* ---------- start ---------- */
  BOLD.onUser(function(user){
    generation++; signedIn = !!user; loaded = false; listPending = false; rows = []; cursor = null; listError = '';
    el('problems').querySelectorAll('.proj-list').forEach(function(list){ list.replaceChildren(); });
    revealArchive = !!focusId;
    tree.reset();
    setView(view);
  });
  BOLD.onAccess(function(){
    var button = el('pbAdd'), allowed = BOLD.can('projects', 'edit');
    if (allowed) button.href = 'problem-new.html'; else button.removeAttribute('href');
    button.setAttribute('aria-disabled', String(!allowed)); button.title = allowed ? '' : BOLD.cannotReason('projects', 'edit');
    if (loaded) renderList();
  });
})();
