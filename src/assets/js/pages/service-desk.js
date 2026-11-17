// service-desk.html: the Service desk's cards (serviceDesk, firestore.rules). Each opens a page
// of the site or a link, or its own page (service-desk-card.html: its About and its file, kept in
// Storage out of clients' reach and fetched through serviceDeskFile's short-lived link). Everyone who sees
// the Service desk reads them; PIs and admins add, edit, reorder and remove them here, and
// upload or remove a card's file.
(function(){
  var esc = BOLD.escapeHtml;
  var main = document.getElementById('desk');
  if (!main || !BOLD.getAuth()) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var call = function(data){ return firebase.app().functions('europe-west2').httpsCallable('serviceDeskFile')(data); };
  var shown = false, cards = null, me = null, fullWrite = false, editing = false, form = null, busy = false, unsub = null;
  var MAX_BYTES = 5 * 1024 * 1024;
  var NO = 'Only PIs and admins change the Service desk.';

  function errText(e, fallback){ return e && e.message && e.code !== 'functions/internal' ? e.message : fallback; }
  function size(n){ return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function validHref(h){ return h === '' || /^[a-z0-9-]+\.html([#?].*)?$/.test(h) || /^https:\/\/.+/.test(h); }
  function sorted(){ return (cards || []).slice().sort(function(a, b){ return (a.order || 0) - (b.order || 0) || String(a.title).localeCompare(String(b.title)); }); }

  var list = document.getElementById('deskList'), msg = document.getElementById('deskMsg'), slot = document.getElementById('deskForm');
  var search = document.getElementById('deskSearch'), q = '';
  // A row as on Projects (bold.css .proj-list, projects.css): the title (the link, or the download),
  // what it opens or holds, and the description.
  function rowHtml(c, i, n){
    var file = c.file && c.file.path;
    var external = !file && /^https:/.test(c.href || '');
    // A page or link opens it; a file (or nothing yet) opens the card's own page (service-desk-card.html).
    var attrs = !file && c.href ? 'href="' + esc(c.href) + '"' + (external ? ' target="_blank" rel="noopener"' : '')
      : 'href="service-desk-card.html?card=' + encodeURIComponent(c.id) + '"';
    var meta = file ? esc(c.file.name) + ' · ' + size(c.file.size || 0)
      : external ? esc(c.href.replace(/^https:\/\//, '').split('/')[0])
      : !c.href ? 'Not available yet' : '';
    return '<div class="proj-main">' +
      (attrs ? '<a class="proj-title" ' + attrs + '>' : '<span class="proj-title">') + esc(c.title) + (attrs ? '</a>' : '</span>') +
      (meta ? '<span class="proj-meta">' + meta + '</span>' : '') +
      (c.text ? '<p class="proj-abstract">' + esc(c.text) + '</p>' : '') +
      (editing ? controlsHtml(c, i, n) : '') + '</div>';
  }
  function controlsHtml(c, i, n){
    return '<div class="sd-controls">' +
      '<button type="button" class="btn-text sd-edit" data-id="' + esc(c.id) + '">Edit</button>' +
      '<button type="button" class="btn-text sd-up" data-id="' + esc(c.id) + '"' + (i === 0 ? ' disabled' : '') + '>Move up</button>' +
      '<button type="button" class="btn-text sd-down" data-id="' + esc(c.id) + '"' + (i === n - 1 ? ' disabled' : '') + '>Move down</button>' +
      '<button type="button" class="btn-text sd-remove" data-id="' + esc(c.id) + '">Remove</button></div>';
  }
  function formHtml(c){
    var file = c && c.file && c.file.path;
    return '<div class="event-form sd-form">' +
      '<p class="event-form-head">' + (c ? 'Edit the card' : 'Add a card') + '</p>' +
      '<label>Title<input type="text" class="sd-title" maxlength="80" value="' + esc(c ? c.title : '') + '"></label>' +
      '<label>Description<textarea class="sd-text no-tags" rows="3" maxlength="300">' + esc(c ? c.text || '' : '') + '</textarea></label>' +
      '<label>About<span class="event-form-hint">Shown on the card’s own page: what it is, how to use it, a preview (paste or drop an image).</span>' +
        '<textarea class="sd-about md-field" rows="6" maxlength="20000" data-preview-class="md-desc">' + esc(c ? c.about || '' : '') + '</textarea></label>' +
      '<label>Link<span class="event-form-hint">A page of the site (letters.html) or an address (https://…). Leave it empty for a file.</span>' +
        '<input type="text" class="sd-href" maxlength="500" spellcheck="false" value="' + esc(c ? c.href || '' : '') + '"></label>' +
      '<label>File<span class="event-form-hint">' + (file ? 'Now: ' + esc(c.file.name) + ' (' + size(c.file.size || 0) + '). Choose another to replace it. ' : '') +
        'Up to 5 MB: .zip, .pdf, .tex, .sty, .bib, .txt, .md, .docx or .pptx. Only people signed in to BOLD.OS can download it.</span>' +
        '<input type="file" class="sd-upload" accept=".zip,.pdf,.tex,.sty,.bib,.txt,.md,.docx,.pptx"></label>' +
      (file ? '<label class="jn-check"><input type="checkbox" class="sd-drop"> Remove the file</label>' : '') +
      '<p class="ev-error" hidden></p><div class="event-form-actions">' +
        '<button type="button" class="ev-save sd-save">' + (c ? 'Save' : 'Add it') + '</button>' +
        '<button type="button" class="sd-cancel">Cancel</button></div></div>';
  }

  function showForm(){ var f = main.querySelector('.sd-form'); if (f) f.scrollIntoView({ block: 'center' }); }
  function matches(c){ return !q || (String(c.title) + ' ' + String(c.text || '')).toLowerCase().indexOf(q) !== -1; }
  function render(){
    var toggle = main.querySelector('.sd-toggle'), add = main.querySelector('.sd-new');
    toggle.disabled = add.disabled = !fullWrite;
    toggle.title = add.title = fullWrite ? '' : NO;
    toggle.textContent = editing ? 'Done' : 'Edit cards';
    if (!cards) { msg.hidden = false; msg.innerHTML = 'Loading&hellip;'; list.innerHTML = ''; slot.innerHTML = ''; return; }
    var all = sorted(), shown = all.filter(matches);
    msg.hidden = !!all.length; msg.textContent = 'Nothing here yet.';
    list.innerHTML = shown.map(function(c){
      var i = all.indexOf(c);
      return '<li id="' + esc(c.id) + '"' + (form === c.id ? ' class="sd-editing">' + formHtml(c) : '>' + rowHtml(c, i, all.length)) + '</li>';
    }).join('') + (all.length && !shown.length ? '<li class="proj-none"><p class="proj-empty">No cards match.</p></li>' : '');
    slot.innerHTML = form === 'new' ? formHtml(null) : '';
  }

  function fail(msg){ var p = main.querySelector('.sd-form .ev-error'); if (p) { p.textContent = msg; p.hidden = false; } }
  function readFile(f){
    return new Promise(function(resolve, reject){
      var r = new FileReader();
      r.onload = function(){ resolve(String(r.result).split(',')[1] || ''); };
      r.onerror = function(){ reject(new Error('Couldn’t read the file.')); };
      r.readAsDataURL(f);
    });
  }
  function save(c){
    if (busy) return;
    var box = main.querySelector('.sd-form');
    var title = box.querySelector('.sd-title').value.trim();
    var text = box.querySelector('.sd-text').value.trim();
    var about = box.querySelector('.sd-about').value.trim();
    var href = box.querySelector('.sd-href').value.trim();
    var pick = box.querySelector('.sd-upload').files[0];
    var drop = box.querySelector('.sd-drop');
    drop = drop && drop.checked;
    if (!title) return fail('Give it a title.');
    if (!validHref(href)) return fail('The link must be a page of the site (like letters.html) or start with https://.');
    if (pick && pick.size > MAX_BYTES) return fail('The file must be 5 MB or smaller.');
    if (href && pick) return fail('A card opens a link or downloads a file, not both.');
    var hasFile = c && c.file && c.file.path && !drop;
    if (!href && !pick && !hasFile && !confirm('This card won’t open anything. Save it anyway?')) return;
    busy = true;
    var data = { title: title, text: text, href: href, about: about, updatedBy: me.email, updatedAt: Date.now() };
    var ref = c ? db.collection('serviceDesk').doc(c.id) : db.collection('serviceDesk').doc();
    if (!c) data.order = (sorted().reduce(function(m, x){ return Math.max(m, x.order || 0); }, 0)) + 1;
    (c ? ref.update(data) : ref.set(data))
      .then(function(){ if (drop || (href && c && c.file && c.file.path)) return call({ action: 'remove', id: ref.id }); })
      .then(function(){ if (pick) return readFile(pick).then(function(b64){ return call({ action: 'upload', id: ref.id, name: pick.name, file: b64 }); }); })
      .then(function(){ busy = false; form = null; render(); })
      .catch(function(e){ busy = false; console.error('[BOLD Service desk] saving failed', e); fail(errText(e, 'Couldn’t save it. Try again.')); });
  }
  function move(id, step){
    var list = sorted(), i = list.findIndex(function(c){ return c.id === id; }), j = i + step;
    if (i < 0 || j < 0 || j >= list.length) return;
    var batch = db.batch(), now = Date.now();
    // Number them afresh in their new order, so equal or missing orders can't stick.
    var order = list.slice(); order.splice(j, 0, order.splice(i, 1)[0]);
    order.forEach(function(c, k){ if ((c.order || 0) !== k + 1) batch.update(db.collection('serviceDesk').doc(c.id), { order: k + 1, updatedBy: me.email, updatedAt: now }); });
    batch.commit().catch(function(e){ console.error('[BOLD Service desk] reordering failed', e); alert('Couldn’t move it. Try again.'); });
  }
  function remove(id){
    var c = (cards || []).find(function(x){ return x.id === id; });
    if (!c || !confirm('Remove “' + c.title + '” from the Service desk?' + (c.file && c.file.path ? ' Its file is deleted too.' : ''))) return;
    // Its file first: the server finds it through the card.
    (c.file && c.file.path ? call({ action: 'remove', id: id }) : Promise.resolve())
      .then(function(){ return db.collection('serviceDesk').doc(id).delete(); })
      .catch(function(e){ console.error('[BOLD Service desk] removing failed', e); alert(errText(e, 'Couldn’t remove it. Try again.')); });
  }
  main.addEventListener('click', function(e){
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    var id = t.getAttribute('data-id');
    var find = function(){ return (cards || []).find(function(x){ return x.id === id; }); };
    if (t.classList.contains('sd-toggle')) { editing = !editing; form = null; render(); }
    else if (t.classList.contains('sd-new')) { editing = true; form = 'new'; render(); }
    else if (t.classList.contains('sd-edit')) { editing = true; form = id; render(); }
    else if (t.classList.contains('sd-cancel')) { form = null; render(); }
    // The card being edited is the open form's, not the Save button's (which carries no id).
    else if (t.classList.contains('sd-save')) save(form === 'new' ? null : (cards || []).find(function(x){ return x.id === form; }));
    else if (t.classList.contains('sd-up')) move(id, -1);
    else if (t.classList.contains('sd-down')) move(id, 1);
    else if (t.classList.contains('sd-remove')) remove(id);
  });

  if (search) search.addEventListener('input', function(){ q = search.value.trim().toLowerCase(); render(); });
  BOLD.mountViewToggle(main.querySelector('.view-toggle'), document.getElementById('deskViews'), 'boldDesk:view');
  // A PI or admin, not while they view the site as a group.
  BOLD.onAccess(function(a){
    fullWrite = !!(a && a.fullWrite && !a.viewAs);
    if (!fullWrite) { editing = false; form = null; }
    var ed = fullWrite && !shown && cards && new URLSearchParams(location.search).get('edit');
    if (ed && cards.some(function(c){ return c.id === ed; })) { shown = true; editing = true; form = ed; }
    if (me) render();
    if (ed && form === ed) showForm();
  });
  BOLD.onUser(function(user){
    if (unsub) { unsub(); unsub = null; }
    me = user ? { email: (user.email || '').toLowerCase() } : null;
    cards = null; editing = false; form = null;
    if (!user) return;
    render();
    unsub = db.collection('serviceDesk').onSnapshot(function(snap){
      cards = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
      // Keep an open form while someone else's edit arrives.
      if (form && form !== 'new' && !cards.some(function(c){ return c.id === form; })) form = null;
      if (!main.querySelector('.sd-form')) render();
      // ?edit=<id> (the card's page's Edit): its form, once the cards are in, for a PI or admin.
      if (!shown && fullWrite) { shown = true; var ed = new URLSearchParams(location.search).get('edit'); if (ed && cards.some(function(c){ return c.id === ed; })) { editing = true; form = ed; render(); showForm(); } }
    }, function(err){
      if (!BOLD.getAuth().currentUser) return;  // signing out: the listener goes with the sign-in
      console.error('[BOLD Service desk] loading failed', err); cards = []; render();
    });
  });
})();
