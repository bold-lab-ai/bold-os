(function(){
  // The masthead, gate and sidebar are bold.js's; this page only fills in the projects.
  if (!BOLD.getAuth()) return;
  BOLD.onUser(function(user){ me = user; renderPage(user); });

  var el = function(id){ return document.getElementById(id); };
  var escapeHtml = BOLD.escapeHtml;
  var me; // the signed-in Firebase user, set by BOLD.onUser

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
  function loadCached(fn, email, render, onError){
    var key = fn + ':' + email.toLowerCase();
    var hit = cacheGet(key);
    if (hit) render(hit.d);
    if (hit && Date.now() - hit.t < CACHE_TTL_MS) return;
    var call;
    try { call = firebase.app().functions('europe-west2').httpsCallable(fn); }
    catch (e) { if (!hit) onError(e); return; }
    call().then(function(res){
      var data = res.data || {};
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
    // A project with a venue links to its card; one without has no page yet.
    var a = document.createElement(p.boardId ? 'a' : 'span');
    a.className = 'proj-title';
    if (p.boardId) a.href = 'audit-board.html#board=' + encodeURIComponent(p.boardId) + '&card=' + encodeURIComponent(p.cardId);
    a.textContent = p.title;
    var meta = document.createElement('span');
    meta.className = 'proj-meta';
    meta.textContent = [p.boardId ? p.boardLabel : 'No venue yet', p.slackChannel, p.owner].filter(Boolean).join(' · ');
    main.appendChild(a); main.appendChild(meta);
    if (!p.boardId && db && me && me.email && p.ownerEmail && p.ownerEmail.toLowerCase() === me.email.toLowerCase()) {
      main.appendChild(venueControl(p));
    }
    if (p.abstract) {
      var abs = document.createElement('p');
      abs.className = 'proj-abstract';
      abs.textContent = p.abstract;
      main.appendChild(abs);
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
    // Placeholder: will add the user to the project's Slack channel and ask
    // them to introduce themselves. No handler yet.
    var join = document.createElement('button');
    join.type = 'button';
    join.className = 'join-btn';
    join.textContent = 'Join the project';
    li.appendChild(join);
    return li;
  }

  function renderProjects(data){
    [['projOngoing', data.ongoing, 'cntOngoing'], ['projCompleted', data.completed, 'cntCompleted'], ['projPlanned', data.planned, 'cntPlanned']].forEach(function(g){
      var ul = el(g[0]); ul.innerHTML = '';
      var items = g[1] || [];
      el(g[2]).textContent = items.length || '';
      if (!items.length) {
        var li = document.createElement('li');
        li.className = 'proj-none';
        li.innerHTML = '<p class="proj-empty">None</p>';
        ul.appendChild(li);
      }
      items.forEach(function(p){ ul.appendChild(renderProject(p)); });
    });
    el('projMsg').hidden = true;
    el('projects').hidden = false;
  }

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
    t.addEventListener('click', function(){ setTab(t.getAttribute('data-tab')); });
    t.addEventListener('keydown', function(e){
      var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      var next = tabs[(i + d + tabs.length) % tabs.length];
      setTab(next.getAttribute('data-tab')); next.focus(); e.preventDefault();
    });
  });

  // #planned etc. opens that tab.
  try {
    var fromHash = (location.hash || '').slice(1);
    if (tabs.some(function(t){ return t.getAttribute('data-tab') === fromHash; })) setTab(fromHash);
  } catch (e){}

  /* ---------- set a venue ---------- */
  // A project registered without a venue is a card in `projects`; picking a venue
  // moves it (same card, same id) into that board's cards, where it goes through
  // Internal Review like any paper. Only its owner sees the control.
  var db = null;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){}
  var venues = null;

  function loadVenues(){
    if (venues) return Promise.resolve(venues);
    return db.collection('boards').where('status', '==', 'approved').get().then(function(snap){
      venues = snap.docs.map(function(d){ return { id: d.id, label: d.data().label || d.id }; })
        .sort(function(a, b){ return a.label.localeCompare(b.label); });
      return venues;
    });
  }

  function moveToVenue(projectId, venueId){
    var from = db.collection('projects').doc(projectId);
    return from.get().then(function(doc){
      if (!doc.exists) throw new Error('project not found');
      var card = Object.assign({}, doc.data(), { updatedAt: Date.now() });
      var batch = db.batch();
      batch.set(db.collection('boards').doc(venueId).collection('cards').doc(projectId), card);
      batch.delete(from);
      return batch.commit();
    });
  }

  // "No venue yet" plus, for the owner, a "Set venue" link that turns into a picker.
  function venueControl(p){
    var box = document.createElement('div');
    box.className = 'proj-venue';
    var link = document.createElement('button');
    link.type = 'button'; link.className = 'btn-text'; link.textContent = 'Set venue';
    box.appendChild(link);
    link.addEventListener('click', function(){
      box.innerHTML = '';
      var sel = document.createElement('select');
      sel.innerHTML = '<option value="">Loading&hellip;</option>';
      var save = document.createElement('button'); save.type = 'button'; save.className = 'btn'; save.textContent = 'Save'; save.disabled = true;
      var cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn-text'; cancel.textContent = 'Cancel';
      var msg = document.createElement('span'); msg.className = 'proj-venue-msg';
      [sel, save, cancel, msg].forEach(function(n){ box.appendChild(n); });
      cancel.addEventListener('click', function(){ box.replaceWith(venueControl(p)); });
      sel.addEventListener('change', function(){ save.disabled = !sel.value; });
      loadVenues().then(function(list){
        sel.innerHTML = list.length
          ? '<option value="">Choose a venue&hellip;</option>' + list.map(function(v){ return '<option value="' + escapeHtml(v.id) + '">' + escapeHtml(v.label) + '</option>'; }).join('')
          : '<option value="">No venues yet</option>';
      }).catch(function(err){
        console.error('[BOLD Lab] loading venues failed', err);
        sel.innerHTML = '<option value="">Could not load venues</option>';
      });
      save.addEventListener('click', function(){
        save.disabled = true; msg.textContent = '';
        moveToVenue(p.projectId, sel.value).then(function(){
          try { localStorage.removeItem(CACHE_PREFIX + 'getAllProjects:' + me.email.toLowerCase()); } catch (e){}
          renderPage(me);
        }).catch(function(err){
          console.error('[BOLD Lab] set venue failed', err);
          save.disabled = false;
          msg.textContent = 'Could not set the venue \u2014 try again.';
        });
      });
    });
    return box;
  }

  function renderPage(user){
    if (!user) { cacheClear(); return; }
    if (!user.email) return;
    loadCached('getAllProjects', user.email, renderProjects, function(){
      el('projMsg').textContent = 'Could not load projects.';
    });
  }

  // First paint from the last visit's cache, before Firebase has loaded.
  try {
    var hint = BOLD.authHint();
    if (hint && hint.e) {
      var hit = cacheGet('getAllProjects:' + hint.e.toLowerCase());
      if (hit) renderProjects(hit.d);
    }
  } catch (e){}
})();
