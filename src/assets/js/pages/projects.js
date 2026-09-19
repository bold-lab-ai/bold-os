(function(){
  // The masthead, gate and sidebar are bold.js's; this page only fills in the projects.
  if (!BOLD.getAuth()) return;

  var el = function(id){ return document.getElementById(id); };

  // Same per-person localStorage cache as the profile page (getAllProjects is
  // lab-wide, but keyed by person so sign-out clears it the same way).
  var CACHE_TTL_MS = 15 * 60 * 1000;
  var CACHE_PREFIX = 'boldProjects:';
  var VIEW_KEY = 'boldProjects:view';

  function cacheGet(key){
    try { return JSON.parse(localStorage.getItem(CACHE_PREFIX + key) || 'null'); } catch (e) { return null; }
  }
  function cachePut(key, data){
    try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), d: data })); } catch (e){}
  }
  function cacheClear(){
    try {
      Object.keys(localStorage).forEach(function(k){ if (k.indexOf(CACHE_PREFIX) === 0 && k !== VIEW_KEY) localStorage.removeItem(k); });
    } catch (e){}
  }

  // Renders from cache if any, then calls the function only if there's no
  // fresh cache. onError only fires when there was nothing cached to show.
  function loadCached(fn, email, render, onError, usable){
    var key = fn + ':' + email.toLowerCase();
    var hit = cacheGet(key);
    var age = hit ? Math.round((Date.now() - hit.t) / 1000) : 0;
    if (hit) render(hit.d);
    if (hit && Date.now() - hit.t < CACHE_TTL_MS && (!usable || usable(hit.d))) { console.info('[BOLD Lab] ' + fn + ': cache hit (' + age + 's old), no call'); return; }
    var t0 = performance.now();
    var call;
    try { call = firebase.app().functions('europe-west2').httpsCallable(fn); }
    catch (e) { if (!hit) onError(e); return; }
    call().then(function(res){
      var data = res.data || {};
      console.info('[BOLD Lab] ' + fn + ': fetched in ' + Math.round(performance.now() - t0) + 'ms (' + (hit ? 'stale cache shown ' + age + 's old' : 'no cache') + ')');
      cachePut(key, data);
      render(data);
    }).catch(function(err){
      console.error('[BOLD Lab] ' + fn + ' failed', err);
      if (!hit) onError(err);
    });
  }

  // Same row as the profile page's project list.
  function renderProject(p){
    var li = document.createElement('li');
    var main = document.createElement('div');
    main.className = 'proj-main';
    // Every project opens its own page, wherever it lives (with a venue: its card there).
    var a = document.createElement('a');
    a.className = 'proj-title';
    a.href = 'project.html#id=' + encodeURIComponent(p.projectId || p.cardId) + (p.boardId ? '&board=' + encodeURIComponent(p.boardId) : '');
    a.textContent = p.title;
    var meta = document.createElement('span');
    meta.className = 'proj-meta';
    // In: <venue> (linked to its board) · <Slack channel> (linked, when it can be) · <owner>
    var parts = [];
    var textNode = function(t){ return document.createTextNode(t); };
    var linkNode = function(t, href){
      var l = document.createElement('a'); l.href = href; l.textContent = t;
      if (href.indexOf('http') === 0) { l.target = '_blank'; l.rel = 'noopener'; }
      return l;
    };
    if (p.boardId) {
      var inVenue = document.createElement('span');
      inVenue.appendChild(textNode('In: '));
      inVenue.appendChild(linkNode(p.boardLabel, 'audit-board.html#board=' + encodeURIComponent(p.boardId)));
      parts.push(inVenue);
    } else {
      parts.push(textNode('No venue yet'));
    }
    if (p.slackChannel) parts.push(p.slackUrl ? linkNode(p.slackChannel, p.slackUrl) : textNode(p.slackChannel));
    if (p.owner) parts.push(textNode(p.owner));
    parts.forEach(function(n, i){
      if (i) meta.appendChild(textNode(' \u00b7 '));
      meta.appendChild(n);
    });
    main.appendChild(a); main.appendChild(meta);
    if (p.abstract) {
      var abs = document.createElement('p');
      abs.className = 'proj-abstract';
      abs.textContent = p.abstract;
      main.appendChild(abs);
    }
    if (p.keywords && p.keywords.length) {
      var kws = document.createElement('div');
      kws.className = 'proj-keywords';
      p.keywords.forEach(function(k){
        // Click to show only the projects with this keyword; click again to clear.
        var t = document.createElement('button');
        t.type = 'button'; t.className = 'kw-tag' + (filters.keyword === k ? ' active' : ''); t.textContent = k;
        t.setAttribute('aria-pressed', String(filters.keyword === k));
        t.addEventListener('click', function(){ setFilter('keyword', filters.keyword === k ? '' : k); });
        kws.appendChild(t);
      });
      main.appendChild(kws);
    }
    if (p.badges && p.badges.length) {
      var row = document.createElement('div');
      row.className = 'proj-badges';
      p.badges.forEach(function(b){
        var span = document.createElement('span');
        span.className = 'badge badge-' + String(b.kind).replace(/[^a-z_-]/g, '');
        span.textContent = b.label;
        row.appendChild(span);
      });
      main.appendChild(row);
    }
    li.appendChild(main);
    // Adds the signed-in user to the project's Slack channel (joinProjectChannel).
    var join = document.createElement('button');
    join.type = 'button';
    join.className = 'join-btn';
    join.textContent = 'Join the project';
    var wrap = document.createElement('div');
    wrap.className = 'join-wrap';
    wrap.appendChild(join);
    if (!p.slackChannel) {
      join.disabled = true;
      join.title = 'This project has no Slack channel yet';
    } else {
      var msg = document.createElement('span');
      msg.className = 'join-msg';
      msg.setAttribute('role', 'status');
      join.addEventListener('click', function(){ joinChannel(p, join, msg); });
      wrap.appendChild(msg);
    }
    li.appendChild(wrap);
    return li;
  }

  function joinChannel(p, btn, msg){
    btn.disabled = true;
    btn.textContent = 'Joining…';
    msg.textContent = '';
    var call;
    try { call = firebase.app().functions('europe-west2').httpsCallable('joinProjectChannel')({ channel: p.slackChannel }); }
    catch (e) { call = Promise.reject(e); }
    call.then(function(res){
      var d = res.data || {};
      btn.textContent = d.status === 'already' ? 'Already in the channel' : 'Joined';
      msg.textContent = '';
      if (d.url) {
        var a = document.createElement('a');
        a.href = d.url; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = 'Open in Slack';
        msg.appendChild(a);
      }
    }).catch(function(err){
      console.error('[BOLD Lab] joinProjectChannel failed', err);
      btn.disabled = false;
      btn.textContent = 'Join the project';
      msg.textContent = (err && err.message) || 'Couldn’t join the channel.';
    });
  }

  /* ---------- search and filters ---------- */
  var current = null;                                  // the last list from the function
  var filters = { q: '', author: '', keyword: '' };
  var autoTab = false;                                 // arrived with a filter: open a tab that has matches

  // Older cached lists have no `authors`; refetch those.
  function hasAuthors(d){
    return ['ongoing', 'completed', 'planned'].every(function(g){
      return (d[g] || []).every(function(p){ return Array.isArray(p.authors); });
    });
  }

  // The people a project counts under in the author filter: its authors, and whoever registered it.
  function people(p){
    var out = [];
    (p.authors || []).concat(p.ownerEmail || p.owner ? [{ name: p.owner, email: p.ownerEmail }] : []).forEach(function(a){
      var key = String(a.email || a.name || '').toLowerCase();
      if (key && !out.some(function(o){ return o.key === key; })) out.push({ key: key, name: a.name || a.email });
    });
    return out;
  }

  function matches(p){
    if (filters.keyword && (p.keywords || []).indexOf(filters.keyword) === -1) return false;
    if (filters.author && !people(p).some(function(o){ return o.key === filters.author; })) return false;
    if (filters.q) {
      var hay = [p.title, p.abstract, (p.keywords || []).join(' '), p.slackChannel, p.owner, p.boardLabel,
        people(p).map(function(o){ return o.name; }).join(' ')].join(' ').toLowerCase();
      return filters.q.toLowerCase().split(/\s+/).filter(Boolean).every(function(t){ return hay.indexOf(t) !== -1; });
    }
    return true;
  }

  function filtering(){ return !!(filters.q || filters.author || filters.keyword); }

  // Options for the two selects, from every project (not only the visible ones).
  function fillOptions(){
    var authors = {}, keywords = {};
    ['ongoing', 'completed', 'planned'].forEach(function(g){
      ((current && current[g]) || []).forEach(function(p){
        people(p).forEach(function(o){ authors[o.key] = o.name; });
        (p.keywords || []).forEach(function(k){ keywords[k] = (keywords[k] || 0) + 1; });
      });
    });
    var authorKeys = Object.keys(authors).sort(function(a, b){ return authors[a].localeCompare(authors[b]); });
    var keywordNames = Object.keys(keywords).sort(function(a, b){ return keywords[b] - keywords[a] || a.localeCompare(b); });
    var fill = function(sel, all, opts, value){
      sel.innerHTML = '';
      var add = function(v, label){ var o = document.createElement('option'); o.value = v; o.textContent = label; sel.appendChild(o); };
      add('', all);
      // A filter that arrived by link stays selectable even if no project has it any more.
      if (value && !opts.some(function(o){ return o[0] === value; })) add(value, value);
      opts.forEach(function(o){ add(o[0], o[1]); });
      sel.value = value;
    };
    fill(el('projAuthor'), 'All authors', authorKeys.map(function(k){ return [k, authors[k]]; }), filters.author);
    fill(el('projKeyword'), 'All keywords', keywordNames.map(function(k){ return [k, k + ' (' + keywords[k] + ')']; }), filters.keyword);
  }

  // The address keeps the tab and the filters, so a filtered list can be linked.
  function syncHash(){
    var tab = tabs.filter(function(t){ return t.classList.contains('active'); })[0];
    var parts = [];
    if (tab && tab.getAttribute('data-tab') !== 'ongoing') parts.push(tab.getAttribute('data-tab'));
    ['q', 'author', 'keyword'].forEach(function(k){ if (filters[k]) parts.push(k + '=' + encodeURIComponent(filters[k])); });
    try { history.replaceState(null, '', location.pathname + location.search + (parts.length ? '#' + parts.join('&') : '')); } catch (e){}
  }

  function setFilter(name, value){
    filters[name] = value;
    if (name === 'q') el('projSearch').value = value;
    if (name === 'author') el('projAuthor').value = value;
    if (name === 'keyword') el('projKeyword').value = value;
    renderLists();
    syncHash();
  }

  function renderProjects(data){
    current = data;
    fillOptions();
    renderLists();
    el('projMsg').hidden = true;
    el('projects').hidden = false;
  }

  function renderLists(){
    if (!current) return;
    var groups = [['projOngoing', current.ongoing, 'cntOngoing', 'ongoing'], ['projCompleted', current.completed, 'cntCompleted', 'completed'], ['projPlanned', current.planned, 'cntPlanned', 'planned']];
    var shown = {};
    groups.forEach(function(g){
      var ul = el(g[0]); ul.innerHTML = '';
      var items = (g[1] || []).filter(matches);
      shown[g[3]] = items.length;
      el(g[2]).textContent = items.length || (filtering() ? '0' : '');
      if (!items.length) {
        var li = document.createElement('li');
        li.className = 'proj-none';
        li.innerHTML = '<p class="proj-empty">' + (filtering() ? 'No projects match.' : 'None') + '</p>';
        ul.appendChild(li);
      }
      items.forEach(function(p){ ul.appendChild(renderProject(p)); });
    });
    el('projClear').hidden = !filtering();
    if (autoTab) {
      autoTab = false;
      var active = tabs.filter(function(t){ return t.classList.contains('active'); })[0];
      if (!active || !shown[active.getAttribute('data-tab')]) {
        var first = ['ongoing', 'planned', 'completed'].filter(function(n){ return shown[n]; })[0];
        if (first) { setTab(first); syncHash(); }
      }
    }
  }

  el('projSearch').addEventListener('input', function(){ setFilter('q', el('projSearch').value.trim()); });
  el('projAuthor').addEventListener('change', function(){ setFilter('author', el('projAuthor').value); });
  el('projKeyword').addEventListener('change', function(){ setFilter('keyword', el('projKeyword').value); });
  el('projClear').addEventListener('click', function(){
    filters = { q: '', author: '', keyword: '' };
    el('projSearch').value = ''; el('projAuthor').value = ''; el('projKeyword').value = '';
    renderLists(); syncHash();
  });

  /* ---------- list / grid ---------- */
  function setView(view){
    if (view !== 'grid') view = 'list';
    el('projects').setAttribute('data-view', view);
    Array.prototype.forEach.call(document.querySelectorAll('.view-btn'), function(b){
      b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === view));
    });
    try { localStorage.setItem(VIEW_KEY, view); } catch (e){}
  }
  Array.prototype.forEach.call(document.querySelectorAll('.view-btn'), function(b){
    b.addEventListener('click', function(){ setView(b.getAttribute('data-view')); });
  });
  try { setView(localStorage.getItem(VIEW_KEY)); } catch (e){}

  /* ---------- tabs ---------- */
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  function setTab(name){
    tabs.forEach(function(t){
      var on = t.getAttribute('data-tab') === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      el(t.getAttribute('aria-controls')).hidden = !on;
    });
  }
  tabs.forEach(function(t, i){
    t.addEventListener('click', function(){ setTab(t.getAttribute('data-tab')); syncHash(); });
    t.addEventListener('keydown', function(e){
      var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      var next = tabs[(i + d + tabs.length) % tabs.length];
      setTab(next.getAttribute('data-tab')); syncHash(); next.focus(); e.preventDefault();
    });
  });

  // #planned opens that tab; #keyword=rl, #author=<email>, #q=text (joined with &) set the filters.
  try {
    (location.hash || '').slice(1).split('&').forEach(function(tok){
      var kv = tok.split('=');
      if (kv.length === 1 && tabs.some(function(t){ return t.getAttribute('data-tab') === tok; })) return setTab(tok);
      if (kv[0] === 'q' || kv[0] === 'author' || kv[0] === 'keyword') filters[kv[0]] = decodeURIComponent(kv.slice(1).join('='));
    });
    el('projSearch').value = filters.q;
    autoTab = filtering();
  } catch (e){}

  function renderPage(user){
    if (!user) { cacheClear(); return; }
    if (!user.email) return;
    loadCached('getAllProjects', user.email, renderProjects, function(){
      el('projMsg').textContent = 'Could not load projects.';
    }, hasAuthors);
  }

  // Last, once everything above is defined: onUser runs its callback at once if
  // auth has already resolved, and it reads the cache constants and helpers.
  BOLD.onUser(renderPage);

  // First paint from the last visit's cache, before Firebase has loaded.
  try {
    var hint = BOLD.authHint();
    if (hint && hint.e) {
      var hit = cacheGet('getAllProjects:' + hint.e.toLowerCase());
      if (hit) renderProjects(hit.d);
    }
  } catch (e){}
})();
