// tools.html, the MCP server (2026-11-25): how to connect an agent (its address; tokens are made on the profile), then
// the tools agents use with BOLD.OS (functions/api-tools.js), laid out as Projects: List or Grid (kept in this browser),
// a search, and three tabs with their counts: those the lab added (agentTools/{name}, each with its page,
// tool.html?tool=<name>), the proposed new ones still waiting (agentTools/{name}/proposals, kind 'new', read with a
// collectionGroup query), and BOLD.OS's own, by name (boldApi's index), each saying whether it reads or acts.
(function(){
  var esc = BOLD.escapeHtml;
  var list = document.getElementById('toolList'), newList = document.getElementById('newList'), ownList = document.getElementById('ownList');
  var loading = document.getElementById('toolLoading'), search = document.getElementById('toolSearch'), views = document.getElementById('toolViews');
  if (!list || !BOLD.getAuth()) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var API = 'https://europe-west2-bold-d7ff2.cloudfunctions.net/boldApi';
  var addr = document.getElementById('mcpAddress');
  if (addr) addr.innerHTML = BOLD.copyBoxHtml(API + '/mcp');

  var lab = null, proposed = [], own = null, q = '';
  function day(t){ return t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
  // A row, as a project's (proj-main: title, meta, abstract).
  function rowHtml(href, title, meta, text){
    var t = href ? '<a class="proj-title" href="' + esc(href) + '">' + esc(title) + '</a>' : '<span class="proj-title">' + esc(title) + '</span>';
    return '<li><div class="proj-main">' + t + '<span class="proj-meta">' + meta.filter(Boolean).map(esc).join(' · ') + '</span>' +
      (text ? '<p class="proj-abstract">' + esc(text) + '</p>' : '') + '</div></li>';
  }
  function matches(x){ return !q || [x.title, x.name, x.description].join(' ').toLowerCase().indexOf(q) >= 0; }
  function none(text){ return '<li class="proj-none"><p class="proj-empty">' + esc(text) + '</p></li>'; }
  function render(){
    if (lab) {
      var a = lab.filter(matches);
      list.innerHTML = a.map(function(t){ return rowHtml('tool.html?tool=' + encodeURIComponent(t.name), t.title || t.name, [t.name, t.acting ? 'acts' : 'reads', t.updatedAt ? 'updated ' + day(t.updatedAt) : ''], t.description); }).join('') ||
        none(q ? 'No tool matches.' : 'None yet: propose one.');
      document.getElementById('cntLab').textContent = String(a.length);
    }
    var b = proposed.filter(matches);
    newList.innerHTML = b.map(function(t){ return rowHtml('tool.html?tool=' + encodeURIComponent(t.name) + '#proposals', t.title, [t.name, 'proposed by ' + t.by, day(t.at)], t.description); }).join('') ||
      none(q ? 'No proposed tool matches.' : 'No new tools proposed.');
    document.getElementById('cntProposed').textContent = proposed.length ? String(b.length) : '';
    if (own) {
      var c = own.filter(matches);
      ownList.innerHTML = c.map(function(t){ return rowHtml('', t.name, [t.acting ? 'acts, once a PI or admin approves the token' : 'reads']); }).join('') || none('No tool matches.');
      document.getElementById('cntOwn').textContent = String(c.length);
    }
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

  // Three tabs; #proposed and #own open theirs.
  var PANELS = { lab: list, proposed: newList, own: ownList };
  function showTab(want){
    want = want || (location.hash === '#proposed' ? 'proposed' : location.hash === '#own' ? 'own' : 'lab');
    Array.prototype.forEach.call(document.querySelectorAll('.tabs .tab'), function(t){
      var on = t.getAttribute('data-tab') === want;
      t.classList.toggle('active', on); t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1;
    });
    Object.keys(PANELS).forEach(function(k){ PANELS[k].hidden = k !== want; });
  }
  Array.prototype.forEach.call(document.querySelectorAll('.tabs .tab'), function(t){
    t.addEventListener('click', function(){
      var want = t.getAttribute('data-tab');
      history.replaceState(null, '', want === 'lab' ? location.pathname + location.search : '#' + want);
      showTab(want);
    });
  });
  window.addEventListener('hashchange', function(){ showTab(); });
  showTab();

  BOLD.onUser(function(user){
    if (!user) return;
    db.collection('agentTools').get().then(function(snap){
      lab = snap.docs.map(function(d){ return Object.assign({ name: d.id }, d.data()); }).sort(function(a, b){ return (a.title || a.name).localeCompare(b.title || b.name); });
      loading.hidden = true; render();
    }).catch(function(err){ console.error('[BOLD Tools] loading failed', err); loading.textContent = 'Couldn’t load the tools. Try reloading the page.'; });
    // Proposed new tools: their page shows the proposal until it's decided.
    // Unfiltered (a filter across collections needs its own index): there are few.
    db.collectionGroup('proposals').get().then(function(snap){
      proposed = snap.docs.filter(function(d){ var x = d.data(); return d.ref.parent.parent && d.ref.parent.parent.parent.id === 'agentTools' && x.kind === 'new' && x.status === 'open'; })
        .map(function(d){ var x = d.data(), name = d.ref.parent.parent.id; return { name: name, title: (x.after && x.after.title) || name, description: x.note || '', by: (x.by && x.by.name) || 'someone', at: x.at }; });
      render();
    }).catch(function(err){ console.error('[BOLD Tools] loading proposals failed', err); });
    fetch(API + '/').then(function(r){ return r.json(); }).then(function(d){
      var name = function(s){ return s.replace(/^(GET|POST) \/v1\//, ''); };
      own = (d.read || []).map(function(s){ return { name: name(s), acting: false }; }).concat((d.act || []).map(function(s){ return { name: name(s), acting: true }; }));
      render();
    }).catch(function(){ ownList.innerHTML = none('Couldn’t load them.'); });
  });
})();
