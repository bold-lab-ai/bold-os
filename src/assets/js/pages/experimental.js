// Experimental (2026-11-04): features people in BOLD are trying out, in experiments/{id}
// { title, summary, aboutUrl, tryUrl, createdBy, createdAt, updatedBy, updatedAt }.
// - experimental.html (#experiments): the list, as Projects' rows; each opens its page.
// - experiment.html?id=<id> (#experiment): the experiment, its service (tryUrl) open in the page.
// Whoever may edit Experimental adds one; its author, PIs and admins change or remove it
// (firestore.rules). The sidebar lists them too (bold.js experimentsNav).
(function(){
  var listEl = document.getElementById('experiments'), pageEl = document.getElementById('experiment');
  var main = listEl || pageEl;
  if (!main) return;
  var esc = BOLD.escapeHtml, me = '', list = null, editing = null;   // editing: an id, 'new', or null
  var id = pageEl ? new URLSearchParams(location.search).get('id') || '' : '';
  var safeUrl = function(u){ return /^https:\/\//i.test(String(u || '').trim()) ? String(u).trim() : ''; };
  var col = function(){ return firebase.firestore(BOLD.getApp()).collection('experiments'); };
  var href = function(x){ return 'experiment.html?id=' + encodeURIComponent(x.id); };
  function mine(x){ return BOLD.isFullWrite() || String(x.createdBy || '').toLowerCase() === me; }
  function whyNot(x){ return mine(x) ? '' : ' disabled title="Only whoever added it, PIs and admins"'; }
  var running = function(x){ return safeUrl(x.tryUrl) ? '<span class="badge badge-stage">Running</span>' : '<span class="badge">Not running</span>'; };

  function formHtml(x){
    x = x || {};
    return '<div class="event-form ex-form" data-id="' + esc(x.id || '') + '">' +
      '<p class="event-form-head">' + (x.id ? 'Edit ' + esc(x.title) : 'Add an experiment') + '</p>' +
      '<label>Name<input type="text" class="ex-title" maxlength="80" value="' + esc(x.title || '') + '"></label>' +
      '<label>What it is<textarea class="ex-summary no-tags" rows="3" maxlength="600">' + esc(x.summary || '') + '</textarea></label>' +
      '<label>Its address (https://…, empty while it isn’t running)<input type="url" class="ex-try" maxlength="1000" value="' + esc(x.tryUrl || '') + '" placeholder="https://…"></label>' +
      '<label>Read about it (link, optional)<input type="url" class="ex-about" maxlength="1000" value="' + esc(x.aboutUrl || '') + '" placeholder="https://…"></label>' +
      '<p class="ev-error" hidden></p><div class="event-form-actions">' +
        '<button type="button" class="ev-save ex-save">' + (x.id ? 'Save' : 'Add') + '</button>' +
        '<button type="button" class="ex-cancel">Cancel</button></div></div>';
  }

  // The list (experimental.html).
  function renderList(){
    if (list === null) { main.innerHTML = '<p class="proj-msg">Loading&hellip;</p>'; return; }
    var canAdd = BOLD.can('experimental', 'edit');
    main.innerHTML =
      '<div class="actions"><span></span><button type="button" class="btn btn-primary ex-add"' +
        (canAdd ? '' : ' disabled title="' + esc(BOLD.cannotReason('experimental', 'edit')) + '"') + '>+ Add an experiment</button></div>' +
      (editing === 'new' ? '<div class="ex-new">' + formHtml(null) + '</div>' : '') +
      '<ul class="proj-list ex-list">' + (list.length ? list.map(function(x){
        return '<li><div class="proj-main"><a class="proj-title" href="' + href(x) + '">' + esc(x.title) + '</a>' +
          (x.summary ? '<span class="proj-meta">' + esc(x.summary) + '</span>' : '') +
          '<div class="proj-badges">' + running(x) + '</div></div>' +
          '<a class="btn" href="' + href(x) + '">Open</a></li>';
      }).join('') : '<li><p class="proj-empty">None yet</p></li>') + '</ul>';
  }

  // One experiment (experiment.html?id=…): its service open here, or why it isn't.
  var current = null, frameUrl = '';
  function renderPage(){
    var x = current;
    if (x === null) { main.innerHTML = '<p class="proj-msg">Loading&hellip;</p>'; return; }
    if (!x) { main.innerHTML = '<p class="proj-msg">No such experiment. <a href="experimental.html">All experiments</a></p>'; return; }
    document.title = x.title + ' | BOLD Lab';
    var go = safeUrl(x.tryUrl), about = safeUrl(x.aboutUrl);
    var head = '<a class="back-link" href="experimental.html">&larr; Experimental</a>' +
      '<div class="ex-head"><div><h1>' + esc(x.title) + '</h1>' + (x.summary ? '<p class="ex-summary">' + esc(x.summary) + '</p>' : '') + '</div>' +
      '<div class="ex-links">' +
        (go ? '<a href="' + esc(go) + '" target="_blank" rel="noopener">Open in a new tab</a>' : '') +
        (about ? '<a href="' + esc(about) + '" target="_blank" rel="noopener">Read about it</a>' : '') +
        '<button type="button" class="btn-text ex-edit" data-id="' + esc(x.id) + '"' + whyNot(x) + '>Edit</button>' +
        '<button type="button" class="btn-text danger ex-remove" data-id="' + esc(x.id) + '"' + whyNot(x) + '>Remove</button>' +
      '</div></div>';
    if (editing === x.id) { main.innerHTML = head + formHtml(x); return; }
    // The frame stays as it is while nothing about its address changes (reloading it would, for
    // some services, start over: Brainstorm's join link takes a new seat each time).
    var frame = main.querySelector('.ex-frame');
    if (frame && go && go === frameUrl) { main.querySelector('.ex-top').innerHTML = head; return; }
    frameUrl = go;
    main.innerHTML = '<div class="ex-top">' + head + '</div>' + (go
      ? '<iframe class="ex-frame" src="' + esc(go) + '" title="' + esc(x.title) + '" allow="clipboard-write; microphone; camera" referrerpolicy="no-referrer"></iframe>'
      : '<p class="proj-msg ex-off">Not running right now. Whoever runs it puts its address here (Edit), and it opens on this page.</p>');
  }
  var render = function(){ return listEl ? renderList() : renderPage(); };

  function save(f){
    var fid = f.getAttribute('data-id'), err = f.querySelector('.ev-error');
    var val = function(c){ return f.querySelector(c).value.trim(); };
    var d = { title: val('.ex-title'), summary: val('.ex-summary'), aboutUrl: val('.ex-about'), tryUrl: val('.ex-try') };
    var bad = !d.title ? 'Give it a name.'
      : (d.aboutUrl && !safeUrl(d.aboutUrl)) || (d.tryUrl && !safeUrl(d.tryUrl)) ? 'Addresses start with https://.' : '';
    if (bad) { err.textContent = bad; err.hidden = false; return; }
    var now = firebase.firestore.FieldValue.serverTimestamp();
    d.updatedBy = me; d.updatedAt = now;
    var p = fid ? col().doc(fid).update(d) : col().add(Object.assign(d, { createdBy: me, createdAt: now }));
    f.querySelector('.ex-save').disabled = true;
    p.then(function(ref){
      editing = null;
      if (!fid && ref) { location.href = 'experiment.html?id=' + encodeURIComponent(ref.id); return; }
      render();
    }, function(e){
      f.querySelector('.ex-save').disabled = false;
      err.textContent = 'Couldn’t save: ' + (e && e.message || e); err.hidden = false;
    });
  }

  main.addEventListener('click', function(e){
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    var tid = t.getAttribute('data-id');
    if (t.classList.contains('ex-add')) { editing = 'new'; render(); return; }
    if (t.classList.contains('ex-edit')) { editing = tid; render(); return; }
    if (t.classList.contains('ex-cancel')) { editing = null; render(); return; }
    if (t.classList.contains('ex-save')) { save(t.closest('.ex-form')); return; }
    if (t.classList.contains('ex-remove')) {
      BOLD.confirmAction({ title: 'Remove ' + (current ? current.title : 'this experiment') + '?', effects: ['Take it off Experimental and the sidebar, for everyone'], go: 'Remove' })
        .then(function(ok){ if (ok) col().doc(tid).delete().then(function(){ location.href = 'experimental.html'; }, function(err){ console.error('[BOLD Lab] removing an experiment failed', err); }); });
    }
  });

  BOLD.onAccess(function(a){
    me = String((a && a.e) || '').toLowerCase();
    if (!BOLD.can('experimental', 'view')) { main.innerHTML = '<p class="proj-msg">' + esc(BOLD.cannotReason('experimental', 'view')) + '</p>'; return; }
    var fail = function(err){ main.innerHTML = '<p class="proj-msg">Couldn’t load the experiments.</p>'; console.error('[BOLD Lab] loading experiments failed', err); };
    if (listEl) {
      col().onSnapshot(function(snap){
        list = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); })
          .sort(function(a, b){ return String(a.title).localeCompare(String(b.title)); });
        if (editing !== 'new') renderList();
      }, fail);
    } else {
      if (!id) { current = false; renderPage(); return; }
      col().doc(id).onSnapshot(function(d){
        current = d.exists ? Object.assign({ id: d.id }, d.data()) : false;
        if (!editing) renderPage();
      }, fail);
    }
  });
})();
