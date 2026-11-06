// A project's Conversations tab (project.html, &tab=conversations; 2026-11-06): the conversations about it,
// newest activity first, each opening in Conversations; and starting one, which is about the project
// (conversations/{id} `project`, `projectTitle`). Cards' comments made a conversation (card-talk.js) are
// about their project too, so they're here. Only conversations open to everyone who sees Conversations
// (private ones, from a private Slack channel, aren't listed). Who sees and posts: Conversations' View and
// Edit (Who can do what; firestore.rules). A new one is told to the project's people (slack-thread.js).
// ProjectTalk.start({ pid, title: () => the project's title }) → keeps its element; attach(mount) puts it in.
window.ProjectTalk = (function(){
  var esc = BOLD.escapeHtml, MIN = 60000;
  var el = null, pid = '', titleOf = null, posts = null, failed = false, unsub = null, busy = false, msg = '', open = false;
  var ms = function(t){ return !t ? Date.now() : typeof t === 'number' ? t : t.toMillis ? t.toMillis() : Date.now(); };
  function ago(t){ var m = Math.round((Date.now() - ms(t)) / MIN); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; }

  function draw(){
    if (!el) return;
    var can = BOLD.can('conversations', 'edit');
    var head = '<div class="pt-head"><p class="detail-muted">Conversations about this project.</p>' +
      (open ? '' : '<button class="btn" type="button" id="ptNew"' + (can ? '' : ' disabled title="' + esc(BOLD.cannotReason('conversations', 'edit')) + '"') + '>Start a conversation</button>') + '</div>';
    var form = open ? '<form class="pt-form" id="ptForm" novalidate>' +
        '<input type="text" id="ptTitle" maxlength="200" placeholder="What it’s about" aria-label="Title">' +
        '<textarea id="ptBody" class="md-field" rows="4" maxlength="10000" placeholder="Say more: Markdown" aria-label="Text"></textarea>' +
        (msg ? '<div class="field-error">' + esc(msg) + '</div>' : '') +
        '<div class="stage-fields-actions"><button class="btn" type="submit"' + (busy ? ' disabled' : '') + '>Post</button><button class="btn" type="button" id="ptCancel">Cancel</button></div></form>' : '';
    var list = failed ? '<p class="detail-muted">Couldn’t load its conversations — try reloading the page.</p>'
      : !posts ? '<p class="detail-muted">Loading…</p>'
      : !posts.length ? '<p class="detail-muted">No conversations about it yet.</p>'
      : '<ul class="pt-list">' + posts.map(function(p){
          var n = p.replies || 0;
          return '<li><a class="pt-title" href="conversations.html#post=' + encodeURIComponent(p.id) + '">' + esc(p.title || 'Untitled') + '</a>' +
            '<span class="detail-muted pt-meta">' + esc(p.name || 'Someone') + ' · ' + ago(p.lastAt || p.at) + ' · ' + (n === 1 ? '1 reply' : n + ' replies') +
            (p.from && p.from.kind === 'card' ? ' · from a card' : '') + '</span></li>';
        }).join('') + '</ul>';
    // A title or text being written stays through a redraw.
    var t = el.querySelector('#ptTitle'), b = el.querySelector('#ptBody'), keep = t ? [t.value, b.value] : null;
    el.innerHTML = head + form + list;
    if (keep && el.querySelector('#ptTitle')) { el.querySelector('#ptTitle').value = keep[0]; el.querySelector('#ptBody').value = keep[1]; }
  }

  function watch(){
    if (unsub) unsub();
    posts = null; failed = false;
    // Open ones only (private == false): what the rules let a list read (firestore.rules seesConversation).
    unsub = firebase.firestore(BOLD.getApp()).collection('conversations').where('project', '==', pid).where('private', '==', false).onSnapshot(function(s){
      posts = s.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); })
        .sort(function(a, b){ return ms(b.lastAt || b.at) - ms(a.lastAt || a.at); });
      draw();
    }, function(err){ console.error('[BOLD Lab] loading the project’s conversations failed', err); failed = true; draw(); });
  }

  function post(){
    var title = (el.querySelector('#ptTitle').value || '').trim(), body = (el.querySelector('#ptBody').value || '').trim();
    if (!title || !body) { msg = 'Give it a title and some text.'; draw(); return; }
    var u = BOLD.getAuth() && BOLD.getAuth().currentUser;
    if (!u || busy) return;
    BOLD.confirmAction({ title: 'Start this conversation?', go: 'Post', effects: ['Tell the project’s people, on their Notifications page'] }).then(function(go){
      if (!go) return;
      busy = true; msg = ''; draw();
      return firebase.firestore(BOLD.getApp()).collection('conversations').add({
        title: title.slice(0, 200), body: body.slice(0, 10000), name: u.displayName || u.email, createdBy: String(u.email || '').toLowerCase(),
        at: firebase.firestore.FieldValue.serverTimestamp(), source: 'site', viaAgent: false, votes: {}, private: false,
        project: pid, projectTitle: String((titleOf && titleOf()) || '').slice(0, 300) }).then(function(ref){
        busy = false; open = false; draw();
        location.href = 'conversations.html#post=' + encodeURIComponent(ref.id);
      });
    }).catch(function(err){ console.error('[BOLD Lab] starting a conversation failed', err); busy = false; msg = 'Couldn’t post it — try again.'; draw(); });
  }

  function start(o){
    if (!el) {
      el = document.createElement('div');
      el.className = 'pt';
      el.addEventListener('click', function(e){
        if (e.target.closest('#ptNew')) { open = true; msg = ''; draw(); var t = el.querySelector('#ptTitle'); if (t) t.focus(); }
        else if (e.target.closest('#ptCancel')) { open = false; msg = ''; draw(); }
      });
      el.addEventListener('submit', function(e){ if (e.target.id === 'ptForm') { e.preventDefault(); post(); } });
      BOLD.onAccess(function(){ draw(); });
    }
    titleOf = o.title;
    if (o.pid !== pid) { pid = o.pid; open = false; msg = ''; watch(); }
    draw();
  }
  function attach(mount){ if (mount && el) mount.appendChild(el); }
  return { start: start, attach: attach };
})();
