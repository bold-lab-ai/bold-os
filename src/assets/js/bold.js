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
  var esc = BOLD.escapeHtml;

  /* ---------- copy boxes ---------- */

  // The site's one way to offer text to copy: a code box with the clipboard
  // icon inside it, top right (.copy-box in bold.css). Any .copy-btn copies the
  // text of the <pre> beside it and shows a tick for a moment.
  var ICON_COPY = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  var ICON_DONE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
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
      current = user; authReady = true;
      try {
        if (user) localStorage.setItem('boldAuthHint', JSON.stringify({ n: user.displayName || '', e: user.email || '' }));
        else localStorage.removeItem('boldAuthHint');
      } catch (e){}
      listeners.slice().forEach(function(fn){ fn(user); });
    });
    // Finishes a sign-in after Slack redirects back here; onAuthStateChanged
    // above picks up the user, this only surfaces errors from the round trip.
    auth.getRedirectResult().catch(function(err){
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

  /* ---------- shell: sidebar state + gating ---------- */

  // Called right after the opening <div class="shell">.
  BOLD.mountShell = function(){
    var shell = document.getElementById('shell');
    // Saved sidebar state, applied before first paint so it doesn't animate in.
    try { if (localStorage.getItem('boldNavCollapsed') === '1') shell.classList.add('is-collapsed'); } catch (e){}
    if (shell.hasAttribute('data-public')) return;

    // Gated page: hidden until signed in. A cached sign-in shows it at once
    // instead of after Firebase Auth resolves; auth stays authoritative.
    shell.hidden = !hint;
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
      shell.hidden = !user;
    });
  };

  /* ---------- sidebar: the events, the skills and the guides ---------- */

  // A group's sub-links come from Firestore: [data-nav-<key>] is filled from
  // load() → [{ title, href }]. The last list seen paints first (localStorage
  // `cacheKey`); Firestore stays authoritative.
  function firestoreNav(key, cacheKey, load){
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
        var on = e.href === page || e.href === page + location.search;
        if (on) { a.classList.add('active'); anyActive = true; }
        group.appendChild(a);
      });
      if (anyActive) label.classList.remove('active');
    }
    try { draw(JSON.parse(localStorage.getItem(cacheKey) || '[]')); } catch (e){}
    BOLD.onUser(function(user){
      if (!user || !firebase.firestore) return;
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
    firestoreNav('events', 'boldNavEvents', function(db){
      return db.collection('events').where('hidden', '==', false).get().then(function(snap){
        return snap.docs.map(function(d){ return d.data(); }).filter(function(e){ return e.slug && e.title; })
          .sort(function(a, b){ return a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : 0; })
          .map(function(e){ return { title: e.title, href: e.page || 'event.html?event=' + encodeURIComponent(e.slug) }; });
      });
    });
  }

  // The skills (skills/{name} — see skills-common.js), by title.
  function skillsNav(){
    firestoreNav('skills', 'boldNavSkills', function(db){
      return db.collection('skills').get().then(function(snap){
        return snap.docs.map(function(d){ return d.data(); }).filter(function(x){ return x.name; })
          .map(function(x){ return { title: x.title || x.name, href: 'skill.html?skill=' + encodeURIComponent(x.name) }; })
          .sort(function(a, b){ return a.title.localeCompare(b.title); });
      });
    });
  }

  // The how-to guides (guides/{slug} — see guides-common.js), by title.
  function guidesNav(){
    firestoreNav('guides', 'boldNavGuides', function(db){
      return db.collection('guides').get().then(function(snap){
        return snap.docs.map(function(d){ return d.data(); }).filter(function(x){ return x.slug; })
          .map(function(x){ return { title: x.title || x.slug, href: 'guide.html?guide=' + encodeURIComponent(x.slug) }; })
          .sort(function(a, b){ return a.title.localeCompare(b.title); });
      });
    });
  }

  /* ---------- behaviour: gate button, sidebar collapse, mobile drawer ---------- */

  document.addEventListener('DOMContentLoaded', function(){
    var gateBtn = document.getElementById('gateSignInBtn');
    if (gateBtn) gateBtn.addEventListener('click', function(){ BOLD.signIn(); });

    var shell = document.getElementById('shell');
    if (!shell) return;
    if (BOLD.getAuth()) { eventsNav(); skillsNav(); guidesNav(); }
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
    }
    document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeNav(); });

    try {
      if (localStorage.getItem('boldNavCollapsed') === '1') setCollapsed(true);
    } catch (e){}
  });
})();
