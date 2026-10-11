// "Changed since you last read" for a document with a history (history.js).
// Each person's read point, the version they last marked as read, is kept in
// readPoints/{uid}/docs/{key}: { version, at, readAt }, which only they can read
// or write (firestore.rules). Until they mark the document read again, the page
// shows what changed between that version and the document now, part by part.
// The read point moves only when they click Mark as read.
//
// BoldReadPoint.create({ ref, key, anchor: part → its element id, onChange })
// → { start(user), stop(), html(doc), click(event) → true if it handled it }.
window.BoldReadPoint = (function(){
  var esc = BOLD.escapeHtml;
  var MAX_EDITS = 20;

  function names(list){
    return list.length < 2 ? list.join('') : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  }
  function partText(p){ return (p.title || '') + '\n\n' + (p.body || ''); }

  // What changed from `before` to `after` (both whole documents) → [{ label, href, diff }].
  function changes(before, after, anchor){
    var out = [];
    if ((before.title || '') !== (after.title || '') || (before.description || '') !== (after.description || '')) {
      out.push({ label: 'Title and description', diff: BoldHistory.diffHtml((before.title || '') + '\n\n' + (before.description || ''), (after.title || '') + '\n\n' + (after.description || '')) });
    }
    var was = {};
    (before.parts || []).forEach(function(p){ was[p.id] = p; });
    var now = {};
    (after.parts || []).forEach(function(p){
      now[p.id] = p;
      var b = was[p.id];
      if (!b) { out.push({ label: p.title, what: 'new', href: anchor(p), diff: BoldHistory.diffHtml('', partText(p)) }); return; }
      var moved = (b.section || '') !== (p.section || '');
      if (partText(b) === partText(p) && !moved) return;
      out.push({ label: p.title, what: moved ? 'moved to ' + (p.section || 'no section') : 'changed', href: anchor(p),
        diff: partText(b) === partText(p) ? '' : BoldHistory.diffHtml(partText(b), partText(p)) });
    });
    (before.parts || []).forEach(function(p){
      if (!now[p.id]) out.push({ label: p.title, what: 'removed', diff: BoldHistory.diffHtml(partText(p), '') });
    });
    var order = function(list){ return (list || []).map(function(p){ return p.id; }).filter(function(id){ return was[id] && now[id]; }).join(); };
    if (!out.length && order(before.parts) !== order(after.parts)) out.push({ label: 'The order of the parts', what: 'changed', diff: '' });
    return out;
  }

  function create(opts){
    var db = opts.ref.firestore;
    var mine = null, unsubs = [];
    var point = null, pointLoaded = false, latest = null, base = null, edits = [];
    var open = true, busy = false, error = '';

    function changed(){ opts.onChange(); }
    function fail(what){
      return function(err){ console.error('[BOLD Read point] ' + what + ' failed', err); };
    }

    // The version the read point names, and the edits made since.
    function loadBase(){
      if (!point) { base = null; edits = []; return; }
      if (!base || base.id !== point.version) {
        opts.ref.collection('versions').doc(point.version).get().then(function(snap){
          base = snap.exists ? Object.assign({ id: snap.id }, snap.data()) : { id: point.version, missing: true };
          changed();
        }).catch(fail('loading the version you last read'));
      }
      opts.ref.collection('versions').where('at', '>', point.at).orderBy('at', 'desc').limit(MAX_EDITS).get().then(function(snap){
        edits = snap.docs.map(function(d){ return d.data(); });
        changed();
      }).catch(fail('loading the edits since'));
    }

    function stop(){
      unsubs.forEach(function(u){ u(); });
      unsubs = []; mine = null;
      point = null; pointLoaded = false; latest = null; base = null; edits = []; error = '';
    }

    function start(user){
      stop();
      if (!user) return;
      mine = db.collection('readPoints').doc(user.uid).collection('docs').doc(opts.key);
      unsubs.push(mine.onSnapshot(function(snap){
        point = snap.exists ? snap.data() : null;
        pointLoaded = true;
        loadBase();
        changed();
      }, fail('loading your read point')));
      unsubs.push(opts.ref.collection('versions').orderBy('at', 'desc').limit(1).onSnapshot(function(snap){
        var was = latest && latest.id;
        latest = snap.empty ? null : Object.assign({ id: snap.docs[0].id }, snap.docs[0].data());
        if (point && latest && latest.id !== was) loadBase();
        changed();
      }, fail('loading the latest version')));
    }

    function markButton(){
      return '<button type="button" class="btn-text rp-mark"' + (busy ? ' disabled' : '') + '>Mark as read</button>';
    }

    function html(doc){
      if (!doc || !pointLoaded || !latest) return '';
      var err = error ? '<p class="ev-error">' + esc(error) + '</p>' : '';
      if (!point) return '<p class="rp-line">Not marked as read yet. ' + markButton() + '</p>' + err;
      if (!base) return '';
      var list = base.missing ? [] : changes(base.data || {}, doc, opts.anchor);
      var read = BoldHistory.when(point.readAt || point.at);
      if (!list.length) return '<p class="rp-line">No changes since you last read it, on ' + esc(read) + '.</p>';
      var who = edits.map(function(v){ return v.by ? (v.by.name || v.by.email) : ''; })
        .filter(function(n, i, all){ return n && all.indexOf(n) === i; });
      var count = edits.length >= MAX_EDITS ? MAX_EDITS + '+ edits' : edits.length === 1 ? '1 edit' : edits.length + ' edits';
      return '<section class="block read-point"><div class="block-head"><h2>Changed since you last read</h2></div>' +
        '<p class="rp-line">' + (edits.length ? count + ' since ' + esc(read) + (who.length ? ', by ' + esc(names(who)) : '') + '. ' : '') +
          '<button type="button" class="btn-text rp-toggle">' + (open ? 'Hide changes' : 'Show changes') + '</button>' + markButton() + '</p>' + err +
        (open ? list.map(function(c){
          var title = c.href ? '<a href="#' + esc(c.href) + '">' + esc(c.label) + '</a>' : esc(c.label);
          return '<div class="hist-field"><p class="hist-label">' + title + (c.what ? ' · ' + esc(c.what) : '') + '</p>' + c.diff + '</div>';
        }).join('') : '') +
        '</section>';
    }

    function click(e){
      var t = e.target.closest('.rp-toggle, .rp-mark');
      if (!t) return false;
      if (t.classList.contains('rp-toggle')) { open = !open; changed(); return true; }
      if (busy || !mine || !latest) return true;
      busy = true; error = ''; changed();
      mine.set({ version: latest.id, at: latest.at, readAt: Date.now() }).then(function(){
        busy = false; changed();
      }).catch(function(err){
        console.error('[BOLD Read point] marking as read failed', err);
        busy = false; error = 'Couldn’t mark it as read — try again.'; changed();
      });
      return true;
    }

    return { start: start, stop: stop, html: html, click: click };
  }

  return { create: create };
})();
