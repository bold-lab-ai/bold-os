// A thing's conversation, where it's discussed (2026-11-07): a thread in Conversations, shown with Conversations'
// own forum (conversations-forum.js), that thread alone, where the thing is. Every place BOLD.OS chats about one
// thing uses this: a board card's (project-work.js) and a proposed change's to the BOLDiquette or a guide
// (pages/guide.js). Its first message starts it, on the server (commentConversation, functions/
// comment-conversation.js), with whatever was said there before (its old comments) copied in first, each by
// whoever wrote it; until then those old comments show, read only. Writing: Conversations' Edit.
// BoldTalk.create({ post: its conversation's id, on: commentConversation's `on`, old?: () => a query of the old
//   comments ({ text, by, at }), project?: { id }, label?, effects: what starting it does (BOLD.confirmAction) })
// → { el, stop() }: el is kept between the page's redraws (what's being written stays).
// BoldCardTalk.create(ref, o): a card's (ref: projectWorkspaces/<project>/work/<card>).
// &c=<id> in the address (an old comment's link) scrolls to that comment while it's shown.
window.BoldTalk = (function(){
  var esc = BOLD.escapeHtml, MAX = 10000;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var pad = function(n){ return (n < 10 ? '0' : '') + n; };
  function when(ms){ var d = new Date(ms); return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  function create(o){
    var el = document.createElement('div');
    el.className = 'detail-abstract wk-talk';
    el.innerHTML = (o.label === false ? '' : '<div class="detail-abstract-label">' + esc(o.label || 'Conversation') + '</div>') +
      '<div class="wk-talk-forum"></div><ul class="wk-talk-list" hidden></ul>' +
      '<form class="wk-talk-form" novalidate hidden>' +
      '<textarea aria-label="Start the conversation" class="wk-talk-text md-field" data-md-breaks="true" rows="3" maxlength="' + MAX + '"></textarea>' +
      '<div class="field-error wk-talk-error" hidden></div>' +
      '<div class="stage-fields-actions"><button class="btn" type="submit">Post</button></div></form>' +
      '<p class="detail-muted wk-talk-off" hidden></p>';
    var forumEl = el.querySelector('.wk-talk-forum'), listEl = el.querySelector('.wk-talk-list'), form = el.querySelector('.wk-talk-form');
    var box = form.querySelector('textarea'), error = form.querySelector('.wk-talk-error'), offEl = el.querySelector('.wk-talk-off');
    var exists = null, old = [], busy = false, forum = null, unsubOld = null, unsubPost = null;
    var marked = (/[#&]c=([^&]+)/.exec(location.hash) || [])[1] || '';
    marked = marked ? decodeURIComponent(marked) : '';

    function draw(){
      if (exists === null) return;
      if (exists) {
        // The thread: Conversations' forum, that one conversation (the page shows what it's about: no title).
        if (!forum && window.BoldConversations) {
          forum = BoldConversations.create({ note: false, title: false, thread: o.post, project: o.project ? { id: o.project.id, title: function(){ return ''; } } : null });
          forumEl.appendChild(forum.el);
        }
        listEl.hidden = true; form.hidden = true; offEl.hidden = true;
        return;
      }
      // Not started: what was said before, then the first message.
      listEl.hidden = !old.length;
      listEl.innerHTML = old.map(function(x){
        return '<li class="wk-talk-item' + (x.id === marked ? ' is-marked' : '') + '" id="c-' + esc(x.id) + '"><div class="wk-talk-head"><strong>' +
          esc((x.by && (x.by.name || x.by.email)) || 'Someone') + '</strong> <span class="detail-muted">' + esc(when(x.at || 0)) + '</span></div>' +
          '<div class="wk-desc">' + BoldMarkdown.render(x.text || '') + '</div></li>';
      }).join('');
      var can = BOLD.can('conversations', 'edit');
      form.hidden = !can; offEl.hidden = can;
      if (!can) offEl.textContent = BOLD.cannotReason('conversations', 'edit');
      box.placeholder = old.length ? 'Go on with it: Markdown' : 'Start the conversation: Markdown';
    }

    // Whether it's started (a conversation that isn't there yet can be asked about: firestore.rules).
    try {
      unsubPost = firebase.firestore(BOLD.getApp()).collection('conversations').doc(o.post).onSnapshot(function(d){ exists = d.exists; draw(); },
        function(err){ console.error('[BOLD Lab] loading a conversation failed', err); exists = false; draw(); });
    } catch (e){ exists = false; }
    if (o.old) unsubOld = o.old().onSnapshot(function(snap){
      var first = !old.length && snap.size;
      old = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); }).sort(function(a, b){ return (a.at || 0) - (b.at || 0); });
      draw();
      if (first && marked) setTimeout(function(){ var m = document.getElementById('c-' + marked); if (m) m.scrollIntoView({ block: 'center' }); }, 0);
    }, function(){ old = []; draw(); });

    function fail(msg){ error.textContent = msg; error.hidden = false; }
    form.addEventListener('submit', function(e){
      e.preventDefault();
      var text = box.value.trim();
      if (busy) return;
      if (!text) return fail('Write something first.');
      error.hidden = true;
      var effects = (o.effects || []).slice();
      if (old.length) effects[0] = (effects[0] || 'Start it in Conversations') + ', with the ' + (old.length === 1 ? 'comment' : old.length + ' comments') + ' before it, each by whoever wrote it';
      BOLD.confirmAction({ title: 'Start the conversation?', go: 'Post', effects: effects }).then(function(go){
        if (!go) return;
        busy = true;
        return firebase.app().functions('europe-west2').httpsCallable('commentConversation')({ on: o.on, text: text.slice(0, MAX) }).then(function(){
          busy = false; box.value = '';
        });
      }).catch(function(err){
        console.error('[BOLD Lab] starting a conversation failed', err);
        busy = false; fail((err && err.code && err.code !== 'functions/internal' && err.message) || 'Couldn’t post it — try again.');
      });
    });
    BOLD.onAccess(function(){ draw(); });

    return { el: el, stop: function(){
      if (unsubOld) unsubOld(); if (unsubPost) unsubPost(); unsubOld = unsubPost = null;
      if (forum && forum.away) forum.away();
    } };
  }
  return { create: create };
})();

// A board card's (project-work.js): conversations/cm-card-<project>-<card>, about the card's project; its
// maker and assignees count as in it (slack-thread.js peopleIn).
window.BoldCardTalk = { create: function(ref){
  var pid = ref.parent.parent.id;
  return BoldTalk.create({ post: 'cm-card-' + pid + '-' + ref.id, on: 'card/' + pid + '/' + ref.id, project: { id: pid },
    old: function(){ return ref.collection('comments'); },
    effects: ['Start it in Conversations, about this project', 'Tell the project’s people, on their Notifications page'] });
} };
