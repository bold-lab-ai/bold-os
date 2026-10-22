// Comments on a guide or the BOLDiquette (pages/guide.js): select some text in a
// part and comment on it. Each comment is <doc>/comments/{id}:
// { partId, quote, prefix, suffix, text, by: { email, name }, at, parent?, resolved?,
//   resolvedBy?, resolvedAt? } (firestore.rules: the lab reads and comments; the
// author edits their text; the author or a PI/admin resolves or deletes). A reply has
// the thread's first comment as its parent. A comment on a proposed change has
// { proposalId, partId: '' } instead of a quote: its discussion, listed under the
// proposal (proposalThreadHtml).
//
// The quoted text is highlighted where it still is in the part (prefix and suffix
// pick the right one when it's there more than once), with an icon in the right
// margin level with it; either opens the thread as a card. A thread whose text has
// since changed shows at the top of its part, marked so. Resolved threads don't show.
//
// BoldComments.create({ ref, root, fullWrite: () => bool, onChange })
// → { start(user), stop(), decorate(), click(event) → true if it handled it, ready(), show(id), openCount() }.
// A link to a comment (#c=<id>, as Slack sends; pages/guide.js) opens its thread and marks it.
window.BoldComments = (function(){
  var esc = BOLD.escapeHtml;
  var CONTEXT = 32, MAX_QUOTE = 500, MAX_TEXT = 2000;
  var BUBBLE = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>';

  // The visible text of el, and its text nodes with where each starts in it.
  function textMap(el){
    var nodes = [], text = '', w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), n;
    while ((n = w.nextNode())) { nodes.push({ node: n, start: text.length }); text += n.nodeValue; }
    return { text: text, nodes: nodes };
  }
  // Where in el's text the comment is → { start, end, changed } or null: the quote itself
  // (the occurrence whose context matches best); else, if the text was edited since,
  // the stretch between its old context (the text just before and after it); else the
  // longest run of its words still there (half the quote at least). `changed`: not
  // the quote as it was.
  function find(map, c){
    var q = String(c.quote || '');
    if (!q) return null;
    var at = locate(map, c);
    if (at !== -1) return { start: at, end: at + q.length, changed: false };
    var t = map.text, pre = String(c.prefix || '').slice(-16), suf = String(c.suffix || '').slice(0, 16);
    if (pre.length >= 6 && suf.length >= 6) {
      var a = t.indexOf(pre), b = a === -1 ? -1 : t.indexOf(suf, a + pre.length);
      if (a !== -1 && t.indexOf(pre, a + 1) === -1 && b !== -1) {
        var s = a + pre.length, len = b - s;
        if (len > 0 && len <= q.length * 3 + 40 && len >= q.length / 3) return trim(t, s, b);
      }
    }
    var words = q.split(/(\s+)/), best = null;
    for (var i = 0; i < words.length; i += 2) {
      for (var j = words.length; j > i; j -= 2) {
        var piece = words.slice(i, j).join('').trim();
        if (piece.length < Math.max(8, q.length / 2) || (best && piece.length <= best.end - best.start)) break;
        var k = t.indexOf(piece);
        if (k !== -1) { best = { start: k, end: k + piece.length, changed: true }; break; }
      }
    }
    return best;
  }
  // The stretch from s to e without the spaces at its ends.
  function trim(t, s, e){
    while (s < e && /\s/.test(t[s])) s++;
    while (e > s && /\s/.test(t[e - 1])) e--;
    return e > s ? { start: s, end: e, changed: true } : null;
  }
  // Where in el's text the quote is: the occurrence whose context matches best, or -1.
  function locate(map, c){
    var best = -1, score = -1, from = 0, at;
    while (c.quote && (at = map.text.indexOf(c.quote, from)) !== -1) {
      var before = map.text.slice(Math.max(0, at - CONTEXT), at), after = map.text.slice(at + c.quote.length, at + c.quote.length + CONTEXT);
      var s = common(before, c.prefix || '', true) + common(after, c.suffix || '', false);
      if (s > score) { score = s; best = at; }
      from = at + 1;
    }
    return best;
  }
  function common(a, b, fromEnd){
    var n = 0;
    while (n < a.length && n < b.length && (fromEnd ? a[a.length - 1 - n] === b[b.length - 1 - n] : a[n] === b[n])) n++;
    return n;
  }
  // Wraps el's text from start to end in <mark>s (one per text node it spans) → the marks.
  function wrap(map, start, end, id){
    var marks = [];
    map.nodes.forEach(function(t){
      var a = Math.max(start, t.start), b = Math.min(end, t.start + t.node.nodeValue.length);
      if (a >= b) return;
      var range = document.createRange();
      range.setStart(t.node, a - t.start); range.setEnd(t.node, b - t.start);
      var m = document.createElement('mark');
      m.className = 'cm-mark'; m.setAttribute('data-thread', id);
      try { range.surroundContents(m); marks.push(m); } catch (e){}
    });
    return marks;
  }

  function create(opts){
    var db = opts.ref.firestore, col = opts.ref.collection('comments');
    var me = null, unsub = null, comments = [], loaded = false;
    var open = null;          // the thread open: a comment id, or 'new'
    var moved = {};           // threads found on text edited since (find): their card says so
    var pending = null;       // a new comment's anchor: { partId, quote, prefix, suffix }
    var drafts = {};          // what's typed, by thread ('new' too), across re-renders
    var busy = false, error = '';
    var editing = null, editError = '';  // the comment being edited, by its author
    var btn = null;           // the floating "Comment" button
    var target = null;        // the comment a link named (#c=), marked

    function changed(){ opts.onChange(); }
    function threads(){ return comments.filter(function(c){ return !c.parent && !c.resolved && !c.proposalId; }); }
    var boxOpen = {};         // proposals whose comment box is open
    function replies(id){ return comments.filter(function(c){ return c.parent === id; }).sort(function(a, b){ return a.at - b.at; }); }
    function byId(id){ return comments.filter(function(c){ return c.id === id; })[0] || null; }
    function mine(c){ return me && c.by && c.by.email === me.email; }

    function stop(){ if (unsub) unsub(); unsub = null; comments = []; loaded = false; open = null; pending = null; hideButton(); }
    function start(user){
      stop();
      if (!user) return;
      me = { email: user.email || '', name: user.displayName || '' };
      unsub = col.onSnapshot(function(snap){
        comments = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
        loaded = true;
        if (open && open !== 'new' && !byId(open)) open = null;
        changed();
      }, function(err){ console.error('[BOLD Comments] loading the comments failed', err); });
    }

    // ---------- selecting text ----------
    function hideButton(){ if (btn) { btn.remove(); btn = null; } }
    function partOf(node){
      var el = node && (node.nodeType === 1 ? node : node.parentNode);
      var text = el && el.closest && el.closest('.guide-part[data-pid] .guide-text');
      return text ? { text: text, partId: text.closest('.guide-part').getAttribute('data-pid') } : null;
    }
    function onSelect(){
      var sel = window.getSelection();
      if (!me || !sel || sel.isCollapsed || !sel.rangeCount) { hideButton(); return; }
      var r = sel.getRangeAt(0), a = partOf(r.startContainer), b = partOf(r.endContainer);
      if (!a || !b || a.text !== b.text || opts.root.querySelector('.guide-form, .gd-viewing')) { hideButton(); return; }
      var quote = sel.toString();
      if (!quote.trim() || quote.length > MAX_QUOTE) { hideButton(); return; }
      // Where it starts in the part's text, for its context.
      var pre = document.createRange(); pre.setStart(a.text, 0); pre.setEnd(r.startContainer, r.startOffset);
      var start = pre.toString().length, map = textMap(a.text);
      var anchor = { partId: a.partId, quote: quote, prefix: map.text.slice(Math.max(0, start - CONTEXT), start), suffix: map.text.slice(start + quote.length, start + quote.length + CONTEXT) };
      var box = r.getBoundingClientRect();
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'cm-add';
        btn.innerHTML = BUBBLE + 'Comment';
        btn.addEventListener('mousedown', function(e){ e.preventDefault(); });
        document.body.appendChild(btn);
      }
      btn.onclick = function(){
        pending = anchor; open = 'new'; error = '';
        hideButton(); window.getSelection().removeAllRanges();
        changed();
      };
      btn.style.top = (box.top + window.scrollY - 38) + 'px';
      btn.style.left = (box.left + window.scrollX + box.width / 2) + 'px';
    }
    document.addEventListener('selectionchange', function(){ clearTimeout(onSelect.t); onSelect.t = setTimeout(onSelect, 150); });

    // ---------- on the page ----------
    // After each render of the parts: highlights, margin icons, and the open card.
    function decorate(){
      if (!loaded || opts.root.querySelector('.gd-viewing')) return;
      var list = threads();
      Array.prototype.forEach.call(opts.root.querySelectorAll('.guide-part[data-pid]'), function(part){
        var pid = part.getAttribute('data-pid'), text = part.querySelector('.guide-text');
        var here = list.filter(function(c){ return c.partId === pid; });
        if (pending && open === 'new' && pending.partId === pid) here = here.concat([Object.assign({ id: 'new' }, pending)]);
        if (!here.length) return;
        var rows = {}, lost = [];
        here.forEach(function(c){
          var marks = [];
          if (text) {
            var map = textMap(text), at = find(map, c);
            if (at) marks = wrap(map, at.start, at.end, c.id);
            moved[c.id] = !!(at && at.changed);
          }
          if (!marks.length) { lost.push(c); return; }
          if (c.id === open) marks.forEach(function(m){ m.classList.add('is-open'); });
          // One icon per line of text: threads on the same line share it.
          var top = Math.round(marks[0].getBoundingClientRect().top - part.getBoundingClientRect().top);
          var key = Math.round(top / 8);
          (rows[key] = rows[key] || { top: top, ids: [] }).ids.push(c.id);
        });
        // Beside the title: threads on a folded part, and (marked) those whose text changed.
        var head = part.querySelector('.guide-part-head');
        if (lost.length) rows.lost = { top: head ? head.offsetTop : 0, ids: lost.map(function(c){ return c.id; }), lost: !!text };
        Object.keys(rows).forEach(function(k){
          var row = rows[k], n = row.ids.filter(function(id){ return id !== 'new'; }).reduce(function(s, id){ return s + 1 + replies(id).length; }, 0);
          var b = document.createElement('button');
          b.type = 'button'; b.className = 'cm-icon' + (row.ids.indexOf(open) !== -1 ? ' is-open' : '');
          b.setAttribute('data-threads', row.ids.join(' '));
          b.setAttribute('aria-label', n + (n === 1 ? ' comment' : ' comments'));
          b.title = row.lost ? 'Comments on text that has since changed' : (n === 1 ? '1 comment' : n + ' comments');
          b.innerHTML = BUBBLE + (n ? '<span>' + n + '</span>' : '');
          b.style.top = row.top + 'px';
          part.appendChild(b);
          if (row.ids.indexOf(open) !== -1) fit(part, part.appendChild(card(row, open)));
        });
      });
      var ta = opts.root.querySelector('.cm-card textarea');
      if (ta && open === 'new' && document.activeElement !== ta) ta.focus();
    }

    // The card right of the text if it fits on screen; shifted left if not; on a
    // narrow screen, across the bottom of it.
    function fit(part, el){
      var p = part.getBoundingClientRect(), r = el.getBoundingClientRect(), room = window.innerWidth - 12;
      if (r.right <= room) return;
      var left = room - r.width - p.left;
      if (left < 0 || window.innerWidth < 700) el.classList.add('is-sheet');
      else el.style.left = left + 'px';
    }

    function when(ms){ return BoldHistory.when(ms); }
    // A comment's author edits its text in place (editing: its id; drafts['e:' + id]).
    function metaHtml(c){
      return '<strong>' + esc(c.by ? (c.by.name || c.by.email) : 'Someone') + '</strong> ' + esc(when(c.at)) + (c.editedAt ? ' · edited' : '');
    }
    function editBoxHtml(c){
      var key = 'e:' + c.id;
      return '<textarea rows="3" maxlength="' + MAX_TEXT + '" data-key="' + esc(key) + '">' + esc(key in drafts ? drafts[key] : c.text) + '</textarea>' +
        (editError ? '<p class="ev-error">' + esc(editError) + '</p>' : '') +
        '<div class="cm-buttons"><button type="button" class="btn-box is-primary cm-e-save" data-id="' + esc(c.id) + '"' + (busy ? ' disabled' : '') + '>Save</button>' +
        '<button type="button" class="btn-text cm-e-cancel" data-id="' + esc(c.id) + '">Cancel</button></div>';
    }
    function editButton(c){ return mine(c) ? '<button type="button" class="btn-text cm-edit" data-id="' + esc(c.id) + '">Edit</button>' : ''; }
    function commentHtml(c){
      if (editing === c.id) return '<div class="cm-comment"><p class="cm-meta">' + metaHtml(c) + '</p>' + editBoxHtml(c) + '</div>';
      var can = mine(c) || opts.fullWrite();
      return '<div class="cm-comment' + (c.id === target ? ' is-target' : '') + '" data-cid="' + esc(c.id) + '"><p class="cm-meta">' + metaHtml(c) + '</p>' +
        '<p class="cm-text">' + BoldMarkdown.plain(c.text) + '</p>' +
        (can ? '<p class="cm-actions">' + editButton(c) +
          '<button type="button" class="btn-text danger cm-delete" data-id="' + esc(c.id) + '">Delete</button></p>' : '') + '</div>';
    }
    // The open thread (or the new comment), beside the icon.
    function card(row, id){
      var el = document.createElement('div');
      el.className = 'cm-card'; el.style.top = row.top + 'px';
      var c = id === 'new' ? pending : byId(id);
      var others = row.ids.filter(function(x){ return x !== id; });
      var key = id;
      // Resolving closes the whole thread: at its top, beside ×.
      var resolvable = id !== 'new' && (mine(c) || opts.fullWrite());
      if (resolvable) el.classList.add('has-resolve');
      el.innerHTML = '<button type="button" class="cm-close" aria-label="Close">×</button>' +
        (resolvable ? '<button type="button" class="btn-text cm-resolve" data-id="' + esc(id) + '" title="Close the thread; it stays in the history">Resolve</button>' : '') +
        (row.lost ? '<p class="cm-lost">The text this was on has since changed.</p>' : moved[id] ? '<p class="cm-lost">The text has been edited since; the comment was on:</p>' : '') +
        '<blockquote class="cm-quote">' + esc(String(c.quote || '').length > 160 ? c.quote.slice(0, 160) + '…' : String(c.quote || '')) + '</blockquote>' +
        (id === 'new' ? '' : commentHtml(c) + replies(id).map(function(r){ return commentHtml(r); }).join('')) +
        '<textarea rows="3" maxlength="' + MAX_TEXT + '" placeholder="' + (id === 'new' ? 'Your comment' : 'Reply') + '" data-key="' + esc(key) + '">' + esc(drafts[key] || '') + '</textarea>' +
        (error ? '<p class="ev-error">' + esc(error) + '</p>' : '') +
        '<div class="cm-buttons"><button type="button" class="btn-box is-primary cm-send"' + (busy ? ' disabled' : '') + '>' + (id === 'new' ? 'Comment' : 'Reply') + '</button>' +
          '<button type="button" class="btn-text cm-cancel">Cancel</button></div>' +
        (others.length ? '<p class="cm-more">' + others.length + ' more on this line: ' + others.map(function(o, i){
          return '<button type="button" class="btn-text cm-switch" data-id="' + esc(o) + '">' + (i + 1) + '</button>'; }).join(' ') + '</p>' : '');
      return el;
    }

    // ---------- a proposed change's discussion ----------
    function proposalThreadHtml(pid){
      var list = comments.filter(function(c){ return c.proposalId === pid; }).sort(function(a, b){ return a.at - b.at; });
      var key = 'p:' + pid;
      return '<div class="cm-discussion">' + list.map(function(c){
          if (editing === c.id) return '<div class="cm-comment"><p class="cm-meta">' + metaHtml(c) + '</p>' + editBoxHtml(c) + '</div>';
          return '<div class="cm-comment' + (c.id === target ? ' is-target' : '') + '" data-cid="' + esc(c.id) + '"><p class="cm-meta">' + metaHtml(c) +
            (mine(c) ? ' ' + editButton(c) : '') +
            (mine(c) || opts.fullWrite() ? ' <button type="button" class="btn-text danger cm-delete" data-id="' + esc(c.id) + '">Delete</button>' : '') + '</p>' +
            '<p class="cm-text">' + BoldMarkdown.plain(c.text) + '</p></div>';
        }).join('') +
        (boxOpen[key] ? '<textarea rows="3" maxlength="' + MAX_TEXT + '" placeholder="Your comment" data-key="' + esc(key) + '">' + esc(drafts[key] || '') + '</textarea>' +
          (error && open === key ? '<p class="ev-error">' + esc(error) + '</p>' : '') +
          '<div class="cm-buttons"><button type="button" class="btn-box is-primary cm-p-send" data-pid="' + esc(pid) + '"' + (busy ? ' disabled' : '') + '>Comment</button>' +
          '<button type="button" class="btn-text cm-p-cancel" data-pid="' + esc(pid) + '">Cancel</button></div>' :
          '<button type="button" class="btn-text cm-p-open" data-pid="' + esc(pid) + '">' + (list.length ? 'Reply' : 'Comment') + '</button>') +
        '</div>';
    }
    // What's typed survives the page re-rendering.
    opts.root.addEventListener('input', function(e){
      var k = e.target.getAttribute && e.target.getAttribute('data-key');
      if (k && e.target.tagName === 'TEXTAREA') drafts[k] = e.target.value;
    });
    function sendOnProposal(pid){
      var key = 'p:' + pid, text = (drafts[key] || '').trim();
      open = key;
      if (!text) { error = 'Write something first.'; changed(); return; }
      busy = true; error = ''; changed();
      col.add({ partId: '', proposalId: pid, text: text, by: { email: me.email, name: me.name }, at: Date.now() }).then(function(){
        busy = false; drafts[key] = ''; boxOpen[key] = false; open = null; changed();
      }).catch(function(err){
        console.error('[BOLD Comments] saving the comment failed', err);
        busy = false; error = 'Couldn’t save it — try again.'; changed();
      });
    }

    // ---------- writing ----------
    function send(){
      var text = (drafts[open] || '').trim();
      if (!text) { error = 'Write something first.'; changed(); return; }
      busy = true; error = ''; changed();
      var base = { text: text, by: { email: me.email, name: me.name }, at: Date.now() };
      var doc = open === 'new' ? Object.assign(base, pending) : Object.assign(base, { parent: open, partId: byId(open).partId });
      var was = open;
      col.add(doc).then(function(r){
        busy = false; drafts[was] = '';
        if (was === 'new') { pending = null; open = r.id; }
        changed();
      }).catch(function(err){
        console.error('[BOLD Comments] saving the comment failed', err);
        busy = false; error = 'Couldn’t save it — try again.'; changed();
      });
    }
    function saveEdit(id){
      var key = 'e:' + id, c = byId(id), text = (key in drafts ? drafts[key] : c ? c.text : '').trim();
      if (!c) return;
      if (!text) { editError = 'Write something first.'; changed(); return; }
      if (text === c.text) { editing = null; delete drafts[key]; changed(); return; }
      busy = true; editError = ''; changed();
      col.doc(id).update({ text: text, editedAt: Date.now() }).then(function(){
        busy = false; editing = null; delete drafts[key]; changed();
      }).catch(function(err){
        console.error('[BOLD Comments] saving the edit failed', err);
        busy = false; editError = 'Couldn’t save it — try again.'; changed();
      });
    }
    // Cmd/Ctrl+Enter in a comment box sends it (or saves the edit).
    opts.root.addEventListener('keydown', function(e){
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || busy) return;
      var k = e.target.tagName === 'TEXTAREA' && e.target.getAttribute('data-key');
      if (!k) return;
      e.preventDefault();
      drafts[k] = e.target.value;
      if (k.indexOf('e:') === 0) saveEdit(k.slice(2));
      else if (k.indexOf('p:') === 0) sendOnProposal(k.slice(2));
      else if (k === open) send();
    });

    function resolve(id){
      col.doc(id).update({ resolved: true, resolvedBy: me.email, resolvedByName: me.name, resolvedAt: Date.now() }).then(function(){ if (open === id) open = null; changed(); })
        .catch(function(err){ console.error('[BOLD Comments] resolving failed', err); error = 'Couldn’t resolve it — try again.'; changed(); });
    }
    function remove(id){
      if (!window.confirm('Delete this comment?')) return;
      var c = byId(id), batch = db.batch();
      batch.delete(col.doc(id));
      // A thread's first comment takes its replies with it.
      if (c && !c.parent) replies(id).forEach(function(r){ batch.delete(col.doc(r.id)); });
      batch.commit().then(function(){ if (open === id) open = null; changed(); })
        .catch(function(err){ console.error('[BOLD Comments] deleting failed', err); error = 'Couldn’t delete it — try again.'; changed(); });
    }

    function click(e){
      var t = e.target.closest('.cm-icon, .cm-mark, .cm-close, .cm-cancel, .cm-send, .cm-resolve, .cm-delete, .cm-switch, .cm-p-open, .cm-p-send, .cm-p-cancel, .cm-edit, .cm-e-save, .cm-e-cancel');
      if (!t) return false;
      var pid = t.getAttribute('data-pid');
      if (t.classList.contains('cm-edit')) {
        editing = t.getAttribute('data-id'); delete drafts['e:' + editing]; editError = ''; changed();
        var box = opts.root.querySelector('textarea[data-key="e:' + editing + '"]');
        if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
        return true;
      }
      if (t.classList.contains('cm-e-save')) { saveEdit(t.getAttribute('data-id')); return true; }
      if (t.classList.contains('cm-e-cancel')) { delete drafts['e:' + editing]; editing = null; editError = ''; changed(); return true; }
      if (t.classList.contains('cm-p-open')) {
        boxOpen['p:' + pid] = true; error = ''; changed();
        var ta = opts.root.querySelector('textarea[data-key="p:' + pid + '"]'); if (ta) ta.focus();
        return true;
      }
      if (t.classList.contains('cm-p-cancel')) { boxOpen['p:' + pid] = false; if (open === 'p:' + pid) { open = null; error = ''; } changed(); return true; }
      if (t.classList.contains('cm-p-send')) { sendOnProposal(pid); return true; }
      if (t.classList.contains('cm-icon')) { var ids = t.getAttribute('data-threads').split(' '); open = ids.indexOf(open) !== -1 ? null : ids[0]; error = ''; changed(); }
      else if (t.classList.contains('cm-mark')) { open = t.getAttribute('data-thread'); error = ''; changed(); }
      else if (t.classList.contains('cm-close') || t.classList.contains('cm-cancel')) { if (open === 'new') pending = null; open = null; error = ''; changed(); }
      else if (t.classList.contains('cm-send')) send();
      else if (t.classList.contains('cm-resolve')) resolve(t.getAttribute('data-id'));
      else if (t.classList.contains('cm-delete')) remove(t.getAttribute('data-id'));
      else if (t.classList.contains('cm-switch')) { open = t.getAttribute('data-id'); changed(); }
      return true;
    }

    // Opens the thread comment id is in → where it is ({ partId, proposalId, resolved }), or null.
    function show(id){
      var c = byId(id);
      if (!c) return null;
      var root = (c.parent && byId(c.parent)) || c;
      target = id;
      if (!root.proposalId && !root.resolved) { open = root.id; error = ''; }
      return { partId: root.partId || '', proposalId: root.proposalId || null, resolved: !!root.resolved };
    }

    // Resolved threads, for the page's history (history.js extras): newest first there.
    function resolvedItems(){
      return comments.filter(function(c){ return !c.parent && c.resolved; }).map(function(c){
        var all = [c].concat(replies(c.id));
        return { id: c.id, at: c.resolvedAt || c.at,
          // A proposed change's discussion closes with it (resolvedWith: accepted, declined, withdrawn).
          head: c.resolvedWith ? 'Comment closed: its change was ' + esc(c.resolvedWith) + (c.resolvedWith !== 'withdrawn' && (c.resolvedByName || c.resolvedBy) ? ' by ' + esc(c.resolvedByName || c.resolvedBy) : '')
            : 'Comment resolved by ' + esc(c.resolvedByName || c.resolvedBy || 'someone'),
          msg: c.proposalId || !c.quote ? 'On a proposed change' : '“' + esc(c.quote.length > 80 ? c.quote.slice(0, 80) + '…' : c.quote) + '”',
          body: '<div class="cm-history">' + all.map(function(r){
            return '<p class="cm-meta"><strong>' + esc(r.by ? (r.by.name || r.by.email) : 'Someone') + '</strong> ' + esc(when(r.at)) + '</p><p class="cm-text">' + BoldMarkdown.plain(r.text) + '</p>';
          }).join('') + '</div>' };
      });
    }

    return { start: start, stop: stop, decorate: decorate, click: click, resolvedItems: resolvedItems, proposalThreadHtml: proposalThreadHtml,
      ready: function(){ return loaded; }, show: show,
      openCount: function(){ return comments.filter(function(c){ return !c.parent && !c.resolved; }).length; } };
  }

  return { create: create };
})();
