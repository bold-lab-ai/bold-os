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

  BOLD.escapeHtml = function(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  };
  var esc = BOLD.escapeHtml;

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

  // onError(err), if given, runs after the failure is logged.
  BOLD.signIn = function(onError){
    var a = BOLD.getAuth();
    if (!a) return;
    var provider = new firebase.auth.OAuthProvider('oidc.slack');
    provider.addScope('openid');
    provider.addScope('profile');
    provider.addScope('email');
    a.signInWithPopup(provider).catch(function(err){
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

  /* ---------- behaviour: gate button, sidebar collapse, mobile drawer ---------- */

  document.addEventListener('DOMContentLoaded', function(){
    var gateBtn = document.getElementById('gateSignInBtn');
    if (gateBtn) gateBtn.addEventListener('click', function(){ BOLD.signIn(); });

    var shell = document.getElementById('shell');
    if (!shell) return;
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
