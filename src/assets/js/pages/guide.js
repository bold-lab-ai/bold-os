// A how-to guide's page (guide.html?guide=<slug>) — one guides/{slug} doc (see
// guides-common.js): its title and description, its contents, then its parts,
// each written in Markdown. Anyone signed in can change any of it: a PI/admin's
// change is saved at once; anyone else's is a proposal, listed under "Proposed
// changes" until a PI/admin accepts it (applied to the guide, crediting whoever
// proposed it) or declines it. Whoever proposed one can withdraw it while it's
// open. PIs/admins also move parts up and down and delete the guide.
// guide.html?new is the form for a new guide (PIs/admins). History
// (history.js) shows every version, with what changed; PIs/admins restore one.
(function(){
  var esc = BOLD.escapeHtml;
  var G = window.BoldGuides;
  var md = BoldMarkdown.render;
  var body = document.getElementById('guideBody');
  if (!body || !BOLD.getAuth()) return;
  var db = null;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var params = new URLSearchParams(location.search);
  var isNew = params.has('new');
  var slug = params.get('guide') || '';
  var ref = !isNew && G.SLUG.test(slug) ? db.collection('guides').doc(slug) : null;
  var MAX_SIZE = 900000;

  var x = null, loaded = false, fullWrite = false, me = null;
  var proposals = [];
  // The form that's open: null, { kind: 'about' }, { kind: 'edit', id } or { kind: 'add' }.
  var form = null, notice = '';
  var BACK = '<a class="back-link" href="guides.html">&larr; All guides</a>';
  var historyWrap = document.getElementById('guideHistoryWrap'), histPanel = null;
  var KIND = { about: 'Title and description', edit: 'Change to', add: 'New part', remove: 'Remove' };

  function parts(){ return (x && x.parts) || []; }
  function part(id){ return parts().filter(function(p){ return p.id === id; })[0] || null; }
  function anchor(p){ return 'p-' + p.id; }
  function stamp(note){ return { changeNote: note || '', updatedAt: Date.now(), updatedBy: me.email, proposedBy: '' }; }

  // What a version or the guide holds, as text to compare (history.js).
  function flatten(d){
    var out = { Title: d.title || '', Description: d.description || '' };
    var list = d.parts || [];
    out['Order of parts'] = list.map(function(p){ return p.title; }).join('\n');
    list.forEach(function(p){ out['Part: ' + p.title] = p.body || ''; });
    return out;
  }

  // ---------- reading ----------

  function partHtml(p, i){
    var n = parts().length;
    var editing = form && form.kind === 'edit' && form.id === p.id;
    if (editing) return '<section class="guide-part" id="' + anchor(p) + '">' + partFormHtml(p) + '</section>';
    var off = fullWrite ? '' : ' disabled title="' + G.NOT_PI + '"';
    return '<section class="guide-part" id="' + anchor(p) + '">' +
      '<h2><span class="guide-num">' + (i + 1) + '</span>' + esc(p.title) + '</h2>' +
      '<div class="guide-text">' + md(p.body) + '</div>' +
      '<div class="event-controls guide-part-controls">' +
        '<button type="button" class="btn-text gd-edit" data-id="' + esc(p.id) + '">' + (fullWrite ? 'Edit' : 'Suggest a change') + '</button>' +
        '<button type="button" class="btn-text gd-up" data-id="' + esc(p.id) + '"' + (i === 0 ? ' disabled' : off) + '>Move up</button>' +
        '<button type="button" class="btn-text gd-down" data-id="' + esc(p.id) + '"' + (i === n - 1 ? ' disabled' : off) + '>Move down</button>' +
      '</div></section>';
  }

  function contentsHtml(){
    if (parts().length < 2) return '';
    return '<nav class="guide-contents" aria-label="Contents"><ol>' + parts().map(function(p){
      return '<li><a href="#' + anchor(p) + '">' + esc(p.title) + '</a></li>';
    }).join('') + '</ol></nav>';
  }

  // ---------- forms ----------

  function noteHtml(placeholder){
    return '<label>' + (fullWrite ? 'What changed (optional)' : 'What you changed and why') +
      '<input type="text" class="gd-note" maxlength="300" placeholder="' + esc(placeholder) + '"></label>' +
      (fullWrite ? '' : '<p class="event-form-hint">A PI or admin reviews your change before it shows in the guide.</p>');
  }
  function actionsHtml(extra){
    return '<p class="ev-error" hidden></p><div class="event-form-actions">' +
      '<button type="button" class="ev-save">' + (fullWrite ? 'Save' : 'Propose change') + '</button>' +
      '<button type="button" class="ev-cancel">Cancel</button>' + (extra || '') + '</div>';
  }

  function partFormHtml(p){
    p = p || { title: '', body: '' };
    var isAdd = !p.id;
    return '<div class="event-form guide-form">' +
      '<p class="event-form-head">' + (isAdd ? 'New part' : 'Edit part') + '</p>' +
      '<label>Title<input type="text" class="gd-title" value="' + esc(p.title) + '" placeholder="e.g. Before the reviews come in"></label>' +
      '<label>Text<textarea class="gd-body" rows="16">' + esc(p.body) + '</textarea></label>' +
      '<p class="event-form-hint">Markdown: **bold**, *italic*, [a link](https://…), lines starting with - or 1. for lists, a blank line between paragraphs.</p>' +
      noteHtml(isAdd ? 'e.g. Added a part on posters' : 'e.g. Clearer advice on ablations') +
      actionsHtml(isAdd ? '' : '<button type="button" class="btn-text danger gd-remove">' + (fullWrite ? 'Remove this part' : 'Propose removing this part') + '</button>') +
      '</div>';
  }

  function aboutFormHtml(){
    return '<div class="event-form guide-form">' +
      '<label>Title<input type="text" class="gd-title" value="' + esc(x.title) + '"></label>' +
      '<label>Description<textarea class="gd-description" rows="3">' + esc(x.description || '') + '</textarea></label>' +
      noteHtml('e.g. Shorter description') + actionsHtml() + '</div>';
  }

  function newFormHtml(){
    return '<div class="event-form guide-form">' +
      '<label>Title<input type="text" class="gd-title" placeholder="e.g. Write a rebuttal"></label>' +
      '<label>Name in its link<input type="text" class="gd-slug" spellcheck="false" autocapitalize="off" placeholder="e.g. write-a-rebuttal"></label>' +
      '<p class="event-form-hint">guide.html?guide=<em>name</em>: lowercase letters, numbers and hyphens. It can’t be changed later.</p>' +
      '<label>Description<textarea class="gd-description" rows="3"></textarea></label>' +
      '<p class="event-form-hint">You add its parts on the guide’s page.</p>' +
      '<p class="ev-error" hidden></p><div class="event-form-actions"><button type="button" class="ev-save">Add guide</button><button type="button" class="ev-cancel">Cancel</button></div></div>';
  }

  function showError(el, msg){ var b = el.querySelector('.ev-error'); b.textContent = msg; b.hidden = !msg; }

  // ---------- proposals ----------

  function sideText(kind, side){
    if (!side) return { };
    return kind === 'about' ? { Title: side.title || '', Description: side.description || '' } : { Title: side.title || '', Text: side.body || '' };
  }

  function proposalHtml(q){
    var cur = q.kind === 'about' ? { title: x.title, description: x.description || '' } : q.partId ? part(q.partId) : null;
    var stale = q.kind !== 'add' && (!cur || (q.before && (cur.title !== q.before.title || (q.kind === 'about' ? (cur.description || '') !== (q.before.description || '') : (cur.body || '') !== (q.before.body || '')))));
    var what = q.kind === 'about' ? KIND.about : KIND[q.kind] + ' “' + esc((q.after || q.before || {}).title || '') + '”';
    var mine = me && q.by && q.by.email === me.email;
    var off = fullWrite ? '' : ' disabled title="' + G.NOT_PI + '"';
    return '<li class="gd-proposal" data-id="' + esc(q.id) + '">' +
      '<p class="gd-proposal-head"><span class="hist-when">' + BoldHistory.when(q.at) + '</span>' +
        '<span>' + what + ' · proposed by ' + esc(q.by ? (q.by.name || q.by.email) : 'someone') + '</span></p>' +
      (q.note ? '<p class="gd-proposal-note">' + esc(q.note) + '</p>' : '') +
      (stale ? '<p class="gd-proposal-stale">' + (q.kind !== 'about' && !cur ? 'That part has since been removed.' : 'This has changed since it was proposed; accepting replaces the current text.') + '</p>' : '') +
      BoldHistory.changesHtml(sideText(q.kind, q.before), sideText(q.kind, q.after), {}) +
      '<div class="event-controls">' +
        '<button type="button" class="btn-text gd-accept"' + off + (q.kind !== 'add' && q.kind !== 'about' && !cur ? ' disabled' : '') + '>Accept</button>' +
        '<button type="button" class="btn-text danger gd-decline"' + off + '>Decline</button>' +
        (mine ? '<button type="button" class="btn-text gd-withdraw">Withdraw</button>' : '') +
      '</div></li>';
  }

  function proposalsHtml(){
    if (!proposals.length) return '';
    return '<section class="block guide-proposals" id="proposals"><div class="block-head"><h2>Proposed changes</h2></div>' +
      '<ul class="gd-proposal-list">' + proposals.map(proposalHtml).join('') + '</ul></section>';
  }

  // The guide's parts with q applied.
  function applied(q){
    var list = parts().map(function(p){ return Object.assign({}, p); });
    if (q.kind === 'add') list.push({ id: q.partId || G.partId(), title: q.after.title, body: q.after.body });
    else if (q.kind === 'remove') list = list.filter(function(p){ return p.id !== q.partId; });
    else if (q.kind === 'edit') list.forEach(function(p){ if (p.id === q.partId) { p.title = q.after.title; p.body = q.after.body; } });
    return list;
  }

  function decide(q, accept){
    var batch = db.batch();
    var who = q.by ? (q.by.name || q.by.email) : '';
    if (accept) {
      var change = q.kind === 'about' ? { title: q.after.title, description: q.after.description } : { parts: applied(q) };
      batch.update(ref, Object.assign(change, stamp(q.note || ('Proposed by ' + who)), { proposedBy: q.by ? q.by.email : '' }));
    }
    batch.update(ref.collection('proposals').doc(q.id), { status: accept ? 'accepted' : 'declined', decidedBy: me.email, decidedAt: Date.now() });
    return batch.commit();
  }

  // Saves a change: at once for a PI/admin, as a proposal for anyone else.
  // change: { kind, partId, before, after, note } → Promise.
  function submit(change){
    if (fullWrite) {
      var q = Object.assign({ by: null }, change);
      var direct = q.kind === 'about' ? { title: q.after.title, description: q.after.description } : { parts: applied(q) };
      return ref.update(Object.assign(direct, stamp(change.note)));
    }
    return ref.collection('proposals').add(Object.assign({}, change, {
      by: { email: me.email, name: me.name }, at: Date.now(), status: 'open',
    })).then(function(){ notice = 'Thanks — your change is under “Proposed changes” until a PI or admin reviews it.'; });
  }

  // ---------- page ----------

  function render(){
    if (!loaded) return;
    drawHistory();
    if (isNew) {
      document.title = 'New guide | BOLD Lab';
      body.innerHTML = '<div class="hero">' + BACK + '<div><span class="eyebrow">How to</span></div><h1>New guide</h1>' +
        (fullWrite ? '' : '<p class="hero-note">' + G.NOT_PI + '.</p>') + '</div>' + (fullWrite ? '<main>' + newFormHtml() + '</main>' : '');
      if (fullWrite) bindNew();
      return;
    }
    if (!x) {
      document.title = 'Guide not found | BOLD Lab';
      body.innerHTML = '<div class="hero">' + BACK + '<h1>Guide not found</h1><p class="hero-note">It may have been deleted.</p></div>';
      return;
    }
    document.title = x.title + ' | BOLD Lab';
    var off = fullWrite ? '' : ' disabled title="' + G.NOT_PI + '"';
    var hero = '<div class="hero">' + BACK + '<div><span class="eyebrow">How to</span></div>';
    if (form && form.kind === 'about') hero += aboutFormHtml();
    else hero += '<h1>' + esc(x.title) + '</h1>' + (x.description ? '<p class="hero-note">' + esc(x.description) + '</p>' : '') +
      '<div class="event-controls"><button type="button" class="btn-text gd-about">' + (fullWrite ? 'Edit' : 'Suggest a change') + '</button>' +
      '<button type="button" class="btn-text danger gd-delete"' + off + '>Delete guide</button>' +
      (proposals.length ? '<a class="btn-text gd-pending" href="#proposals">' + proposals.length + ' proposed change' + (proposals.length === 1 ? '' : 's') + '</a>' : '') + '</div>';
    hero += '</div>';
    var adding = form && form.kind === 'add';
    body.innerHTML = hero + '<main>' +
      (notice ? '<p class="gd-notice">' + esc(notice) + '</p>' : '') +
      contentsHtml() +
      parts().map(partHtml).join('') +
      (adding ? '<section class="guide-part">' + partFormHtml(null) + '</section>' :
        '<button type="button" class="event-add gd-add">' + (fullWrite ? '+ Add a part' : '+ Suggest a new part') + '</button>') +
      proposalsHtml() + '</main>';
    var open = body.querySelector('.guide-form');
    if (open) bindForm(open);
  }

  function closeForm(){ form = null; render(); }

  function bindForm(el){
    el.querySelector('.ev-cancel').addEventListener('click', closeForm);
    var save = el.querySelector('.ev-save');
    var v = function(c){ var f = el.querySelector(c); return f ? f.value : ''; };
    function run(change){
      if (new Blob([JSON.stringify(x.parts || []) + JSON.stringify(change)]).size > MAX_SIZE) { showError(el, 'That’s too much text for one guide.'); return; }
      save.disabled = true;
      submit(change).then(closeForm).catch(function(err){
        console.error('[BOLD Guides] saving failed', err);
        showError(el, 'Couldn’t save — try again.');
        save.disabled = false;
      });
    }
    function note(){ return v('.gd-note').trim(); }
    function needNote(){
      if (!fullWrite && !note()) { showError(el, 'Say what you changed and why, for whoever reviews it.'); return true; }
      return false;
    }
    if (form.kind === 'about') {
      save.addEventListener('click', function(){
        var after = { title: v('.gd-title').trim(), description: v('.gd-description').trim() };
        if (!after.title) { showError(el, 'Give the guide a title.'); return; }
        if (after.title === x.title && after.description === (x.description || '')) { closeForm(); return; }
        if (needNote()) return;
        run({ kind: 'about', partId: '', before: { title: x.title, description: x.description || '' }, after: after, note: note() });
      });
      return;
    }
    var p = form.kind === 'edit' ? part(form.id) : null;
    save.addEventListener('click', function(){
      var after = { title: v('.gd-title').trim(), body: v('.gd-body').replace(/\s+$/, '') };
      if (!after.title) { showError(el, 'Give the part a title.'); return; }
      if (!after.body.trim()) { showError(el, 'Write the part’s text.'); return; }
      if (p && after.title === p.title && after.body === p.body) { closeForm(); return; }
      if (needNote()) return;
      run(p ? { kind: 'edit', partId: p.id, before: { title: p.title, body: p.body }, after: after, note: note() } :
        { kind: 'add', partId: G.partId(), before: null, after: after, note: note() });
    });
    var rm = el.querySelector('.gd-remove');
    if (rm) rm.addEventListener('click', function(){
      if (needNote()) return;
      if (fullWrite && !window.confirm('Remove the part “' + p.title + '”? It stays in the history.')) return;
      run({ kind: 'remove', partId: p.id, before: { title: p.title, body: p.body }, after: null, note: note() });
    });
  }

  function bindNew(){
    var el = body.querySelector('.guide-form');
    var title = el.querySelector('.gd-title'), slugIn = el.querySelector('.gd-slug');
    var touched = false;
    slugIn.addEventListener('input', function(){ touched = true; });
    title.addEventListener('input', function(){ if (!touched) slugIn.value = G.slugify(title.value); });
    el.querySelector('.ev-cancel').addEventListener('click', function(){ location.href = 'guides.html'; });
    el.querySelector('.ev-save').addEventListener('click', function(){
      var t = title.value.trim(), s = slugIn.value.trim(), d = el.querySelector('.gd-description').value.trim();
      if (!t) { showError(el, 'Give the guide a title.'); return; }
      if (!G.SLUG.test(s) || s.length > 60) { showError(el, 'The name can only have lowercase letters, numbers and single hyphens.'); return; }
      var save = el.querySelector('.ev-save');
      save.disabled = true;
      var newRef = db.collection('guides').doc(s);
      newRef.get().then(function(snap){
        if (snap.exists) { showError(el, 'There’s already a guide called ' + s + '.'); save.disabled = false; return; }
        var now = Date.now();
        return newRef.set(Object.assign({ slug: s, title: t, description: d, parts: [], createdAt: now, createdBy: me.email }, stamp('Added the guide')))
          .then(function(){ location.replace('guide.html?guide=' + encodeURIComponent(s)); });
      }).catch(function(err){
        console.error('[BOLD Guides] adding the guide failed', err);
        showError(el, 'Couldn’t add the guide — try again.');
        save.disabled = false;
      });
    });
  }

  function move(id, by){
    var list = parts().slice(), i = list.map(function(p){ return p.id; }).indexOf(id), j = i + by;
    if (!fullWrite || i < 0 || j < 0 || j >= list.length) return;
    var p = list[i];
    list[i] = list[j]; list[j] = p;
    ref.update(Object.assign({ parts: list }, stamp('Moved “' + p.title + '” ' + (by < 0 ? 'up' : 'down'))))
      .catch(function(err){ console.error('[BOLD Guides] moving a part failed', err); window.alert('Couldn’t move it — try again.'); });
  }

  body.addEventListener('click', function(e){
    var t = e.target.closest('button');
    if (!t || t.disabled || !x || !me) return;
    var id = t.getAttribute('data-id');
    if (t.classList.contains('gd-about')) { notice = ''; form = { kind: 'about' }; render(); }
    else if (t.classList.contains('gd-edit')) { notice = ''; form = { kind: 'edit', id: id }; render(); var f = document.getElementById('p-' + id); if (f) f.scrollIntoView({ block: 'start' }); }
    else if (t.classList.contains('gd-add')) { notice = ''; form = { kind: 'add' }; render(); body.querySelector('.guide-form .gd-title').focus(); }
    else if (t.classList.contains('gd-up')) move(id, -1);
    else if (t.classList.contains('gd-down')) move(id, 1);
    else if (t.classList.contains('gd-delete')) {
      if (!fullWrite || !window.confirm('Delete the guide “' + x.title + '” for good?')) return;
      // Stamp who's deleting it first: the history credits the last updatedBy.
      ref.update(stamp('')).then(function(){
        return ref.collection('proposals').get();
      }).then(function(snap){
        var batch = db.batch();
        snap.docs.forEach(function(d){ batch.delete(d.ref); });
        batch.delete(ref);
        return batch.commit();
      }).then(function(){ location.href = 'guides.html'; }).catch(function(err){
        console.error('[BOLD Guides] deleting the guide failed', err);
        window.alert('Couldn’t delete the guide — try again.');
      });
    } else {
      var li = t.closest('.gd-proposal');
      var q = li && proposals.filter(function(p){ return p.id === li.getAttribute('data-id'); })[0];
      if (!q) return;
      var job = null;
      if (t.classList.contains('gd-accept') && fullWrite) job = decide(q, true);
      else if (t.classList.contains('gd-decline') && fullWrite && window.confirm('Decline this proposed change?')) job = decide(q, false);
      else if (t.classList.contains('gd-withdraw') && window.confirm('Withdraw your proposed change?')) job = ref.collection('proposals').doc(q.id).delete();
      if (job) {
        t.disabled = true;
        job.catch(function(err){
          console.error('[BOLD Guides] updating a proposal failed', err);
          window.alert('Couldn’t do that — try again.');
          t.disabled = false;
        });
      }
    }
  });

  function drawHistory(){
    var on = !!x && !isNew;
    historyWrap.hidden = !on;
    if (!on || histPanel) return;
    histPanel = BoldHistory.mount(document.getElementById('guideHistory'), {
      ref: ref,
      fields: {},
      flatten: flatten,
      canRestore: function(){ return fullWrite; },
      restore: function(v){
        return ref.update(Object.assign({ title: v.data.title || '', description: v.data.description || '', parts: v.data.parts || [] },
          stamp('Restored the version of ' + BoldHistory.when(v.at))));
      },
    });
  }

  var unsubs = [], signIns = 0;
  if (isNew) {
    BOLD.onUser(function(user){
      var mine = ++signIns;
      me = user ? { email: user.email || '', name: user.displayName || '' } : null;
      if (user) G.access(function(ok){ if (mine === signIns) { fullWrite = ok; loaded = true; render(); } });
    });
    return;
  }
  if (!ref) { loaded = true; render(); return; }
  // Don't redraw over a form being filled in.
  function refresh(){ if (!form) render(); }
  BOLD.onUser(function(user){
    var mine = ++signIns;
    unsubs.forEach(function(u){ u(); }); unsubs = [];
    me = user ? { email: user.email || '', name: user.displayName || '' } : null;
    fullWrite = false;
    if (!user) return;
    G.access(function(ok){ if (mine === signIns) { fullWrite = ok; refresh(); } });
    unsubs.push(ref.onSnapshot(function(snap){
      loaded = true;
      x = snap.exists ? Object.assign({}, snap.data(), { slug: slug }) : null;
      refresh();
    }, function(err){
      console.error('[BOLD Guides] loading the guide failed', err);
      loaded = true; x = null; render();
    }));
    unsubs.push(ref.collection('proposals').where('status', '==', 'open').onSnapshot(function(snap){
      proposals = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); })
        .sort(function(a, b){ return a.at - b.at; });
      refresh();
    }, function(err){ console.error('[BOLD Guides] loading proposed changes failed', err); }));
  });
})();
