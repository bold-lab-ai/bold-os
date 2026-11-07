// A thing's conversation, where it's discussed (2026-11-07): a thread in Conversations, shown with Conversations'
// own forum (conversations-forum.js), that thread alone, where the thing is. Every place BOLD.OS chats about one
// thing uses this: a board card's (project-work.js) and a proposed change's to the BOLDiquette or a guide
// (pages/guide.js). Its first message starts it, on the server (commentConversation, functions/
// comment-conversation.js), with whatever was said there before (its old comments) copied in first, each by
// whoever wrote it; until then those old comments show, read only. Writing: Conversations' Edit. Also an
// Internal Review card's Discussion (audit-board/detail.js).
// BoldTalk.create({ post: its conversation's id, on: commentConversation's `on`, old?: () => a query of the old
//   comments ({ text, by, at }), or oldItems?: () => them as a list (kept on the thing itself), project?: { id },
//   label? (false: none), heading? (a section's heading, not a small label), effects: what starting it does (BOLD.confirmAction) })
// → { el, stop() }: el is kept between the page's redraws (what's being written stays).
// BoldCardTalk.create(ref, o): a card's (ref: projectWorkspaces/<project>/work/<card>).
// &c=<id> in the address (an old comment's link) scrolls to that comment while it's shown.
window.BoldTalk = (function(){
  var esc = BOLD.escapeHtml, MAX = 10000;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var pad = function(n){ return (n < 10 ? '0' : '') + n; };
  // How long ago, as Conversations says it (conversations-forum.js ago).
  function ago(t){ var m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; }
  function when(ms){ var d = new Date(ms); return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  function create(o){
    var el = document.createElement('div');
    el.className = 'detail-abstract wk-talk';
    // Its heading: a section's (heading: true, a card's page), or a small label (a proposed change's Discussion).
    el.innerHTML = (o.label === false ? '' : o.heading ? '<h3 class="wk-talk-title">' + esc(o.label || 'Conversation') + '</h3>' : '<div class="detail-abstract-label">' + esc(o.label || 'Conversation') + '</div>') +
      // Before it starts, it looks as it will after: who reads it, the messages, and Reply (conversations-forum.js's
      // parts: its classes, its eye, its replyBox).
      '<div class="wk-talk-forum"></div>' +
      '<div class="bs-root wk-talk-ahead" hidden><div class="bs-meta"><p class="bs-readers bs-readers-static"></p></div>' +
      '<ol class="bs-run wk-talk-list" hidden></ol>' +
      // Its first message: Conversations' own reply box (conversations-forum.js replyForm).
      '<form class="bs-replyform wk-talk-form" novalidate hidden><textarea class="md-field" data-md-breaks="true" data-preview-class="bs-text md-desc" rows="5" maxlength="' + MAX + '" aria-label="Start the conversation"></textarea>' +
      '<div class="field-error wk-talk-error" hidden></div>' +
      '<div class="event-form-actions"><button type="submit" class="ev-save">Post</button></div></form></div>' +
      '<p class="detail-muted wk-talk-off" hidden></p>';
    var forumEl = el.querySelector('.wk-talk-forum'), listEl = el.querySelector('.wk-talk-list'), aheadEl = el.querySelector('.wk-talk-ahead');
    var error = el.querySelector('.wk-talk-error'), offEl = el.querySelector('.wk-talk-off');
    var form = el.querySelector('.wk-talk-form'), box = form.querySelector('textarea');
    var exists = null, old = [], queried = [], busy = false, forum = null, unsubOld = null, unsubPost = null;
    var marked = (/[#&]c=([^&]+)/.exec(location.hash) || [])[1] || '';
    marked = marked ? decodeURIComponent(marked) : '';

    function draw(){
      if (exists === null) return;
      // What was said before: what the thing holds itself (oldItems: a card's description), then its old comments.
      old = (o.oldItems ? o.oldItems() || [] : []).map(function(x, i){ return Object.assign({ id: 'old-' + i }, x); }).concat(queried);
      if (exists) {
        // The thread: Conversations' forum, that one conversation (the page shows what it's about: no title).
        if (!forum && window.BoldConversations) {
          forum = BoldConversations.create({ note: false, title: false, thread: o.post, project: o.project ? { id: o.project.id, title: function(){ return ''; } } : null });
          forumEl.appendChild(forum.el);
        }
        aheadEl.hidden = true; offEl.hidden = true;
        return;
      }
      if (opening) { aheadEl.hidden = true; offEl.hidden = false; offEl.textContent = 'Loading…'; return; }
      // Not started: what was said before, then the first message.
      listEl.hidden = !old.length;
      listEl.innerHTML = old.map(function(x){
        return '<li class="bs-line wk-talk-item' + (x.id === marked ? ' is-marked' : '') + '" id="c-' + esc(x.id) + '"><div class="bs-line-head"><p class="bs-by"><span class="bs-author">' +
          esc((x.by && (x.by.name || x.by.email)) || 'Someone') + '</span> · <span title="' + esc(when(x.at || 0)) + '">' + esc(ago(x.at || 0)) + '</span></p></div>' +
          '<div class="bs-text md-desc">' + BoldMarkdown.render(x.text || '', { breaks: true }) + '</div></li>';
      }).join('');
      aheadEl.hidden = false;
      // Who will read it: everyone who sees Conversations (it starts open).
      aheadEl.querySelector('.bs-readers-static').innerHTML = (BoldConversations.eye || '') + esc(BOLD.whoCan ? BOLD.whoCan('conversations', 'view') : 'whoever sees Conversations');
      var can = BOLD.can('conversations', 'edit');
      offEl.hidden = can;
      if (!can) offEl.textContent = BOLD.cannotReason('conversations', 'edit');
      form.hidden = !can;
      box.placeholder = old.length ? 'Go on with it' : 'Start the conversation';
    }

    // Whether it's started (a conversation that isn't there yet can be asked about: firestore.rules).
    try {
      unsubPost = firebase.firestore(BOLD.getApp()).collection('conversations').doc(o.post).onSnapshot(function(d){ exists = d.exists; if (!exists) openIt(); draw(); },
        function(err){ console.error('[BOLD Lab] loading a conversation failed', err); exists = false; draw(); });
    } catch (e){ exists = false; }
    if (o.old) unsubOld = o.old().onSnapshot(function(snap){
      var first = !queried.length && snap.size;
      queried = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); }).sort(function(a, b){ return (a.at || 0) - (b.at || 0); });
      draw();
      if (first && marked) setTimeout(function(){ var m = document.getElementById('c-' + marked); if (m) m.scrollIntoView({ block: 'center' }); }, 0);
    }, function(){ queried = []; draw(); });

    // o.open (a board card's): a conversation from the start, made the first time its page is opened, by whoever may
    // post in Conversations (commentConversation with no text; told to nobody). Meanwhile, or if it can't be, as below.
    var opening = false;
    function openIt(){
      if (!o.open || opening || !BOLD.can('conversations', 'edit')) return;
      opening = true; draw();
      firebase.app().functions('europe-west2').httpsCallable('commentConversation')({ on: o.on }).catch(function(err){
        console.error('[BOLD Lab] opening a card’s conversation failed', err);
        opening = false; draw();
      });
    }
    function fail(msg){ error.textContent = msg; error.hidden = false; }
    // Its first message (Reply): asked first, then started on the server; false keeps the box as it is.
    form.addEventListener('submit', function(e){
      e.preventDefault();
      var text = box.value.trim(), go = form.querySelector('button[type=submit]');
      if (!text) return fail('Write something first.');
      go.disabled = true;
      start(text).then(function(ok){ go.disabled = false; if (ok !== false) box.value = ''; });
    });
    form.addEventListener('keydown', function(e){ if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
    function start(text){
      if (busy) return Promise.resolve(false);
      error.hidden = true;
      var effects = (o.effects || []).slice();
      if (old.length) effects[0] = (effects[0] || 'Start it in Conversations') + ', with the ' + (old.length === 1 ? 'comment' : old.length + ' comments') + ' before it, each by whoever wrote it';
      return BOLD.confirmAction({ title: 'Start the conversation?', go: 'Post', effects: effects }).then(function(go){
        if (!go) return false;
        busy = true;
        return firebase.app().functions('europe-west2').httpsCallable('commentConversation')({ on: o.on, text: text.slice(0, MAX) }).then(function(){ busy = false; });
      }).catch(function(err){
        console.error('[BOLD Lab] starting a conversation failed', err);
        busy = false; fail((err && err.code && err.code !== 'functions/internal' && err.message) || 'Couldn’t post it — try again.');
        return false;
      });
    }
    BOLD.onAccess(function(){ if (exists === false) openIt(); draw(); });

    return { el: el, stop: function(){
      if (unsubOld) unsubOld(); if (unsubPost) unsubPost(); unsubOld = unsubPost = null;
      if (forum && forum.away) forum.away();
    } };
  }
  // Pure: a card's description as a message: its notes, then its images (Markdown).
  function descriptionOf(c){
    var imgs = (c.images || []).filter(function(i){ return i && /^https:\/\//.test(String(i.url || '')); });
    return [String(c.notes || '').trim()].concat(imgs.map(function(i){ return '![' + String(i.name || 'An image').replace(/[\[\]]/g, '') + '](' + i.url + ')'; })).filter(Boolean).join('\n\n');
  }
  return { create: create, descriptionOf: descriptionOf };
})();

// A board card's (project-work.js): conversations/cm-card-<project>-<card>, about the card's project; its
// maker and assignees count as in it (slack-thread.js peopleIn).
// Its description is its first message (2026-11-07): the card's notes, and any images it had, by whoever made it.
window.BoldCardTalk = { create: function(ref, o){
  var pid = ref.parent.parent.id;
  return BoldTalk.create({ post: 'cm-card-' + pid + '-' + ref.id, on: 'card/' + pid + '/' + ref.id, project: { id: pid }, heading: true,
    old: function(){ return ref.collection('comments'); },
    oldItems: function(){ var c = (o && o.card && o.card()) || {}, t = BoldTalk.descriptionOf(c); return t ? [{ text: t, by: c.by, at: c.at }] : []; },
    open: true, effects: ['Start it in Conversations, about this project', 'Tell the project’s people, on their Notifications page'] });
} };
