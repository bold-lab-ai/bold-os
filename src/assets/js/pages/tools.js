// tools.html, the MCP server (2026-11-25): how to connect an agent (its address; tokens are made on the profile), then
// every tool agents use with BOLD.OS, in one list laid out as Projects: List or Grid (kept in this browser), a search,
// and two tabs with their counts. Tools: BOLD.OS's own (boldApi's index, with what each does; marked built in, linked to
// their code in the repo, as they change there) and those the lab added (agentTools/{name}, each with its page,
// tool.html?tool=<name>, changed by proposals). Proposed: the new ones still waiting (agentTools/{name}/proposals, kind
// 'new', read with a collectionGroup query). #proposed opens that tab.
(function(){
  var esc = BOLD.escapeHtml;
  var list = document.getElementById('toolList'), newList = document.getElementById('newList');
  var loading = document.getElementById('toolLoading'), search = document.getElementById('toolSearch'), views = document.getElementById('toolViews');
  if (!list || !BOLD.getAuth()) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var API = 'https://europe-west2-bold-d7ff2.cloudfunctions.net/boldApi';
  var CODE = 'https://github.com/bold-lab-ai/bold-os/blob/main/functions/api.js';
  var addr = document.getElementById('mcpAddress');
  if (addr) addr.innerHTML = BOLD.copyBoxHtml(API + '/mcp');

  var lab = null, own = null, proposed = [], q = '';
  function day(t){ return t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
  // A row, as a project's (proj-main: title, meta, abstract).
  function rowHtml(x){
    var out = x.href.indexOf('http') === 0 ? ' target="_blank" rel="noopener"' : '';
    return '<li><div class="proj-main"><a class="proj-title" href="' + esc(x.href) + '"' + out + '>' + esc(x.title) + '</a>' +
      (x.builtIn ? '<span class="tool-builtin" title="Part of BOLD.OS’s code: it changes in the repo, not by a proposal">Built in</span>' : '') +
      '<span class="proj-meta">' + x.meta.filter(Boolean).map(esc).join(' · ') + '</span>' +
      (x.text ? '<p class="proj-abstract">' + esc(x.text) + '</p>' : '') + '</div></li>';
  }
  function matches(x){ return !q || [x.title, x.name, x.text].join(' ').toLowerCase().indexOf(q) >= 0; }
  function none(text){ return '<li class="proj-none"><p class="proj-empty">' + esc(text) + '</p></li>'; }
  function tools(){
    var a = (own || []).map(function(t){ return { name: t.name, title: t.name, builtIn: true, href: CODE, meta: [t.acting ? 'acts, once a PI or admin approves the token' : 'reads'], text: t.description }; });
    var b = (lab || []).map(function(t){ return { name: t.name, title: t.title || t.name, href: 'tool.html?tool=' + encodeURIComponent(t.name), meta: [t.name, t.acting ? 'acts' : 'reads', t.updatedAt ? 'updated ' + day(t.updatedAt) : ''], text: t.description }; });
    return a.concat(b).sort(function(x, y){ return x.title.localeCompare(y.title); });
  }
  function render(){
    if (lab || own) {
      var all = tools(), a = all.filter(matches);
      list.innerHTML = a.map(rowHtml).join('') || none(q ? 'No tool matches.' : 'No tools yet.');
      document.getElementById('cntTools').textContent = String(a.length);
    }
    var b = proposed.filter(matches);
    newList.innerHTML = b.map(rowHtml).join('') || none(q ? 'No proposed tool matches.' : 'No new tools proposed.');
    document.getElementById('cntProposed').textContent = proposed.length ? String(b.length) : '';
  }
  search.addEventListener('input', function(){ q = search.value.trim().toLowerCase(); render(); });

  // List or Grid, kept in this browser.
  var VIEW_KEY = 'boldTools:view';
  function setView(v){
    views.setAttribute('data-view', v);
    Array.prototype.forEach.call(document.querySelectorAll('.view-btn[data-view]'), function(b){ b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === v)); });
    try { localStorage.setItem(VIEW_KEY, v); } catch (e){}
  }
  Array.prototype.forEach.call(document.querySelectorAll('.view-btn[data-view]'), function(b){ b.addEventListener('click', function(){ setView(b.getAttribute('data-view')); }); });
  try { if (localStorage.getItem(VIEW_KEY) === 'grid') setView('grid'); } catch (e){}

  // Two tabs; #proposed opens the second.
  function showTab(want){
    want = want || (location.hash === '#proposed' ? 'proposed' : 'tools');
    Array.prototype.forEach.call(document.querySelectorAll('.tabs .tab'), function(t){
      var on = t.getAttribute('data-tab') === want;
      t.classList.toggle('active', on); t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1;
    });
    list.hidden = want !== 'tools'; newList.hidden = want !== 'proposed';
  }
  Array.prototype.forEach.call(document.querySelectorAll('.tabs .tab'), function(t){
    t.addEventListener('click', function(){
      var want = t.getAttribute('data-tab');
      history.replaceState(null, '', want === 'proposed' ? '#proposed' : location.pathname + location.search);
      showTab(want);
    });
  });
  window.addEventListener('hashchange', function(){ showTab(); });
  showTab();

  BOLD.onUser(function(user){
    if (!user) return;
    db.collection('agentTools').get().then(function(snap){
      lab = snap.docs.map(function(d){ return Object.assign({ name: d.id }, d.data()); });
      loading.hidden = true; render();
    }).catch(function(err){ console.error('[BOLD Tools] loading failed', err); lab = []; loading.textContent = 'Couldn’t load the lab’s tools. Try reloading the page.'; render(); });
    // Proposed new tools: their page shows the proposal until it's decided.
    // Unfiltered (a filter across collections needs its own index): there are few.
    db.collectionGroup('proposals').get().then(function(snap){
      proposed = snap.docs.filter(function(d){ var x = d.data(); return d.ref.parent.parent && d.ref.parent.parent.parent.id === 'agentTools' && x.kind === 'new' && x.status === 'open'; })
        .map(function(d){
          var x = d.data(), name = d.ref.parent.parent.id;
          return { name: name, title: (x.after && x.after.title) || name, href: 'tool.html?tool=' + encodeURIComponent(name) + '#proposals', meta: [name, 'proposed by ' + ((x.by && x.by.name) || 'someone'), day(x.at)], text: x.note || '' };
        });
      render();
    }).catch(function(err){ console.error('[BOLD Tools] loading proposals failed', err); });
    // BOLD.OS's own, with what each does (boldApi's index; before it listed them, only their names).
    fetch(API + '/').then(function(r){ return r.json(); }).then(function(d){
      var name = function(s){ return s.replace(/^(GET|POST) \/v1\//, ''); };
      own = Array.isArray(d.tools) ? d.tools
        : (d.read || []).map(function(s){ return { name: name(s), acting: false }; }).concat((d.act || []).map(function(s){ return { name: name(s), acting: true }; }));
      render();
    }).catch(function(err){ console.error('[BOLD Tools] loading BOLD.OS’s own failed', err); own = []; render(); });
  });
})();
