// Experimental (experimental.html, 2026-11-04): features people in BOLD are trying out, in
// experiments/{id} { title, summary, aboutUrl, tryUrl, createdBy, createdAt, updatedBy, updatedAt }.
// Whoever may edit Experimental adds one; its author, PIs and admins change or remove it
// (firestore.rules). The sidebar lists them (bold.js experimentsNav), each to #<id> here.
(function(){
  var main = document.getElementById('experiments');
  if (!main) return;
  var esc = BOLD.escapeHtml, list = null, me = '', editing = null;   // editing: an id, 'new', or null
  var safeUrl = function(u){ return /^https:\/\//i.test(String(u || '').trim()) ? String(u).trim() : ''; };

  function mine(x){ return BOLD.isFullWrite() || String(x.createdBy || '').toLowerCase() === me; }

  function formHtml(x){
    x = x || {};
    return '<div class="event-form ex-form" data-id="' + esc(x.id || '') + '">' +
      '<p class="event-form-head">' + (x.id ? 'Edit ' + esc(x.title) : 'Add an experiment') + '</p>' +
      '<label>Name<input type="text" class="ex-title" maxlength="80" value="' + esc(x.title || '') + '"></label>' +
      '<label>What it is<textarea class="ex-summary no-tags" rows="3" maxlength="600">' + esc(x.summary || '') + '</textarea></label>' +
      '<label>Read about it (link, optional)<input type="url" class="ex-about" maxlength="1000" value="' + esc(x.aboutUrl || '') + '" placeholder="https://…"></label>' +
      '<label>Try it (link, optional: leave empty when it isn’t running)<input type="url" class="ex-try" maxlength="1000" value="' + esc(x.tryUrl || '') + '" placeholder="https://…"></label>' +
      '<p class="ev-error" hidden></p><div class="event-form-actions">' +
        '<button type="button" class="ev-save ex-save">' + (x.id ? 'Save' : 'Add') + '</button>' +
        '<button type="button" class="ex-cancel">Cancel</button></div></div>';
  }

  function itemHtml(x){
    if (editing === x.id) return '<article class="ex-item" id="' + esc(x.id) + '">' + formHtml(x) + '</article>';
    var about = safeUrl(x.aboutUrl), go = safeUrl(x.tryUrl), can = mine(x);
    var why = can ? '' : ' disabled title="Only whoever added it, PIs and admins"';
    return '<article class="ex-item" id="' + esc(x.id) + '">' +
      '<h2 class="ex-title">' + esc(x.title) + '</h2>' +
      (x.summary ? '<p class="ex-summary">' + esc(x.summary) + '</p>' : '') +
      '<div class="ex-links">' +
        (go ? '<a class="ex-try" href="' + esc(go) + '" target="_blank" rel="noopener">Try it</a>'
            : '<span class="ex-try is-off" title="Not running right now">Try it</span>') +
        (about ? '<a href="' + esc(about) + '" target="_blank" rel="noopener">Read about it</a>' : '') +
        '<button type="button" class="btn-text ex-edit" data-id="' + esc(x.id) + '"' + why + '>Edit</button>' +
        '<button type="button" class="btn-text danger ex-remove" data-id="' + esc(x.id) + '"' + why + '>Remove</button>' +
      '</div></article>';
  }

  function render(){
    if (list === null) { main.innerHTML = '<p class="proj-msg">Loading&hellip;</p>'; return; }
    var canAdd = BOLD.can('experimental', 'edit');
    main.innerHTML =
      (editing === 'new' ? formHtml(null)
        : '<p><button type="button" class="btn-text ex-add"' + (canAdd ? '' : ' disabled title="' + esc(BOLD.cannotReason('experimental', 'edit')) + '"') + '>+ Add an experiment</button></p>') +
      (list.length ? list.map(itemHtml).join('') : '<p class="proj-msg">No experiments yet.</p>');
    if (location.hash && !editing) { var t = document.getElementById(decodeURIComponent(location.hash.slice(1))); if (t) t.classList.add('is-target'); }
  }

  function save(f){
    var id = f.getAttribute('data-id'), err = f.querySelector('.ev-error');
    var val = function(c){ return f.querySelector(c).value.trim(); };
    var d = { title: val('.ex-title'), summary: val('.ex-summary'), aboutUrl: val('.ex-about'), tryUrl: val('.ex-try') };
    var bad = !d.title ? 'Give it a name.'
      : (d.aboutUrl && !safeUrl(d.aboutUrl)) || (d.tryUrl && !safeUrl(d.tryUrl)) ? 'Links start with https://.' : '';
    if (bad) { err.textContent = bad; err.hidden = false; return; }
    var now = firebase.firestore.FieldValue.serverTimestamp(), col = firebase.firestore(BOLD.getApp()).collection('experiments');
    d.updatedBy = me; d.updatedAt = now;
    var p = id ? col.doc(id).update(d) : col.add(Object.assign(d, { createdBy: me, createdAt: now }));
    f.querySelector('.ex-save').disabled = true;
    p.then(function(){ editing = null; render(); }, function(e){
      f.querySelector('.ex-save').disabled = false;
      err.textContent = 'Couldn’t save: ' + (e && e.message || e); err.hidden = false;
    });
  }

  main.addEventListener('click', function(e){
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    var id = t.getAttribute('data-id');
    if (t.classList.contains('ex-add')) { editing = 'new'; render(); return; }
    if (t.classList.contains('ex-edit')) { editing = id; render(); return; }
    if (t.classList.contains('ex-cancel')) { editing = null; render(); return; }
    if (t.classList.contains('ex-save')) { save(t.closest('.ex-form')); return; }
    if (t.classList.contains('ex-remove')) {
      var x = (list || []).filter(function(y){ return y.id === id; })[0];
      BOLD.confirmAction({ title: 'Remove ' + (x ? x.title : 'this experiment') + '?', effects: ['Take it off Experimental and the sidebar, for everyone'], go: 'Remove' })
        .then(function(ok){ if (ok) firebase.firestore(BOLD.getApp()).collection('experiments').doc(id).delete().catch(function(err){ console.error('[BOLD Lab] removing an experiment failed', err); }); });
    }
  });

  BOLD.onAccess(function(a){
    me = String((a && a.e) || '').toLowerCase();
    if (!BOLD.can('experimental', 'view')) { main.innerHTML = '<p class="proj-msg">' + esc(BOLD.cannotReason('experimental', 'view')) + '</p>'; return; }
    firebase.firestore(BOLD.getApp()).collection('experiments').onSnapshot(function(snap){
      list = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); })
        .sort(function(a, b){ return String(a.title).localeCompare(String(b.title)); });
      if (!editing || editing === 'new') render();
    }, function(err){ main.innerHTML = '<p class="proj-msg">Couldn’t load the experiments.</p>'; console.error('[BOLD Lab] loading experiments failed', err); });
  });
})();
