// "Changed since you last read" for a document with a history (history.js).
// Each person's read point, the version they last marked as read, is kept in
// readPoints/{uid}/docs/{key}: { version, at, readAt }, which only they can read
// or write (firestore.rules). Until they mark the document read again, the page
// shows what changed between that version and the document now: a one-line
// summary, and on request each changed part and the parts moved to another section.
// The read point moves only when they click Mark as read.
//
// Who has read the document is public to the lab: marking it read also writes
// <doc>/readers/{uid}: { email, name, version, at, readAt } (firestore.rules:
// lab members read them, each person writes only their own), listed under
// "Read by" (readersHtml): how many are up to date with the latest version or on
// an earlier one, and their names on request.
//
// BoldReadPoint.create({ ref, key, anchor: part → its element id, onChange })
// → { start(user), stop(), html(doc), readersHtml(), click(event) → true if it handled it }.
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
      if (partText(b) === partText(p)) {
        // Only moved: listed with the others moved to the same section.
        if (moved) out.push({ label: p.title, href: anchor(p), movedTo: p.section || 'no section' });
        return;
      }
      out.push({ label: p.title, what: moved ? 'changed, and moved to ' + (p.section || 'no section') : 'changed', href: anchor(p),
        diff: BoldHistory.diffHtml(partText(b), partText(p)) });
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
    var mine = null, myReader = null, me = null, unsubs = [];
    var readers = [], readersLoaded = false, readersOpen = false;
    var point = null, pointLoaded = false, latest = null, base = null, edits = [];
    var open = false, busy = false, error = '';

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
      unsubs = []; mine = null; myReader = null; me = null;
      readers = []; readersLoaded = false;
      point = null; pointLoaded = false; latest = null; base = null; edits = []; error = '';
    }

    function start(user){
      stop();
      if (!user) return;
      me = { email: user.email || '', name: user.displayName || '' };
      mine = db.collection('readPoints').doc(user.uid).collection('docs').doc(opts.key);
      myReader = opts.ref.collection('readers').doc(user.uid);
      unsubs.push(mine.onSnapshot(function(snap){
        point = snap.exists ? snap.data() : null;
        pointLoaded = true;
        loadBase();
        backfill();
        changed();
      }, fail('loading your read point')));
      unsubs.push(opts.ref.collection('readers').onSnapshot(function(snap){
        readers = snap.docs.map(function(d){ return Object.assign({ uid: d.id }, d.data()); });
        readersLoaded = true;
        backfill();
        changed();
      }, fail('loading who has read it')));
      unsubs.push(opts.ref.collection('versions').orderBy('at', 'desc').limit(1).onSnapshot(function(snap){
        var was = latest && latest.id;
        latest = snap.empty ? null : Object.assign({ id: snap.docs[0].id }, snap.docs[0].data());
        if (point && latest && latest.id !== was) loadBase();
        changed();
      }, fail('loading the latest version')));
    }

    // Someone who marked it read before readers were listed: list them now, as of that read.
    var backfilled = false;
    function backfill(){
      if (backfilled || !point || !readersLoaded || !myReader || !me.email) return;
      if (readers.some(function(r){ return r.uid === myReader.id; })) return;
      backfilled = true;
      myReader.set(readerOf(point)).catch(fail('listing you as a reader'));
    }
    function readerOf(p){ return { email: me.email, name: me.name, version: p.version, at: p.at, readAt: p.readAt || p.at }; }

    // Who has read it: up to date, or as of an earlier version.
    function readersHtml(){
      if (!readersLoaded || !latest) return '';
      var name = function(r){ return r.name || r.email; };
      var byName = function(a, b){ return name(a).localeCompare(name(b), undefined, { numeric: true, sensitivity: 'base' }); };
      var current = readers.filter(function(r){ return r.version === latest.id; }).sort(byName);
      var earlier = readers.filter(function(r){ return r.version !== latest.id; }).sort(byName);
      var day = function(ms){ return BoldHistory.when(ms).replace(/,.*$/, ''); };
      var count = function(n, what){ return n + (n === 1 ? ' person ' : ' people ') + what; };
      var summary = [current.length ? count(current.length, 'up to date') : '', earlier.length ? earlier.length + ' on an earlier version' : '']
        .filter(Boolean).join(', ');
      // Collapsed to the counts, as the history is to its latest versions.
      var body = !readers.length ? '<p class="rp-readers">Nobody has marked it as read yet.</p>' :
        '<p class="rp-readers">' + esc(summary) + '. <button type="button" class="btn-text rp-readers-more">' + (readersOpen ? 'Hide names' : 'Show names') + '</button></p>' +
        (!readersOpen ? '' : (current.length ? '<p class="rp-readers"><span class="rp-readers-label">Up to date</span>' + current.map(function(r){ return esc(name(r)); }).join(', ') + '</p>' : '') +
        (earlier.length ? '<p class="rp-readers"><span class="rp-readers-label">Read an earlier version</span>' + earlier.map(function(r){ return esc(name(r)) + ' <span class="rp-readers-when">(' + esc(day(r.readAt || r.at)) + ')</span>'; }).join(', ') + '</p>' : ''));
      return '<section class="block" id="readers"><div class="block-head"><h2>Read by</h2></div>' + body + '</section>';
    }

    function markButton(){
      return '<button type="button" class="btn-text rp-mark"' + (busy ? ' disabled' : '') + '>Mark as read</button>';
    }

    // In a box of its own, apart from the document.
    function html(doc){
      var inner = innerHtml(doc);
      return inner ? '<aside class="read-point" aria-label="Your reading">' + inner + '</aside>' : '';
    }

    function innerHtml(doc){
      if (!doc || !pointLoaded || !latest) return '';
      var err = error ? '<p class="ev-error">' + esc(error) + '</p>' : '';
      if (!point) return '<p class="rp-line">Not marked as read yet. ' + markButton() + '</p>' + err;
      if (!base) return '';
      var list = base.missing ? [] : changes(base.data || {}, doc, opts.anchor);
      var read = BoldHistory.when(point.readAt || point.at);
      // Edits since that changed nothing in the end (undone, say): marking it read
      // again moves them to the latest version in "Read by".
      if (!list.length) return '<p class="rp-line">No changes since you last read it, on ' + esc(read) + '.' +
        (point.version !== latest.id ? ' ' + markButton() : '') + '</p>' + err;
      var who = edits.map(function(v){ return v.by ? (v.by.name || v.by.email) : ''; })
        .filter(function(n, i, all){ return n && all.indexOf(n) === i; });
      var count = edits.length >= MAX_EDITS ? MAX_EDITS + '+ edits' : edits.length === 1 ? '1 edit' : edits.length + ' edits';
      var link = function(c){ return c.href ? '<a href="#' + esc(c.href) + '">' + esc(c.label) + '</a>' : esc(c.label); };
      var moves = list.filter(function(c){ return c.movedTo !== undefined; });
      var rest = list.filter(function(c){ return c.movedTo === undefined; });
      var what = [];
      if (rest.length) what.push(rest.length === 1 ? '1 part changed' : rest.length + ' parts changed');
      if (moves.length) what.push(moves.length === 1 ? '1 moved' : moves.length + ' moved');
      // The moves, one line per section they went to.
      var to = moves.map(function(c){ return c.movedTo; }).filter(function(v, i, all){ return all.indexOf(v) === i; });
      var movesHtml = to.map(function(sec){
        return '<p class="rp-moves">Moved to ' + esc(sec) + ': ' + moves.filter(function(c){ return c.movedTo === sec; }).map(link).join(', ') + '</p>';
      }).join('');
      return '<div class="block-head"><h2>Changed since you last read</h2></div>' +
        '<p class="rp-line">' + (edits.length ? count + ' since ' + esc(read) + (who.length ? ', by ' + esc(names(who)) : '') + ': ' : '') + what.join(', ') + '. ' +
          '<button type="button" class="btn-text rp-toggle">' + (open ? 'Hide changes' : 'Show changes') + '</button>' + markButton() + '</p>' + err +
        (open ? '<div class="rp-changes">' + rest.map(function(c){
          return '<div class="hist-field"><p class="hist-label">' + link(c) + (c.what ? ' · ' + esc(c.what) : '') + '</p>' + c.diff + '</div>';
        }).join('') + movesHtml + '</div>' : '');
    }

    function click(e){
      var t = e.target.closest('.rp-toggle, .rp-mark, .rp-readers-more');
      if (!t) return false;
      if (t.classList.contains('rp-readers-more')) { readersOpen = !readersOpen; changed(); return true; }
      if (t.classList.contains('rp-toggle')) { open = !open; changed(); return true; }
      if (busy || !mine || !latest) return true;
      busy = true; error = ''; changed();
      var p = { version: latest.id, at: latest.at, readAt: Date.now() };
      var batch = db.batch();
      batch.set(mine, p);
      if (me.email) batch.set(myReader, readerOf(p));
      batch.commit().then(function(){
        busy = false; changed();
      }).catch(function(err){
        console.error('[BOLD Read point] marking as read failed', err);
        busy = false; error = 'Couldn’t mark it as read — try again.'; changed();
      });
      return true;
    }

    return { start: start, stop: stop, html: html, inner: innerHtml, readersHtml: readersHtml, click: click };
  }

  return { create: create };
})();
