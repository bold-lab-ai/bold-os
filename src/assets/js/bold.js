/* Shared client behaviour for every page. The chrome itself (masthead, sidebar,
   gate, footer) is static HTML from src/_includes; this file only wires it up:
   Firebase auth, the signed-in masthead, gating, and the sidebar. Loaded in
   <head> after the Firebase SDK tags; the layout's inline BOLD.mount*() calls
   run as the parser reaches each piece, so state is right before first paint.

   Page code talks to auth through BOLD.onUser / BOLD.signIn / BOLD.signOut /
   BOLD.getApp instead of initialising Firebase itself. Config comes from
   window.BOLD_CONFIG, written by the layout from src/_data/site.js. */
(function(){
  var BOLD = window.BOLD = window.BOLD || {};

  BOLD.firebaseConfig = window.BOLD_CONFIG;
  BOLD.useAuthEmulator = false;
  // Local development (npm start) signs in the way it did before 2026-10-04:
  // popup via Firebase's own auth domain. The live site's setup (self-hosted
  // helper on bold-lab-ai.github.io + redirect, see BOLD.signIn) needs the page
  // to be on bold-lab-ai.github.io; from localhost that hand-off is cross-site,
  // and Firefox, Safari and private windows block it.
  var isLocalDev = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  if (isLocalDev && BOLD.firebaseConfig) {
    BOLD.firebaseConfig = Object.assign({}, BOLD.firebaseConfig, { authDomain: 'bold-d7ff2.firebaseapp.com' });
  }

  BOLD.escapeHtml = function(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  };
  // Text → a lowercase-and-hyphens name for a URL or an anchor.
  BOLD.slugify = function(s){
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  };
  var esc = BOLD.escapeHtml;

  /* ---------- copy boxes ---------- */

  // The site's one way to offer text to copy: a code box with the clipboard
  // icon inside it, top right (.copy-box in bold.css). Any .copy-btn copies the
  // text of the <pre> beside it and shows a tick for a moment.
  var ICON_COPY = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  var ICON_DONE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
  // Icons for .icon-btn buttons: edit, and move up and down.
  // Guides with a page of their own elsewhere (guides/{slug} → its page): edited
  // like any guide, but not listed under How to. guide.html?guide=<slug> goes there.
  BOLD.GUIDE_PAGES = { 'get-started-at-bold': 'get-started.html' };
  BOLD.guideHref = function(slug){ return BOLD.GUIDE_PAGES[slug] || 'guide.html?guide=' + encodeURIComponent(slug); };

  // The lab's Slack workspace, for links into the Slack app (tags).
  BOLD.SLACK_TEAM = 'T0B7DUVFEM8';

  // Tags: @[Name](SlackId) in any text people write (mentions.js) reads as @Name,
  // linking to their profile in the Slack app (Slack's slack://user link). Pages
  // show text as it's stored; this turns the tags in it into links wherever it
  // appears, except in boxes being edited, code and .no-tags.
  BOLD.TAG = /@\[([^\]]+)\]\((U[A-Z0-9]+)\)/g;
  BOLD.tagHtml = function(name, id){
    return '<a class="md-mention" href="slack://user?team=' + BOLD.SLACK_TEAM + '&amp;id=' + id + '" title="Open in Slack">@' + BOLD.escapeHtml(name) + '</a>';
  };
  var TAG_SKIP = 'textarea, input, script, style, pre, code, [contenteditable], .no-tags';
  function showTags(node){
    var texts = [];
    if (node.nodeType === 3) texts.push(node);
    else if (node.nodeType === 1) {
      var walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      while (walk.nextNode()) texts.push(walk.currentNode);
    }
    texts.forEach(function(t){
      var v = t.nodeValue;
      if (v.indexOf('](U') === -1 || !t.parentNode || !t.parentElement || t.parentElement.closest(TAG_SKIP)) return;
      var html = BOLD.escapeHtml(v).replace(BOLD.TAG, function(all, name, id){ return BOLD.tagHtml(name.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"), id); });
      var span = document.createElement('span');
      span.innerHTML = html;
      var frag = document.createDocumentFragment();
      while (span.firstChild) frag.appendChild(span.firstChild);
      t.parentNode.replaceChild(frag, t);
    });
  }
  document.addEventListener('DOMContentLoaded', function(){
    showTags(document.body);
    new MutationObserver(function(list){
      list.forEach(function(m){
        if (m.type === 'characterData') showTags(m.target);
        else Array.prototype.forEach.call(m.addedNodes, showTags);
      });
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  BOLD.ICON_PENCIL = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M11.6 1.6a1.5 1.5 0 0 1 2.1 0l.7.7a1.5 1.5 0 0 1 0 2.1L5.6 13.2l-3.5.9.9-3.5 8.6-9zM10.9 3.7l1.4 1.4 1.1-1.1-1.4-1.4-1.1 1.1z"/></svg>';
  BOLD.ICON_UP = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>';
  BOLD.ICON_DOWN = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v10M3.5 8.5 8 13l4.5-4.5"/></svg>';
  // Switching tabs leaves the tab bar where it is on screen: runs change() (which may
  // redraw), then scrolls so the bar (a selector, found again after) sits where it
  // was. When the new tab is shorter, `container` (an element that isn't redrawn,
  // holding the tabs) keeps the height that takes, until the next switch.
  BOLD.switchTab = function(bar, container, change){
    var before = document.querySelector(bar);
    var top = before ? before.getBoundingClientRect().top : null;
    container.style.minHeight = '';
    change();
    var after = document.querySelector(bar);
    if (top === null || !after) return;
    var y = after.getBoundingClientRect().top + window.scrollY - top;
    // Checked again after each top-up: margins inside the container change what it adds.
    for (var i = 0; i < 3; i++){
      var short = y + window.innerHeight - document.documentElement.scrollHeight;
      if (short <= 0) break;
      container.style.minHeight = container.offsetHeight + short + 'px';
    }
    // Instant: the page scrolls smoothly (bold.css), which would show a jump and a glide back.
    window.scrollTo({ top: Math.max(0, y), behavior: 'instant' });
  };
  BOLD.copyBoxHtml = function(text){
    return '<div class="copy-box"><pre><code>' + esc(text) + '</code></pre>' +
      '<button type="button" class="copy-btn" aria-label="Copy" title="Copy">' + ICON_COPY + '</button></div>';
  };
  document.addEventListener('click', function(e){
    var btn = e.target.closest && e.target.closest('.copy-btn');
    if (!btn) return;
    var pre = btn.parentNode.querySelector('pre');
    if (!pre || !navigator.clipboard) return;
    navigator.clipboard.writeText(pre.textContent).then(function(){
      btn.innerHTML = ICON_DONE; btn.classList.add('is-done'); btn.setAttribute('aria-label', 'Copied'); btn.title = 'Copied';
      clearTimeout(btn._reset);
      btn._reset = setTimeout(function(){
        btn.innerHTML = ICON_COPY; btn.classList.remove('is-done'); btn.setAttribute('aria-label', 'Copy'); btn.title = 'Copy';
      }, 1500);
    }).catch(function(err){ console.error('[BOLD Lab] copying failed', err); });
  });

  // Before anything that reaches outside BOLD.OS (Slack, Google Calendar and Drive,
  // GitHub, email, messages to people): what will happen, then Go ahead or Cancel.
  // o: { title, effects: [text or { text, key }], go }. An effect with a key is optional:
  // it has a tick box, ticked, and unticking it skips it. Resolves false, or to go ahead
  // { skip: { key: true } } for what was unticked. "Don't ask me again"
  // skips it for good for this person: prefs/{uid} { skipConfirm }, turned back on
  // from their profile (BOLD.setSkipConfirm); kept in this browser too, to answer at once.
  var skipConfirm = null;
  function skipKey(){ var u = auth && auth.currentUser; return u ? 'boldSkipConfirm:' + u.uid : ''; }
  function loadSkip(){
    var u = auth && auth.currentUser;
    if (!u) { skipConfirm = null; return Promise.resolve(false); }
    try { var c = localStorage.getItem(skipKey()); if (c !== null) skipConfirm = c === '1'; } catch (e){}
    if (!firebase.firestore) return Promise.resolve(!!skipConfirm);
    return firebase.firestore(BOLD.getApp()).collection('prefs').doc(u.uid).get().then(function(d){
      skipConfirm = !!(d.exists && d.data().skipConfirm);
      try { localStorage.setItem(skipKey(), skipConfirm ? '1' : '0'); } catch (e){}
      return skipConfirm;
    }).catch(function(){ return !!skipConfirm; });
  }
  BOLD.getSkipConfirm = function(){ return skipConfirm !== null ? Promise.resolve(skipConfirm) : loadSkip(); };
  BOLD.setSkipConfirm = function(on){
    var u = auth && auth.currentUser;
    if (!u) return Promise.reject(new Error('Sign in first.'));
    skipConfirm = !!on;
    try { localStorage.setItem(skipKey(), on ? '1' : '0'); } catch (e){}
    return firebase.firestore(BOLD.getApp()).collection('prefs').doc(u.uid).set({ skipConfirm: !!on, at: Date.now() });
  };
  BOLD.confirmAction = function(o){
    return BOLD.getSkipConfirm().then(function(skip){
      if (skip) return { skip: {} };
      return new Promise(function(resolve){
        var d = document.createElement('dialog');
        d.className = 'confirm-dialog';
        d.innerHTML = '<h2>' + esc(o.title || 'Go ahead?') + '</h2>' +
          ((o.effects || []).length ? '<p>This will:</p><ul>' + o.effects.map(function(e){
            return e.key ? '<li class="confirm-opt"><label><input type="checkbox" checked data-key="' + esc(e.key) + '"> ' + esc(e.text) + '</label></li>' : '<li>' + esc(e.text || e) + '</li>';
          }).join('') + '</ul>' : '') +
          (auth && auth.currentUser ? '<label class="confirm-skip"><input type="checkbox"> Don’t ask me again (you can turn it back on in your profile)</label>' : '') +
          '<div class="confirm-actions"><button class="btn-box" type="button" data-no>Cancel</button>' +
          '<button class="btn-box is-primary" type="button" data-yes>' + esc(o.go || 'Go ahead') + '</button></div>';
        document.body.appendChild(d);
        var done = function(yes){
          var skip = d.querySelector('.confirm-skip input');
          if (yes && skip && skip.checked){
            BOLD.setSkipConfirm(true).catch(function(err){ console.error('[BOLD Lab] saving the setting failed', err); });
          }
          var skipped = {};
          Array.prototype.forEach.call(d.querySelectorAll('[data-key]'), function(c){ if (!c.checked) skipped[c.getAttribute('data-key')] = true; });
          d.close(); d.remove(); resolve(yes ? { skip: skipped } : false);
        };
        d.querySelector('[data-yes]').addEventListener('click', function(){ done(true); });
        d.querySelector('[data-no]').addEventListener('click', function(){ done(false); });
        d.addEventListener('cancel', function(e){ e.preventDefault(); done(false); });
        d.showModal();
        d.querySelector('[data-yes]').focus();
      });
    });
  };

  var hint = null;
  try { hint = JSON.parse(localStorage.getItem('boldAuthHint') || 'null'); } catch (e){}
  // Signed in last visit: lets page CSS keep "sign in" panels out of the first paint.
  if (hint) document.documentElement.classList.add('auth-hint');

  /* ---------- Firebase + auth ---------- */

  var app = null, auth = null, authReady = false, current = null, listeners = [];

  BOLD.getApp = function(){
    if (app) return app;
    try { app = firebase.apps.length ? firebase.app() : firebase.initializeApp(BOLD.firebaseConfig); } catch (e){ app = null; }
    return app;
  };

  BOLD.getAuth = function(){
    if (auth) return auth;
    if (!BOLD.getApp()) return null;
    try {
      auth = firebase.auth();
      if (BOLD.useAuthEmulator) auth.useEmulator('http://localhost:9099');
    } catch (e){ auth = null; return null; }
    auth.onAuthStateChanged(function(user){
      current = user; authReady = true; skipConfirm = null;
      try {
        if (user) localStorage.setItem('boldAuthHint', JSON.stringify({ n: user.displayName || '', e: user.email || '' }));
        else localStorage.removeItem('boldAuthHint');
      } catch (e){}
      listeners.slice().forEach(function(fn){ fn(user); });
    });
    // Finishes a sign-in after Slack redirects back here (or linking an
    // account, BOLD.link); onAuthStateChanged above picks up the user, this
    // only surfaces errors from the round trip. A page can read the outcome
    // from BOLD.redirectResult.
    BOLD.redirectResult = auth.getRedirectResult();
    BOLD.redirectResult.catch(function(err){
      console.error('[BOLD Lab] sign-in failed', err);
    });
    return auth;
  };

  // fn(user|null) on every auth-state change; replayed at once if already resolved.
  // Never fires if Firebase can't start — check BOLD.getAuth() for that.
  BOLD.onUser = function(fn){
    BOLD.getAuth();
    listeners.push(fn);
    if (authReady) fn(current);
  };

  // The last visit's { n: displayName, e: email }, or null — for painting before auth resolves.
  BOLD.authHint = function(){ return hint; };

  // Sign-in redirects the page to Slack and back rather than using a popup:
  // when Slack hands off to Google sign-in, Google's pages cut the popup off
  // from this page, which then reports it as closed (auth/popup-closed-by-user)
  // and drops the sign-in. Redirect sign-in needs the Firebase authDomain on
  // this same site — the helper is self-hosted at bold-lab-ai.github.io/__/auth/
  // (bold-lab-ai.github.io repo; authDomain in src/_data/site.js).
  // onError(err), if given, runs if sign-in fails before leaving the page.
  BOLD.signIn = function(onError){
    var a = BOLD.getAuth();
    if (!a) return;
    var provider = new firebase.auth.OAuthProvider('oidc.slack');
    provider.addScope('openid');
    provider.addScope('profile');
    provider.addScope('email');
    (isLocalDev ? a.signInWithPopup(provider) : a.signInWithRedirect(provider)).catch(function(err){
      console.error('[BOLD Lab] sign-in failed', err);
      if (typeof onError === 'function') onError(err);
    });
  };

  // Links another sign-in provider (e.g. GitHub) to the signed-in account: a
  // redirect, as sign-in is, except on localhost (a popup). Resolves with the
  // result after a popup; after a redirect, see BOLD.redirectResult.
  BOLD.link = function(provider){
    var a = BOLD.getAuth(), u = a && a.currentUser;
    if (!u) return Promise.reject(new Error('Not signed in.'));
    return isLocalDev ? u.linkWithPopup(provider) : u.linkWithRedirect(provider);
  };

  BOLD.signOut = function(){
    var a = BOLD.getAuth();
    if (a) a.signOut();
  };

  /* ---------- masthead ---------- */

  function renderAuthRegion(region, user){
    if (user) {
      var who = user.displayName
        ? esc(user.displayName) + (user.email ? ' <span class="mast-auth-email">(' + esc(user.email) + ')</span>' : '')
        : esc(user.email || 'Signed in');
      region.innerHTML =
        '<div class="mast-auth">' +
          '<a class="mast-auth-name" href="profile.html">' + who + '</a>' +
          '<button class="btn-text" type="button" id="mastSignOutBtn">Sign out</button>' +
        '</div>';
      region.querySelector('#mastSignOutBtn').addEventListener('click', BOLD.signOut);
    } else {
      region.innerHTML = '<button class="auth-signin" type="button" id="mastSignInBtn">Sign in with Slack</button>';
      region.querySelector('#mastSignInBtn').addEventListener('click', BOLD.signIn);
    }
  }

  // Called right after the masthead markup.
  BOLD.mountMasthead = function(){
    var region = document.getElementById('authRegion');
    // Paint the last visit's name at once; auth stays authoritative.
    if (hint) renderAuthRegion(region, { displayName: hint.n, email: hint.e });
    BOLD.onUser(function(user){ renderAuthRegion(region, user); });
  };

  /* ---------- who can see what ---------- */

  // The BOLDiquette's Who can see what (settings/access, functions/access.js): for each
  // page (area), the lowest group of Who is BOLD that may view it, edit on it and propose
  // changes on it. The viewer's group is their members/{email} `category` (PAN-BOLD
  // without one; getMyAccess, where the page has functions, also counts PIs and admins
  // as BOLD-exec). The rules enforce it; this only decides what the page shows.
  var LEVELS = ['everyone', 'pan', 'associate', 'internal', 'staff', 'exec', 'none'];
  var LEVEL_NAMES = { everyone: 'Everyone', pan: 'PAN-BOLD', associate: 'BOLD-associate', internal: 'BOLD-internal', staff: 'BOLD-staff', exec: 'BOLD-exec', none: 'nobody' };
  function rankOf(level){ var i = LEVELS.indexOf(level); return i < 0 ? 3 : i; }
  var access = null, accessListeners = [];
  // The last visit's, for the first paint (same person only).
  try {
    var seen = JSON.parse(localStorage.getItem('boldAccess') || 'null');
    if (seen && hint && seen.e === hint.e) access = seen;
  } catch (e){}
  function setAccess(a){
    access = a;
    try { if (a.e) localStorage.setItem('boldAccess', JSON.stringify(a)); else localStorage.removeItem('boldAccess'); } catch (e){}
    accessListeners.slice().forEach(function(fn){ fn(a); });
  }
  function levelFor(area, what){ return ((access && access.pages && access.pages[area]) || {})[what] || 'internal'; }
  // Whether the viewer may view | edit | propose on `area` (a page key: projects, …).
  BOLD.can = function(area, what){
    if (!access) return false;
    var level = levelFor(area, what || 'view');
    return level !== 'none' && rankOf(access.group) >= rankOf(level);
  };
  // Why not, for a disabled control's tooltip.
  BOLD.cannotReason = function(area, what){
    var level = levelFor(area, what || 'view');
    return level === 'none' ? 'Nobody can do this here.' : 'For ' + LEVEL_NAMES[level] + ' and above (BOLDiquette › Who can see what).';
  };
  BOLD.myGroup = function(){ return access ? access.group : null; };
  // fn(access) once known and on every change; replayed at once if known.
  BOLD.onAccess = function(fn){ accessListeners.push(fn); if (access) fn(access); };
  function loadAccess(user){
    if (!firebase.firestore) return;
    var db = firebase.firestore(BOLD.getApp());
    var table = db.collection('settings').doc('access').get().then(function(s){ return (s.exists && s.data().pages) || {}; }).catch(function(){ return {}; });
    if (!user) { table.then(function(pages){ setAccess({ e: '', group: 'everyone', pages: pages }); }); return; }
    var mine = db.collection('members').doc(String(user.email || '').toLowerCase()).get().then(function(s){
      var c = s.exists && s.data().category;
      return LEVELS.indexOf(c) > 0 && c !== 'none' ? c : 'pan';
    }).catch(function(){ return 'pan'; });
    Promise.all([table, mine]).then(function(r){
      setAccess({ e: user.email || '', group: r[1], pages: r[0] });
      // PIs and admins count as BOLD-exec, which only the server knows.
      if (r[1] !== 'exec' && firebase.functions) {
        firebase.app().functions('europe-west2').httpsCallable('getMyAccess')().then(function(x){
          var d = x.data || {};
          if (d.group && d.group !== r[1]) setAccess({ e: user.email || '', group: d.group, pages: d.pages || r[0] });
        }).catch(function(){});
      }
    });
  }

  /* ---------- shell: sidebar state + gating ---------- */

  // The gate when signed in but the page is for groups above theirs.
  function showLevelGate(gate, area){
    if (!gate) return;
    var level = levelFor(area, 'view');
    gate.innerHTML = '<div class="gate-box"><h1>Not open to your group</h1>' +
      '<p>This page is for ' + esc(LEVEL_NAMES[level]) + ' and above; you’re in ' + esc(LEVEL_NAMES[access.group] || 'PAN-BOLD') + '. ' +
      '<a href="boldiquette.html#access">Who can see what</a>.</p>' +
      '<a class="gate-signup-btn" href="profile.html">Ask for another group on your profile</a></div>';
    gate.hidden = false;
  }

  // Called right after the opening <div class="shell">.
  BOLD.mountShell = function(){
    var shell = document.getElementById('shell');
    // Saved sidebar state, applied before first paint so it doesn't animate in.
    try { if (localStorage.getItem('boldNavCollapsed') === '1') shell.classList.add('is-collapsed'); } catch (e){}
    if (BOLD.getAuth()) BOLD.onUser(loadAccess);
    if (shell.hasAttribute('data-public')) return;
    // The page's area in Who can see what (front matter `area`); without one, BOLD-internal's.
    var area = shell.getAttribute('data-area') || 'internal';

    // Gated page: hidden until signed in and allowed. A cached sign-in shows it at once
    // instead of after Firebase Auth resolves; auth stays authoritative.
    shell.hidden = !hint || !BOLD.can(area, 'view');
    if (!BOLD.getAuth()) {
      document.addEventListener('DOMContentLoaded', function(){
        var gate = document.getElementById('pageGate');
        shell.hidden = true;
        if (!gate) return;
        gate.hidden = false;
        var p = gate.querySelector('p');
        if (p) p.textContent = 'Could not connect — reload, or check back shortly.';
      });
      return;
    }
    BOLD.onUser(function(user){
      var gate = document.getElementById('pageGate');
      if (gate) gate.hidden = !!user;
      if (!user) shell.hidden = true;
    });
    BOLD.onAccess(function(a){
      if (!a.e) return;   // signed out: the sign-in gate above
      var ok = BOLD.can(area, 'view');
      shell.hidden = !ok;
      if (!ok) {
        var show = function(){ showLevelGate(document.getElementById('pageGate'), area); };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
      }
    });
  };

  // The sidebar shows only the pages the viewer may view ([data-area] on its groups and links).
  function sidebarAccess(){
    BOLD.onAccess(function(){
      Array.prototype.forEach.call(document.querySelectorAll('#sidebar [data-area]'), function(el){
        el.hidden = !BOLD.can(el.getAttribute('data-area'), 'view');
      });
    });
  }

  /* ---------- sidebar: BOLDiquette's sections, the events, the skills and the guides ---------- */

  // A group's sub-links come from Firestore: [data-nav-<key>] is filled from
  // load() → [{ title, href }]. The last list seen paints first (localStorage
  // `cacheKey`); Firestore stays authoritative.
  function firestoreNav(key, cacheKey, area, load){
    var group = document.querySelector('[data-nav-' + key + ']');
    if (!group) return;
    var page = location.pathname.split('/').pop() || 'index.html';
    function draw(list){
      Array.prototype.forEach.call(group.querySelectorAll('.nav-sub'), function(a){ a.remove(); });
      var label = group.querySelector('.nav-group-label');
      var anyActive = false;
      list.forEach(function(e){
        var a = document.createElement('a');
        a.className = 'nav-link nav-sub';
        a.href = e.href;
        a.textContent = e.title;
        a.title = e.title;
        var on = e.href === page || e.href === page + location.search;
        if (on) { a.classList.add('active'); anyActive = true; }
        group.appendChild(a);
      });
      if (anyActive) label.classList.remove('active');
    }
    try { draw(JSON.parse(localStorage.getItem(cacheKey) || '[]')); } catch (e){}
    BOLD.onAccess(function(){
      if (!BOLD.can(area, 'view') || !firebase.firestore) return;
      load(firebase.firestore(BOLD.getApp())).then(function(list){
        draw(list);
        try { localStorage.setItem(cacheKey, JSON.stringify(list)); } catch (e){}
      }).catch(function(err){ console.error('[BOLD Lab] loading the ' + key + ' for the sidebar failed', err); });
    });
  }

  // The released events (events/{slug}, hidden == false — see events-common.js),
  // newest first: an event with its own page links there, the rest to
  // event.html?event=<slug>.
  function eventsNav(){
    firestoreNav('events', 'boldNavEvents', 'events', function(db){
      return db.collection('events').where('hidden', '==', false).get().then(function(snap){
        return snap.docs.map(function(d){ return d.data(); }).filter(function(e){ return e.slug && e.title; })
          .sort(function(a, b){ return a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : 0; })
          .map(function(e){ return { title: e.title, href: e.page || 'event.html?event=' + encodeURIComponent(e.slug) }; });
      });
    });
  }

  // The skills (skills/{name} — see skills-common.js), by title.
  function skillsNav(){
    firestoreNav('skills', 'boldNavSkills', 'skills', function(db){
      return db.collection('skills').get().then(function(snap){
        return snap.docs.map(function(d){ return d.data(); }).filter(function(x){ return x.name; })
          .map(function(x){ return { title: x.title || x.name, href: 'skill.html?skill=' + encodeURIComponent(x.name) }; })
          .sort(function(a, b){ return a.title.localeCompare(b.title); });
      });
    });
  }

  // The how-to guides (guides/{slug} — see guides-common.js), by title.
  function guidesNav(){
    firestoreNav('guides', 'boldNavGuides', 'guides', function(db){
      return db.collection('guides').get().then(function(snap){
        return snap.docs.map(function(d){ return d.data(); }).filter(function(x){ return x.slug && !BOLD.GUIDE_PAGES[x.slug]; })
          .map(function(x){ return { title: x.title || x.slug, href: 'guide.html?guide=' + encodeURIComponent(x.slug) }; })
          .sort(function(a, b){ return a.title.localeCompare(b.title); });
      });
    });
  }

  // BOLDiquette's sections (handbook/boldiquette — see pages/guide.js), in
  // order, each linking to its heading on the page.
  function handbookNav(){
    firestoreNav('handbook', 'boldNavHandbook', 'boldiquette', function(db){
      return db.collection('handbook').doc('boldiquette').get().then(function(snap){
        var out = [];
        ((snap.exists && snap.data().parts) || []).forEach(function(p){
          if (p.section && !out.some(function(e){ return e.title === p.section; }))
            out.push({ title: p.section, href: 'boldiquette.html#' + BOLD.slugify(p.section) });
        });
        return out;
      });
    });
  }

  /* ---------- behaviour: gate button, sidebar collapse, mobile drawer ---------- */

  document.addEventListener('DOMContentLoaded', function(){
    var gateBtn = document.getElementById('gateSignInBtn');
    if (gateBtn) gateBtn.addEventListener('click', function(){ BOLD.signIn(); });

    var shell = document.getElementById('shell');
    if (!shell) return;
    if (BOLD.getAuth()) { sidebarAccess(); handbookNav(); eventsNav(); skillsNav(); guidesNav(); }
    var toggle = document.getElementById('navToggle');
    var collapse = document.getElementById('sidebarCollapse');
    var backdrop = document.getElementById('sidebarBackdrop');
    var sidebar = document.getElementById('sidebar');

    function setCollapsed(on){
      shell.classList.toggle('is-collapsed', on);
      if (collapse){
        collapse.innerHTML = on ? '&raquo;' : '&laquo;';
        collapse.setAttribute('aria-label', on ? 'Expand navigation' : 'Collapse navigation');
      }
      try { localStorage.setItem('boldNavCollapsed', on ? '1' : '0'); } catch (e){}
    }
    function openNav(){
      shell.classList.add('is-nav-open');
      if (toggle) toggle.setAttribute('aria-expanded', 'true');
    }
    function closeNav(){
      shell.classList.remove('is-nav-open');
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
    }

    if (collapse) collapse.addEventListener('click', function(){
      setCollapsed(!shell.classList.contains('is-collapsed'));
    });
    if (toggle) toggle.addEventListener('click', function(){
      if (shell.classList.contains('is-nav-open')) { closeNav(); } else { openNav(); }
    });
    if (backdrop) backdrop.addEventListener('click', closeNav);
    // Clicking the wordmark takes you home; land there with the menu
    // retracted rather than however it happened to be left on this page.
    var wordmark = document.querySelector('.wordmark');
    if (wordmark) wordmark.addEventListener('click', function(){
      try { localStorage.setItem('boldNavCollapsed', '1'); } catch (e){}
    });
    if (sidebar){
      Array.prototype.slice.call(sidebar.querySelectorAll('.nav-link, .nav-group-label')).forEach(function(a){
        a.addEventListener('click', closeNav);
      });
      // A group's dash fixes it open or closed: an open group (on its own
      // page, or fixed open) closes; any other opens. A closed group still
      // opens on hover. Remembered per group
      // (by its page) across pages.
      var fixed = {};
      try { fixed = JSON.parse(localStorage.getItem('boldNavGroups') || '{}') || {}; } catch (e){}
      Array.prototype.slice.call(sidebar.querySelectorAll('.nav-group')).forEach(function(group){
        var key = group.querySelector('.nav-group-label').getAttribute('href');
        var btn = group.querySelector('.nav-group-toggle');
        var label = group.querySelector('.nav-group-label').textContent;
        function isOpen(){
          return group.classList.contains('is-pinned') || (!group.classList.contains('is-shut') && !!group.querySelector('.active'));
        }
        function show(state){
          group.classList.toggle('is-pinned', state === 'open');
          group.classList.toggle('is-shut', state === 'closed');
          var open = isOpen();
          btn.setAttribute('aria-expanded', open ? 'true' : 'false');
          btn.setAttribute('aria-label', (open ? 'Close ' : 'Open ') + label);
          btn.title = open ? 'Close' : 'Keep open';
        }
        show(fixed[key]);
        // Just closed: hidden even while hovered, until the mouse leaves.
        group.addEventListener('mouseleave', function(){ group.classList.remove('is-hushed'); });
        btn.addEventListener('click', function(){
          var state = isOpen() ? 'closed' : 'open';
          show(state);
          group.classList.toggle('is-hushed', state === 'closed');
          fixed[key] = state;
          try { localStorage.setItem('boldNavGroups', JSON.stringify(fixed)); } catch (e){}
        });
      });
    }
    document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeNav(); });

    try {
      if (localStorage.getItem('boldNavCollapsed') === '1') setCollapsed(true);
    } catch (e){}
  });
})();
