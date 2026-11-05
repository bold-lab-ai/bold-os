// notifications.html (the masthead's bell; was requests.html, 2026-11-05). Three tabs, by #hash:
// - Inbox (#inbox, the default; #messages too): everything BOLD.OS told you, newest first: every Slack DM and note-to-you it sent,
//   and Conversations' (a reply where you are, a new conversation). notifications/{id}, yours alone
//   (firestore.rules); unread ones are highlighted. Opening one marks it read; each can be marked read or
//   unread, and all read at once. Kept for good.
// - To do (#todo): everything on BOLD.OS waiting on you, from myRequests (functions/index.js),
//   each linking to where it's answered. It stays until it's done; the bell counts these.
// - Waiting (#waiting): what you asked that waits on someone else.
(function(){
  var body = document.getElementById('notificationsBody');
  if (!body || !BOLD.getAuth()) return;
  var esc = BOLD.escapeHtml;
  var KINDS = { join: 'Joining BOLD', group: 'Changing group', letter: 'Recommendation letter', introduction: 'Introduction', supervision: 'Supervision meetings',
    agent: 'Agent acting', invite: 'Invitation', review: 'Internal Review', event: 'Event', hackathon: 'Hackathon', venue: 'Venue', proposal: 'Proposed change' };
  var SOURCES = [['', 'All'], ['slack', 'Slack'], ['conversations', 'Conversations']];
  var reqs = null, reqError = false, notes = null, noteError = false, source = '', me = '';
  var db = function(){ return firebase.firestore(BOLD.getApp()); };

  function when(t){ return t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
  function ago(t){
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 7 * 86400) return Math.round(s / 86400) + ' d ago';
    return when(t);
  }
  function names(ps){ return (ps || []).map(function(p){ return p.name; }).filter(Boolean).join(', '); }
  function reqHtml(x, toAnswer){
    var whom = toAnswer ? (x.by && x.by.name ? 'from ' + x.by.name : '') : 'waiting on ' + (names(x.on) || x.waiting || 'someone');
    var meta = [KINDS[x.kind] || 'Request', whom, (x.column === 'doing' ? 'under way since ' : 'since ') + when(x.since)].filter(Boolean).join(' · ');
    return '<li><a class="proj-title" href="' + esc(x.url) + '">' + (x.num ? '#' + x.num + ' ' : '') + esc(x.title) + '</a>' +
      '<span class="proj-meta">' + esc(meta) + '</span></li>';
  }
  function noteHtml(n){
    var label = n.source === 'conversations' ? 'Conversations' : 'Slack';
    return '<li class="nt-item' + (n.read ? '' : ' is-unread') + '" data-id="' + esc(n.id) + '">' +
      (n.href ? '<a class="nt-text" href="' + esc(n.href) + '" data-open="' + esc(n.id) + '">' + esc(n.text) + '</a>' : '<span class="nt-text">' + esc(n.text) + '</span>') +
      '<span class="proj-meta">' + esc(label + ' · ' + ago(n.at)) + ' · <button type="button" class="btn-text nt-toggle" data-id="' + esc(n.id) + '">' + (n.read ? 'Mark unread' : 'Mark read') + '</button></span></li>';
  }
  function draw(){
    var forYou = (reqs && reqs.forYou) || [], byYou = (reqs && reqs.byYou) || [];
    var list = (notes || []).filter(function(n){ return !source || n.source === source; });
    var unread = (notes || []).filter(function(n){ return !n.read; }).length;
    var n = function(k){ return k ? ' (' + k + ')' : ''; };
    var reqPanel = function(id, items, toAnswer, none){
      return '<section class="profile-panel" id="' + id + '">' + (reqError ? '<p class="proj-msg">Couldn’t load these — try reloading the page.</p>'
        : !reqs ? '<p class="proj-msg">Loading&hellip;</p>'
        : items.length ? '<ul class="proj-list">' + items.map(function(x){ return reqHtml(x, toAnswer); }).join('') + '</ul>' : '<p class="proj-msg">' + none + '</p>') + '</section>';
    };
    body.innerHTML = '<nav class="guide-tabs profile-tabs" aria-label="Notifications">' +
        '<a class="guide-tab" href="#inbox">Inbox' + (unread ? ' <span class="nt-unread-count">' + unread + ' unread</span>' : '') + '</a>' +
        '<a class="guide-tab" href="#todo">To do' + n(forYou.length) + '</a>' +
        '<a class="guide-tab" href="#waiting">Waiting' + n(byYou.length) + '</a></nav>' +
      '<section class="profile-panel" id="inbox">' +
        '<div class="nt-bar"><span class="nt-filter" role="group" aria-label="Show">' + SOURCES.map(function(s){
          return '<button type="button" class="btn-text nt-src' + (source === s[0] ? ' is-on' : '') + '" data-src="' + s[0] + '" aria-pressed="' + (source === s[0]) + '">' + esc(s[1]) + '</button>';
        }).join('') + '</span>' +
        '<button type="button" class="btn-text nt-all"' + (unread ? '' : ' disabled title="Nothing unread"') + '>Mark all read</button></div>' +
        (noteError ? '<p class="proj-msg">Couldn’t load your inbox — try reloading the page.</p>'
          : !notes ? '<p class="proj-msg">Loading&hellip;</p>'
          : list.length ? '<ul class="proj-list nt-list">' + list.map(noteHtml).join('') + '</ul>'
          : '<p class="proj-msg">' + (source ? 'Nothing here yet.' : 'Nothing yet: what BOLD.OS tells you on Slack, and in Conversations, shows here from now on.') + '</p>') +
      '</section>' +
      reqPanel('todo', forYou, true, 'Nothing waiting on you.') +
      reqPanel('waiting', byYou, false, 'Nothing you asked is waiting.');
    showTab();
  }
  function showTab(){
    var want = ['#todo', '#waiting'].indexOf(location.hash) >= 0 ? location.hash.slice(1) : 'inbox';
    ['inbox', 'todo', 'waiting'].forEach(function(id){ var x = document.getElementById(id); if (x) x.hidden = id !== want; });
    Array.prototype.forEach.call(body.querySelectorAll('.guide-tab'), function(a){
      var on = a.getAttribute('href') === '#' + want;
      a.classList.toggle('is-current', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  window.addEventListener('hashchange', showTab);

  function setRead(ids, read){
    var b = db().batch();
    ids.forEach(function(id){ b.update(db().collection('notifications').doc(id), { read: read, readAt: Date.now() }); });
    return b.commit().catch(function(err){ console.error('[BOLD Notifications] marking read failed', err); });
  }
  body.addEventListener('click', function(e){
    var src = e.target.closest('.nt-src');
    if (src) { source = src.getAttribute('data-src'); draw(); return; }
    var t = e.target.closest('.nt-toggle');
    if (t) { var x = (notes || []).filter(function(n){ return n.id === t.getAttribute('data-id'); })[0]; if (x) setRead([x.id], !x.read); return; }
    if (e.target.closest('.nt-all')) { setRead((notes || []).filter(function(n){ return !n.read; }).map(function(n){ return n.id; }), true); return; }
    var open = e.target.closest('[data-open]');
    if (open) {
      var n = (notes || []).filter(function(x){ return x.id === open.getAttribute('data-open'); })[0];
      if (n && !n.read) { e.preventDefault(); setRead([n.id], true).then(function(){ location.href = open.getAttribute('href'); }); }
    }
  });

  var unsub = null, asked = 0;
  BOLD.onUser(function(user){
    var mine = ++asked;
    if (unsub) { unsub(); unsub = null; }
    reqs = null; notes = null; reqError = noteError = false;
    if (!user) return;
    me = String(user.email || '').toLowerCase();
    draw();
    firebase.app().functions('europe-west2').httpsCallable('myRequests')().then(function(r){
      if (mine !== asked) return;
      reqs = r.data || {};
      if (BOLD.setTodoCount) BOLD.setTodoCount((reqs.forYou || []).length);
      draw();
    }).catch(function(err){ if (mine !== asked) return; console.error('[BOLD Notifications] loading your requests failed', err); reqError = true; draw(); });
    // Theirs, newest first (sorted here: the query needs no index of its own).
    unsub = db().collection('notifications').where('to', '==', me).onSnapshot(function(s){
      notes = s.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); }).sort(function(a, b){ return (b.at || 0) - (a.at || 0); });
      draw();
    }, function(err){ console.error('[BOLD Notifications] loading your messages failed', err); noteError = true; draw(); });
  });
})();
