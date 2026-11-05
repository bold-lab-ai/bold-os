// Conversations (conversations.html, above the Calendar in the sidebar; an experiment until 2026-11-04):
// Reddit-like threads. A post (conversations/{pid}) and its replies (conversations/{pid}/messages/{mid},
// each answering the post or another reply: `parent`) are a tree; each can be voted up or down
// (`votes`, by sign-in id) and replied to. Saved, and seen by whoever may view Conversations
// (Who can see what; firestore.rules). Ways in: write a post or a reply; bring in a Slack thread (Import from Slack here,
// or Take it to the BOLD OS in Slack: functions/slack-thread.js); or reason with your agent (a panel at
// the bottom, from any message, or from New chat's form for a new post), which drafts a post or a reply and saves it once you say
// so (the BOLDiquette: an agent confirms each action with its person). The agent is a preview: it
// drafts from your own words, with no model behind it. A post opens as its thread (#post=<id>).
(function(){
  var postsEl = document.getElementById('bsPosts'), threadEl = document.getElementById('bsThread'), sortEl = document.querySelector('.bs-sort');
  var log = document.getElementById('bsLog'), form = document.getElementById('bsForm'), text = document.getElementById('bsText'), aboutEl = document.getElementById('bsAbout');
  var importEl = document.getElementById('bsImport'), writeEl = document.getElementById('bsWrite'), agentEl = document.getElementById('bsAgent'), forumEl = document.querySelector('.bs-forum');
  if (!postsEl || !form) return;
  var esc = BOLD.escapeHtml, MIN = 60000;
  // Reasoning with your agent is off for now (2026-11-04): its button and New chat's link are left out;
  // the panel's code stays, to turn back on here.
  var AGENT = false;
  // A message's text: Markdown (Slack threads come in as it: functions/slack-thread.js), its single
  // line breaks kept, as in Slack.
  var md = function(t){ return '<div class="bs-text md-desc">' + BoldMarkdown.render(t, { breaks: true }) + '</div>'; };
  var me = { email: '', name: 'You', uid: '' }, canPost = false, canStart = false, full = false;
  var posts = null, messages = {}, openId = '', stopMsgs = null;
  var sort = 'top', folded = {}, replying = '', said = [], draft = null, about = null;   // about: { pid, id }
  var db = function(){ return firebase.firestore(BOLD.getApp()); };
  var col = function(){ return db().collection('conversations'); };
  var FV = function(){ return firebase.firestore.FieldValue; };

  // ---------- what a message is ----------
  var ms = function(t){ return !t ? Date.now() : typeof t === 'number' ? t : t.toMillis ? t.toMillis() : Date.now(); };
  function ago(t){ var m = Math.round((Date.now() - ms(t)) / MIN); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; }
  var score = function(m){ var v = m.votes || {}; return Object.keys(v).reduce(function(s, k){ return s + (Number(v[k]) || 0); }, 0); };
  var mine = function(m){ return !!me.email && m.createdBy === me.email; };
  // A message's replies in the order they were written, whatever their votes: a conversation reads in order.
  // (Votes order the posts on the list: Top.)
  var kids = function(id){ return (messages[openId] || []).filter(function(x){ return x.parent === id; }).sort(function(a, b){ return ms(a.at) - ms(b.at); }); };
  var total = function(id){ return kids(id).reduce(function(s, x){ return s + 1 + total(x.id); }, 0); };
  var count = function(k){ return k + (k === 1 ? ' reply' : ' replies'); };
  var postOf = function(id){ return (posts || []).filter(function(p){ return p.id === id; })[0]; };
  var msgOf = function(pid, id){ return pid === id ? postOf(pid) : (messages[pid] || []).filter(function(x){ return x.id === id; })[0]; };

  function vote(m){
    var v = (m.votes || {})[me.uid] || 0;
    return '<div class="bs-vote' + (v > 0 ? ' is-up' : v < 0 ? ' is-down' : '') + '">' +
      '<button type="button" class="bs-up" data-id="' + esc(m.id) + '" data-v="1" aria-pressed="' + (v > 0) + '" aria-label="Upvote" title="Upvote">▲</button>' +
      '<span class="bs-score">' + score(m) + '</span>' +
      '<button type="button" class="bs-up bs-down" data-id="' + esc(m.id) + '" data-v="-1" aria-pressed="' + (v < 0) + '" aria-label="Downvote" title="Downvote">▼</button></div>';
  }
  // Who wrote it: someone (or their agent), or, brought in from Slack, its author there.
  // Who wrote it, first and clearly, then when. Where a thread came from (Slack) is said after, at the
  // foot of its post (origin), not here.
  function by(m){
    return '<span class="bs-author">' + esc(m.name || 'someone') + (m.viaAgent ? '’s agent' : '') + '</span> · ' + ago(m.at);
  }
  function origin(m){
    if (m.source !== 'slack' || !m.slack) return '';
    var s = m.slack;
    return '<p class="bs-origin">' + (m.private ? '<span class="bs-private" title="Brought in from a private Slack channel: only its members see it here">Private: ' + (s.channelName ? esc(s.channelName) + '’s' : 'the channel’s') + ' members</span> · ' : '') + 'From ' + (s.channelName ? esc(s.channelName) : 'Slack') +
      (m.broughtBy && m.broughtBy.name ? ', brought in by ' + esc(m.broughtBy.name) : '') +
      (s.permalink ? ' · <a href="' + esc(s.permalink) + '" target="_blank" rel="noopener">Open in Slack</a>' : '') + '</p>';
  }
  function acts(m, pid){
    var why = canPost ? '' : ' disabled title="' + esc(BOLD.cannotReason('conversations', 'edit')) + '"';
    var k = m.id === pid ? 0 : total(m.id);
    return '<p class="bs-acts">' +
      '<button type="button" class="btn-text bs-reply-btn" data-pid="' + esc(pid) + '" data-id="' + esc(m.id) + '"' + why + '>Reply</button>' +
      (AGENT ? '<button type="button" class="btn-text bs-discuss" data-pid="' + esc(pid) + '" data-id="' + esc(m.id) + '"' + (about && about.id === m.id ? ' disabled title="You’re reasoning about it with your agent"' : why) + '>Reason with your agent</button>' : '') +
      (k ? '<button type="button" class="btn-text bs-fold" data-id="' + esc(m.id) + '">' + (folded[m.id] ? 'Show ' + count(k) : 'Hide replies') + '</button>' : '') +
      (mine(m) || full ? '<button type="button" class="btn-text danger bs-remove" data-pid="' + esc(pid) + '" data-id="' + esc(m.id) + '">Remove</button>' : '') + '</p>' +
      (replying === m.id ? '<form class="bs-replyform" data-pid="' + esc(pid) + '" data-id="' + esc(m.id) + '"><textarea class="md-field" data-md-breaks="true" data-preview-class="bs-text md-desc" rows="5" maxlength="10000" placeholder="Your reply" aria-label="Your reply"></textarea>' +
        '<div class="event-form-actions"><button type="submit" class="ev-save">Reply</button><button type="button" class="bs-replycancel">Cancel</button></div></form>' : '');
  }
  function replyHtml(m, pid){
    var k = total(m.id), off = folded[m.id];
    return '<li class="bs-reply' + (mine(m) ? ' is-mine' : '') + (about && about.id === m.id ? ' is-about' : '') + '" id="m-' + esc(m.id) + '">' +
      '<div class="bs-reply-card">' + vote(m) + '<div class="bs-post-main">' +
        '<p class="bs-by">' + by(m) + '</p>' + md(m.body) + acts(m, pid) + '</div></div>' +
      (k && !off ? '<ol class="bs-replies">' + kids(m.id).map(function(x){ return replyHtml(x, pid); }).join('') + '</ol>' : '') + '</li>';
  }

  // ---------- the list, or one post's thread ----------
  function render(){
    var open = decodeURIComponent((location.hash.match(/^#post=(.+)$/) || [])[1] || '');
    if (open !== openId) watchThread(open);
    var p = open && postOf(open);
    postsEl.hidden = !!open; sortEl.hidden = !!open; threadEl.hidden = !open;
    if (open) {
      if (importEl) importEl.hidden = true;
      if (writeEl) writeEl.hidden = true;
      if (posts === null || messages[open] === undefined) { threadEl.innerHTML = '<p class="proj-msg">Loading&hellip;</p>'; return; }
      if (!p) { threadEl.innerHTML = '<a class="back-link" href="#">&larr; All posts</a><p class="proj-msg">No such post: it may have been removed.</p>'; return; }
      var k = total(p.id);
      // An open reply box is carried across the redraw (a reply or a vote arriving), with what's typed in it
      // and its Write | Preview tab.
      var keep = threadEl.querySelector('.bs-replyform');
      threadEl.innerHTML = '<a class="back-link" href="#">&larr; All posts</a>' +
        '<div class="bs-post bs-post-open' + (mine(p) ? ' is-mine' : '') + (about && about.id === p.id ? ' is-about' : '') + '" id="m-' + esc(p.id) + '">' + vote(p) +
          '<div class="bs-post-main"><h2 class="bs-title">' + esc(p.title) + '</h2><p class="bs-by">' + by(p) + '</p>' +
          (p.body && p.body.trim() !== p.title ? md(p.body) : '') + acts(p, p.id) + origin(p) + '</div></div>' +
        '<h3 class="bs-replies-head">' + count(k) + '</h3>' +
        (k ? '<ol class="bs-replies bs-replies-top">' + kids(p.id).map(function(x){ return replyHtml(x, p.id); }).join('') + '</ol>' : '<p class="bs-by">No replies yet.</p>');
      var fresh = threadEl.querySelector('.bs-replyform');
      if (keep && fresh && keep.getAttribute('data-id') === fresh.getAttribute('data-id')) fresh.replaceWith(keep);
      else { var f = fresh && fresh.querySelector('textarea'); if (f) f.focus(); }
      return;
    }
    if (posts === null) { postsEl.innerHTML = '<li class="proj-msg">Loading&hellip;</li>'; return; }
    var list = posts.slice().sort(sort === 'new' ? function(a, b){ return ms(b.at) - ms(a.at); } : function(a, b){ return score(b) - score(a) || ms(b.at) - ms(a.at); });
    postsEl.innerHTML = list.length ? list.map(function(q){
      var at = '#post=' + encodeURIComponent(q.id);
      return '<li class="bs-post' + (mine(q) ? ' is-mine' : '') + '" id="m-' + esc(q.id) + '">' + vote(q) +
        '<div class="bs-post-main"><h3 class="bs-title"><a href="' + at + '">' + esc(q.title) + '</a></h3><p class="bs-by">' + by(q) + (q.private ? ' · <span class="bs-private" title="Brought in from a private Slack channel: only its members see it here">Private</span>' : '') + '</p>' +
          (q.body && q.body.trim() !== q.title ? md(q.body).replace('class="bs-text md-desc"', 'class="bs-text md-desc bs-clip"') : '') +
          '<p class="bs-acts"><a href="' + at + '">' + count(q.replies || 0) + '</a></p></div></li>';
    }).join('') : '<li class="proj-msg">No posts yet: write one, start a chat with your agent, or bring in a Slack thread.</li>';
  }
  window.addEventListener('hashchange', function(){ replying = ''; render(); window.scrollTo(0, 0); });
  function watchThread(id){
    if (stopMsgs) { stopMsgs(); stopMsgs = null; }
    openId = id;
    if (!id) return;
    stopMsgs = col().doc(id).collection('messages').onSnapshot(function(snap){
      messages[id] = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
      if (!threadEl.querySelector('.bs-replyform textarea:focus')) render();   // typing: wait (the box is kept anyway)
    }, function(err){ console.error('[BOLD Lab] loading replies failed', err); messages[id] = []; render(); });
  }

  // ---------- writing ----------
  function newPost(title, body, viaAgent){
    var o = { title: title, body: body, name: me.name, createdBy: me.email, at: FV().serverTimestamp(), source: 'site', viaAgent: !!viaAgent, votes: {}, private: false };
    o.votes[me.uid] = 1;
    return col().add(o);
  }
  function newReply(pid, parent, body, viaAgent){
    var o = { parent: parent, body: body, name: me.name, createdBy: me.email, at: FV().serverTimestamp(), source: 'site', viaAgent: !!viaAgent, votes: {} };
    o.votes[me.uid] = 1;
    folded[parent] = false;
    return col().doc(pid).collection('messages').add(o);
  }
  var oops = function(what){ return function(e){ console.error('[BOLD Lab] ' + what + ' failed', e); alertBox(what + ' failed: ' + (e && e.message || e)); }; };
  function alertBox(t){ var p = document.querySelector('.bs-note'); if (p) { p.textContent = t; p.classList.add('is-error'); } }

  // ---------- Reason with your agent (a preview: it drafts from your words) ----------
  function add(who, html, cls){
    var li = document.createElement('li');
    li.className = 'bs-msg' + (cls ? ' ' + cls : '');
    li.innerHTML = '<span class="bs-who">' + esc(who) + '</span><div class="bs-body">' + html + '</div>';
    log.appendChild(li);
    log.scrollTop = log.scrollHeight;
    return li;
  }
  add('Your agent', 'Think out loud with me. When something is worth sharing with the lab, I’ll draft a post, or a reply to one, and ask you before it goes out.');
  function label(a){
    var p = postOf(a.pid), m = msgOf(a.pid, a.id);
    if (!p) return 'a post';
    return a.id === a.pid ? '“' + p.title + '”' : ((m && m.name) || 'someone') + '’s reply in “' + p.title + '”';
  }
  function setAbout(a){
    about = a; said = [];
    aboutEl.hidden = !a;
    aboutEl.innerHTML = a ? 'About: <a href="#post=' + encodeURIComponent(a.pid) + '">' + esc(label(a)) + '</a> <button type="button" class="btn-text bs-unabout">Stop</button>' : '';
    text.placeholder = a ? 'What do you make of it?' : 'What are you thinking about?';
  }
  function makeDraft(){
    var all = said.join(' ').replace(/\s+/g, ' ').trim();
    if (about) return { reply: about, body: all };
    var first = (all.match(/^.*?[.?!](\s|$)/) || [all])[0].trim();
    var title = first.length > 90 ? first.slice(0, 87).replace(/\s+\S*$/, '') + '…' : first;
    return { title: title.charAt(0).toUpperCase() + title.slice(1), body: all };
  }
  function offerDraft(){
    draft = makeDraft();
    add('Your agent', (draft.reply ? 'This adds to it. I’d reply:' : 'This seems worth sharing. I’d post:') +
      '<div class="bs-draft">' + (draft.title ? '<strong>' + esc(draft.title) + '</strong>' : '') + '<p>' + esc(draft.body) + '</p></div>' +
      '<div class="bs-draft-actions"><button type="button" class="btn btn-primary bs-post-it"' + (canPost ? '' : ' disabled title="' + esc(BOLD.cannotReason('conversations', 'edit')) + '"') + '>' + (draft.reply ? 'Reply' : 'Post it') + '</button>' +
      '<button type="button" class="btn bs-keep">Not yet</button></div>', 'has-draft');
  }
  form.addEventListener('submit', function(e){
    e.preventDefault();
    var t = text.value.trim();
    if (!t) return;
    add(me.name, esc(t), 'is-mine');
    said.push(t); text.value = '';
    setTimeout(function(){
      if (said.length >= 2 || t.length > 160) offerDraft();
      else add('Your agent', about ? 'And how does that bear on what you’re working on?' : 'Go on: what makes you think so, and what would change your mind?');
    }, 400);
  });
  text.addEventListener('keydown', function(e){
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  log.addEventListener('click', function(e){
    var b = e.target.closest('button');
    if (!b || b.disabled || !draft) return;
    var box = b.closest('.bs-draft-actions');
    if (b.classList.contains('bs-post-it')) {
      var d = draft; draft = null; b.disabled = true;
      var go = d.reply ? newReply(d.reply.pid, d.reply.id, d.body, true) : newPost(d.title, d.body, true);
      go.then(function(ref){
        box.innerHTML = '<span class="bs-done">' + (d.reply ? 'Replied.' : 'Posted.') + '</span>';
        add('Your agent', d.reply ? 'Replied. I’ll tell you if anyone picks it up.' : 'Posted. I’ll tell you when someone replies with something that bears on it.');
        said = [];
        var pid = d.reply ? d.reply.pid : ref.id;
        if (d.reply) setAbout(null);
        show(pid, d.reply ? ref.id : '');
      }, function(err){ b.disabled = false; draft = d; oops('Posting')(err); });
    } else if (b.classList.contains('bs-keep')) {
      box.innerHTML = '<span class="bs-done">Not posted.</span>'; draft = null;
      add('Your agent', 'Fine, we keep thinking. Tell me more.');
    }
  });
  aboutEl.addEventListener('click', function(e){
    if (!e.target.closest('.bs-unabout')) return;
    setAbout(null); render();
    add('Your agent', 'Back to whatever you’re thinking about.');
  });
  function fit(){ if (agentEl.hidden) return; var r = forumEl.getBoundingClientRect(); agentEl.style.left = r.left + 'px'; agentEl.style.width = r.width + 'px'; }
  window.addEventListener('resize', fit);
  function openAgent(){ agentEl.hidden = false; document.body.classList.add('bs-agent-open'); fit(); text.focus(); }
  function closeAgent(){ agentEl.hidden = true; document.body.classList.remove('bs-agent-open'); if (about) { setAbout(null); render(); } }
  agentEl.querySelector('.bs-close').addEventListener('click', closeAgent);
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape' && !agentEl.hidden) closeAgent(); });
  writeEl.querySelector('.bs-new').hidden = !AGENT;
  writeEl.querySelector('.bs-new').addEventListener('click', function(){
    writeEl.hidden = true;
    if (about) { setAbout(null); render(); }
    add('Your agent', 'A new chat. What are you thinking about?');
    openAgent();
  });
  function show(pid, mid){
    var h = '#post=' + encodeURIComponent(pid);
    if (location.hash !== h) location.hash = h.slice(1); else render();
    setTimeout(function(){ var el = mid && document.getElementById('m-' + mid); if (el) el.scrollIntoView({ block: 'center' }); }, 300);
  }

  // ---------- writing a post yourself, and bringing in a Slack thread ----------
  sortEl.querySelector('.bs-write').addEventListener('click', function(){
    importEl.hidden = true; writeEl.hidden = !writeEl.hidden;
    if (!writeEl.hidden) writeEl.querySelector('input').focus();
  });
  writeEl.addEventListener('submit', function(e){
    e.preventDefault();
    var t = writeEl.querySelector('input').value.trim(), b = writeEl.querySelector('textarea').value.trim(), go = writeEl.querySelector('button[type=submit]');
    if (!t) return;
    go.disabled = true;
    newPost(t, b || t, false).then(function(ref){ writeEl.reset(); writeEl.hidden = true; show(ref.id); }, oops('Posting')).then(function(){ go.disabled = false; });
  });
  writeEl.querySelector('.bs-write-cancel').addEventListener('click', function(){ writeEl.hidden = true; });
  sortEl.querySelector('.bs-import').addEventListener('click', function(){
    writeEl.hidden = true; importEl.hidden = !importEl.hidden;
    if (!importEl.hidden) importEl.querySelector('input').focus();
  });
  importEl.addEventListener('submit', function(e){
    e.preventDefault();
    var input = importEl.querySelector('input'), err = importEl.querySelector('.ev-error'), go = importEl.querySelector('button[type=submit]');
    err.hidden = true; go.disabled = true; go.textContent = 'Bringing it in…';
    firebase.app().functions('europe-west2').httpsCallable('slackThread')({ url: input.value.trim() }).then(function(res){
      input.value = ''; importEl.hidden = true;
      show(res.data.id);
    }, function(x){
      err.textContent = (x && x.message) || 'Couldn’t bring it in.'; err.hidden = false;
    }).then(function(){ go.disabled = false; go.textContent = 'Bring it in'; });
  });
  importEl.querySelector('.bs-import-cancel').addEventListener('click', function(){ importEl.hidden = true; });

  // ---------- votes, replies, folding, removing, reasoning ----------
  forumEl.addEventListener('click', function(e){
    var b = e.target.closest('button');
    if (!b || b.disabled) return;
    var id = b.getAttribute('data-id'), pid = b.getAttribute('data-pid');
    if (b.classList.contains('bs-up')) {
      // The same arrow again takes your vote back; the other one turns it round.
      var p = openId || id, isPost = !openId || id === openId, m = isPost ? postOf(id) : msgOf(openId, id);
      if (!m || !me.uid) return;
      var was = (m.votes || {})[me.uid] || 0, want = Number(b.getAttribute('data-v')), now = was === want ? 0 : want;
      var ref = isPost ? col().doc(id) : col().doc(p).collection('messages').doc(id), patch = {};
      patch['votes.' + me.uid] = now ? now : FV().delete();
      ref.update(patch).catch(oops('Voting'));
      return;
    }
    if (b.classList.contains('bs-fold')) { folded[id] = !folded[id]; render(); return; }
    if (b.classList.contains('bs-reply-btn')) { replying = replying === id ? '' : id; render(); return; }
    if (b.classList.contains('bs-replycancel')) { replying = ''; render(); return; }
    if (b.classList.contains('bs-remove')) {
      var isP = id === pid, what = isP ? postOf(id) : msgOf(pid, id);
      // Always asked, even with Don't ask me again: it can't be undone.
      BOLD.confirmAlways({ title: 'Remove ' + (isP ? '“' + (what ? what.title : 'this post') + '”' : 'this reply') + '?', effects: [isP ? 'Take the post and all its replies off Conversations, for everyone' : 'Take the reply off Conversations, for everyone', 'This can’t be undone'], go: 'Remove' })
        .then(function(ok){
          if (!ok) return;
          var r = isP ? col().doc(id) : col().doc(pid).collection('messages').doc(id);
          r.delete().then(function(){ if (isP) location.hash = ''; }, oops('Removing'));
        });
      return;
    }
    if (b.classList.contains('bs-discuss')) {
      setAbout({ pid: pid, id: id }); render();
      var k = id === pid ? total(pid) : total(id);
      add('Your agent', 'Let’s reason about ' + esc(label(about)) + '. ' + (k ? count(k) + ' under it so far. ' : '') + 'What do you make of it?');
      openAgent();
      var el = document.getElementById('m-' + id);
      if (el) window.scrollBy(0, el.getBoundingClientRect().top - 90);
    }
  });
  // Cmd+Enter (Ctrl+Enter) sends a reply or a new post.
  forumEl.addEventListener('keydown', function(e){
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.isComposing) return;
    var f = e.target.closest('.bs-replyform, #bsWrite');
    if (!f || e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') return;
    e.preventDefault();
    var go = f.querySelector('button[type=submit]');
    if (go && !go.disabled) f.requestSubmit(go);
  });
  forumEl.addEventListener('submit', function(e){
    var f = e.target.closest('.bs-replyform');
    if (!f) return;
    e.preventDefault();
    var body = f.querySelector('textarea').value.trim(), go = f.querySelector('button[type=submit]');
    if (!body) return;
    go.disabled = true;
    newReply(f.getAttribute('data-pid'), f.getAttribute('data-id'), body, false)
      .then(function(ref){ replying = ''; show(f.getAttribute('data-pid'), ref.id); }, function(err){ go.disabled = false; oops('Replying')(err); });
  });

  function syncSort(){ Array.prototype.forEach.call(document.querySelectorAll('.bs-sortbtn'), function(x){ x.setAttribute('aria-pressed', String(x.getAttribute('data-sort') === sort)); }); }
  sortEl.addEventListener('click', function(e){
    var b = e.target.closest('.bs-sortbtn'); if (!b) return;
    sort = b.getAttribute('data-sort'); syncSort(); render();
  });

  // ---------- who, and what's there ----------
  BOLD.onUser(function(u){ me.name = (u && u.displayName) || 'You'; me.uid = (u && u.uid) || ''; });
  BOLD.onAccess(function(a){
    me.email = String((a && a.e) || '').toLowerCase();
    canPost = BOLD.can('conversations', 'edit'); full = BOLD.isFullWrite();
    // Starting a chat (New chat, Import from Slack), replying and voting: all Conversations' Edit.
    canStart = canPost;
    var startWhy = BOLD.cannotReason('conversations', 'edit');
    ['.bs-write', '.bs-import'].forEach(function(c){
      var b = sortEl.querySelector(c); b.disabled = !canStart; b.title = canStart ? '' : startWhy;
    });
    if (!BOLD.can('conversations', 'view')) { postsEl.innerHTML = '<li class="proj-msg">' + esc(BOLD.cannotReason('conversations', 'view')) + '</li>'; return; }
    // Open ones, and those brought in from a private Slack channel the viewer is in (readers: Slack user
    // ids; firestore.rules seesConversation): two queries, as the rules allow no list mixing them.
    var u = firebase.auth().currentUser, slackId = '';
    ((u && u.providerData) || []).forEach(function(p){ if (p.providerId === 'oidc.slack') slackId = p.uid; });
    var parts = { open: [], mine: [] };
    var fail = function(err){ console.error('[BOLD Lab] loading conversations failed', err); postsEl.innerHTML = '<li class="proj-msg">Couldn’t load the conversations.</li>'; };
    var merge = function(){
      var seen = {}; posts = [];
      parts.open.concat(parts.mine).forEach(function(p){ if (!seen[p.id]) { seen[p.id] = 1; posts.push(p); } });
      if (!document.activeElement || !document.activeElement.closest('.bs-replyform')) render();
    };
    var watch = function(q, key){
      q.onSnapshot(function(snap){ parts[key] = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); }); merge(); }, fail);
    };
    watch(col().where('private', '==', false), 'open');
    if (slackId) watch(col().where('readers', 'array-contains', slackId), 'mine');
  });
  render();
})();
