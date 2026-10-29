// A board card's conversation, on its own page (project-work.js): its comments, oldest
// first, and a box to add one. projectWorkspaces/{pid}/work/{id}/comments/{cid}
// { text (Markdown, @ to tag), by: { email, name }, at, editedAt? } (firestore.rules):
// whoever sees the board reads and comments; the author edits or deletes theirs, PIs and
// admins delete any. onCardCommented (functions/index.js) tells whoever made the card, its
// assignees and whoever has commented, one Slack message each a few minutes later; so
// posting asks first. &c=<id> in the address (as Slack sends) scrolls to that comment.
// BoldCardTalk.create(ref, { me: () => user, fullWrite: () => bool, card: () => card })
// → { el, stop() }; el is kept between the page's redraws, so a comment being written stays.
window.BoldCardTalk = (function(){
  var esc = BOLD.escapeHtml, MAX = 2000;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var pad = function(n){ return (n < 10 ? '0' : '') + n; };
  function when(ms){ var d = new Date(ms); return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  function create(ref, o){
    var el = document.createElement('div');
    el.className = 'detail-abstract wk-talk';
    el.innerHTML = '<div class="detail-abstract-label">Conversation</div><ul class="wk-talk-list"></ul>' +
      '<form class="wk-talk-form" novalidate>' +
      '<textarea aria-label="Add a comment" class="wk-talk-text" rows="3" maxlength="' + MAX + '" placeholder="Add a comment: Markdown, @ to tag someone"></textarea>' +
      '<div class="field-error wk-talk-error" hidden></div>' +
      '<div class="stage-fields-actions"><button class="btn" type="submit">Comment</button></div></form>';
    var listEl = el.querySelector('.wk-talk-list'), form = el.querySelector('.wk-talk-form'), box = form.querySelector('textarea'), error = form.querySelector('.wk-talk-error');
    var list = [], loaded = false, editing = null, busy = false, marked = (/[#&]c=([^&]+)/.exec(location.hash) || [])[1] || '';
    marked = marked ? decodeURIComponent(marked) : '';

    function me(){ var m = o.me(); return m && m.email ? m.email.toLowerCase() : ''; }
    // Who hears of a new comment, as the server works it out: whoever made the card, its
    // assignees and whoever has commented, but not me. → [{ email, name }]
    function hearers(){
      var c = o.card() || {}, seen = {}, out = [];
      var add = function(e, n){ e = String(e || '').toLowerCase(); if (!e || e === me() || seen[e]) return; seen[e] = 1; out.push({ email: e, name: n || e }); };
      if (c.by) add(c.by.email, c.by.name);
      (c.assignees || []).forEach(function(p){ add(p.email, p.name); });
      list.forEach(function(x){ if (x.by) add(x.by.email, x.by.name); });
      return out;
    }
    function names(ps){
      var n = ps.map(function(p){ return p.name; });
      return n.length > 3 ? n.slice(0, 3).join(', ') + ' and ' + (n.length - 3) + ' more' : n.length > 1 ? n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1] : n[0];
    }

    function render(){
      var draft = editing && listEl.querySelector('.wk-talk-edit textarea');
      var kept = draft ? draft.value : null;
      if (!loaded) { listEl.innerHTML = '<li class="detail-muted">Loading…</li>'; return; }
      if (!list.length) { listEl.innerHTML = '<li class="detail-muted wk-none">No comments yet.</li>'; return; }
      listEl.innerHTML = list.map(function(x){
        var mine = x.by && String(x.by.email || '').toLowerCase() === me();
        var head = '<div class="wk-talk-head"><strong>' + esc((x.by && (x.by.name || x.by.email)) || 'Someone') + '</strong> <span class="detail-muted">' + esc(when(x.at || 0)) + (x.editedAt ? ' · edited' : '') + '</span>' +
          (mine && editing !== x.id ? ' <button class="btn-text wk-talk-act" type="button" data-act="edit">Edit</button>' : '') +
          (mine || o.fullWrite() ? ' <button class="btn-text wk-talk-act" type="button" data-act="delete">Delete</button>' : '') + '</div>';
        var body = editing === x.id
          ? '<form class="wk-talk-edit" novalidate><textarea rows="3" maxlength="' + MAX + '">' + esc(kept !== null ? kept : x.text) + '</textarea>' +
            '<div class="stage-fields-actions"><button class="btn" type="submit">Save</button><button class="btn" type="button" data-act="cancel">Cancel</button></div></form>'
          : '<div class="wk-desc">' + BoldMarkdown.render(x.text) + '</div>';
        return '<li class="wk-talk-item' + (x.id === marked ? ' is-marked' : '') + '" id="c-' + esc(x.id) + '" data-id="' + esc(x.id) + '">' + head + body + '</li>';
      }).join('');
    }

    var unsub = ref.collection('comments').orderBy('at').onSnapshot(function(snap){
      list = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
      var first = !loaded;
      loaded = true; render();
      // A link to a comment: scrolled to once it's on the page.
      if (first && marked) setTimeout(function(){ var m = document.getElementById('c-' + marked); if (m) m.scrollIntoView({ block: 'center' }); }, 0);
    }, function(err){
      console.error('[BOLD Lab] loading the conversation failed', err);
      loaded = true; list = []; listEl.innerHTML = '<li class="detail-muted">Couldn’t load the conversation.</li>';
    });

    function fail(msg){ error.textContent = msg; error.hidden = false; }
    form.addEventListener('submit', function(e){
      e.preventDefault();
      var text = box.value.trim(), m = o.me();
      if (busy || !m) return;
      if (!text) return fail('Write something first.');
      error.hidden = true;
      var who = hearers();
      (who.length ? BOLD.confirmAction({ title: 'Post it?', go: 'Post', effects: ['Send ' + names(who) + ' a Slack message about it, within a few minutes'] }) : Promise.resolve(true)).then(function(go){
        if (!go) return;
        busy = true;
        return ref.collection('comments').add({ text: text.slice(0, MAX), by: { email: m.email, name: m.displayName || m.email }, at: Date.now() }).then(function(){
          busy = false; box.value = '';
        });
      }).catch(function(err){
        console.error('[BOLD Lab] posting a comment failed', err);
        busy = false; fail('Couldn’t post it — try again.');
      });
    });
    listEl.addEventListener('click', function(e){
      var b = e.target.closest('[data-act]'), li = b && b.closest('.wk-talk-item');
      if (!li) return;
      var id = li.getAttribute('data-id'), act = b.getAttribute('data-act');
      if (act === 'edit') { editing = id; render(); var t = li.ownerDocument.querySelector('#c-' + CSS.escape(id) + ' textarea'); if (t) t.focus(); }
      else if (act === 'cancel') { editing = null; render(); }
      else if (act === 'delete') {
        if (!window.confirm('Delete this comment?')) return;
        ref.collection('comments').doc(id).delete().catch(function(err){ console.error('[BOLD Lab] deleting a comment failed', err); fail('Couldn’t delete it — try again.'); });
      }
    });
    listEl.addEventListener('submit', function(e){
      var f = e.target.closest('.wk-talk-edit');
      if (!f) return;
      e.preventDefault();
      var id = f.closest('.wk-talk-item').getAttribute('data-id'), text = f.querySelector('textarea').value.trim();
      if (!text) return;
      ref.collection('comments').doc(id).update({ text: text.slice(0, MAX), editedAt: Date.now() }).then(function(){ editing = null; render(); })
        .catch(function(err){ console.error('[BOLD Lab] saving a comment failed', err); fail('Couldn’t save it — try again.'); });
    });

    render();
    return { el: el, stop: function(){ if (unsub) unsub(); unsub = null; } };
  }
  return { create: create };
})();
