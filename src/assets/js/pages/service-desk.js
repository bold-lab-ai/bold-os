// service-desk.html: the Service desk's cards (serviceDesk, firestore.rules). Each opens a page
// of the site or a link, or downloads its file (functions/service-desk.js: kept in Storage, out
// of clients' reach, and fetched through serviceDeskFile's short-lived link). Everyone who sees
// the Service desk reads them; PIs and admins add, edit, reorder and remove them here, and
// upload or remove a card's file.
(function(){
  var esc = BOLD.escapeHtml;
  var main = document.getElementById('desk');
  if (!main || !BOLD.getAuth()) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var call = function(data){ return firebase.app().functions('europe-west2').httpsCallable('serviceDeskFile')(data); };
  var cards = null, me = null, fullWrite = false, editing = false, form = null, busy = false, unsub = null;
  var MAX_BYTES = 5 * 1024 * 1024;
  var NO = 'Only PIs and admins change the Service desk.';

  function errText(e, fallback){ return e && e.message && e.code !== 'functions/internal' ? e.message : fallback; }
  function size(n){ return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function validHref(h){ return h === '' || /^[a-z0-9-]+\.html([#?].*)?$/.test(h) || /^https:\/\/.+/.test(h); }
  function sorted(){ return (cards || []).slice().sort(function(a, b){ return (a.order || 0) - (b.order || 0) || String(a.title).localeCompare(String(b.title)); }); }

  function cardHtml(c){
    var file = c.file && c.file.path;
    var cta = file ? 'Download' : 'Open';
    var meta = file ? '<span class="sd-file">' + esc(c.file.name) + ' · ' + size(c.file.size || 0) + '</span>' : '';
    var attrs = file ? 'href="#" data-file="' + esc(c.id) + '"'
      : c.href ? 'href="' + esc(c.href) + '"' + (/^https:/.test(c.href) ? ' target="_blank" rel="noopener"' : '')
      : '';
    var tag = attrs ? 'a' : 'div';
    return '<' + tag + ' class="event-card" ' + attrs + '>' +
      '<h3>' + esc(c.title) + '</h3>' + (c.text ? '<p>' + esc(c.text) + '</p>' : '') +
      (attrs ? '<span class="event-cta">' + cta + '</span>' : '') + meta + '</' + tag + '>';
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

  function render(){
    if (!cards) { main.innerHTML = '<p class="proj-msg">Loading&hellip;</p>'; return; }
    var list = sorted();
    var html = '<section class="block">';
    html += '<div class="sd-head"><button type="button" class="btn-text sd-toggle"' + (fullWrite ? '' : ' disabled title="' + esc(NO) + '"') + '>' +
      (editing ? 'Done' : 'Edit cards') + '</button></div>';
    if (!list.length) html += '<p class="proj-msg">Nothing here yet.</p>';
    html += '<ul class="event-list">' + list.map(function(c, i){
      return '<li>' + (form === c.id ? formHtml(c) : cardHtml(c) + (editing ? controlsHtml(c, i, list.length) : '')) + '</li>';
    }).join('') + '</ul>';
    if (editing) html += form === 'new' ? formHtml(null) : '<p class="sd-add"><button type="button" class="btn-text sd-new">Add a card</button></p>';
    main.innerHTML = html + '</section>';
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
    var data = { title: title, text: text, href: href, updatedBy: me.email, updatedAt: Date.now() };
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
  function download(id, a){
    if (a.classList.contains('is-busy')) return;
    a.classList.add('is-busy');
    call({ action: 'link', id: id })
      .then(function(r){ a.classList.remove('is-busy'); window.location.href = r.data.url; })
      .catch(function(e){ a.classList.remove('is-busy'); console.error('[BOLD Service desk] download failed', e); alert(errText(e, 'Couldn’t download it. Try again.')); });
  }

  main.addEventListener('click', function(e){
    var a = e.target.closest('[data-file]');
    if (a) { e.preventDefault(); return download(a.getAttribute('data-file'), a); }
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    var id = t.getAttribute('data-id');
    var find = function(){ return (cards || []).find(function(x){ return x.id === id; }); };
    if (t.classList.contains('sd-toggle')) { editing = !editing; form = null; render(); }
    else if (t.classList.contains('sd-new')) { form = 'new'; render(); }
    else if (t.classList.contains('sd-edit')) { form = id; render(); }
    else if (t.classList.contains('sd-cancel')) { form = null; render(); }
    // The card being edited is the open form's, not the Save button's (which carries no id).
    else if (t.classList.contains('sd-save')) save(form === 'new' ? null : (cards || []).find(function(x){ return x.id === form; }));
    else if (t.classList.contains('sd-up')) move(id, -1);
    else if (t.classList.contains('sd-down')) move(id, 1);
    else if (t.classList.contains('sd-remove')) remove(id);
  });

  // A PI or admin, not while they view the site as a group.
  BOLD.onAccess(function(a){ fullWrite = !!(a && a.fullWrite && !a.viewAs); if (!fullWrite) { editing = false; form = null; } if (me) render(); });
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
    }, function(err){
      if (!BOLD.getAuth().currentUser) return;  // signing out: the listener goes with the sign-in
      console.error('[BOLD Service desk] loading failed', err); cards = []; render();
    });
  });
})();
