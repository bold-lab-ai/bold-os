/* Shared BOLD OS chrome. One <script src="bold.js"> in each page's <head>
   (classic, synchronous — it document.writes what has to exist before the
   body parses) replaces the per-page copies of: the design-system CSS, the
   font links, the Firebase SDK tags + config, the sign-in flow, the
   masthead, the sidebar nav, the sign-in gate, the footer and the nav open/collapse
   behaviour.

   No build step, and it works from file:// (no fetch, no modules).

   Page contract:

     <script src="bold.js"></script>                 <!-- or data-sdk="firestore,functions" -->
     ...
     <bold-masthead></bold-masthead>
     <bold-gate></bold-gate>                         <!-- omit on public pages -->
     <bold-shell [active="page.html"]>               <!-- omit `active` to match the URL -->
       <div class="shell-main"> ...page... <bold-footer></bold-footer> </div>
     </bold-shell>

   Navigation lives in BOLD.nav below — the only place to add or rename a
   link. Page code talks to auth through BOLD.onUser / BOLD.signIn /
   BOLD.signOut / BOLD.getApp instead of initialising Firebase itself. */
(function(){
  var script = document.currentScript;
  var BASE = script.src.replace(/[^\/]*$/, '');
  var FIREBASE_VERSION = '10.14.1';

  var BOLD = window.BOLD = window.BOLD || {};

  BOLD.firebaseConfig = {
    apiKey: 'AIzaSyDNKEMYuV0gehbKoM2acafzVbBQL489yDY',
    authDomain: 'bold-d7ff2.firebaseapp.com',
    projectId: 'bold-d7ff2',
    storageBucket: 'bold-d7ff2.firebasestorage.app',
    messagingSenderId: '555050367135',
    appId: '1:555050367135:web:d90f8d7bb93a755e9fcaaa',
    measurementId: 'G-527H8R28KB'
  };
  BOLD.useAuthEmulator = false;
  BOLD.repoUrl = 'https://github.com/bold-lab-ai/bold-os';

  // href is the page a group's label opens; links are its sub-pages.
  BOLD.nav = [
    { label: 'ML Conference Cycle', href: 'how-to-submit-a-paper.html', links: [
      { label: 'Guide', href: 'how-to-submit-a-paper.html' },
      { label: 'Internal review board', href: 'audit-board.html' }
    ]},
    { label: 'Events', href: 'events.html', links: [
      { label: 'Collaboration Week', href: 'event-collaboration-week.html' },
      { label: 'BOLD Festival 2026', href: 'event-bold-festival.html' }
    ]}
  ];

  BOLD.escapeHtml = function(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  };
  var esc = BOLD.escapeHtml;

  /* ---------- what has to be in <head> before the body parses ---------- */

  var hint = null;
  try { hint = JSON.parse(localStorage.getItem('boldAuthHint') || 'null'); } catch (e){}
  // Signed in last visit: lets page CSS keep "sign in" panels out of the first paint.
  if (hint) document.documentElement.classList.add('auth-hint');

  var fonts = 'https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;0,700;0,800;1,400' +
              '&family=Cabin:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap';
  var sdks = ['app', 'auth'].concat((script.getAttribute('data-sdk') || '').split(',').filter(Boolean));
  var head =
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="' + fonts + '" rel="stylesheet">' +
    '<link rel="stylesheet" href="' + BASE + 'bold.css">';
  sdks.forEach(function(name){
    head += '<script src="https://www.gstatic.com/firebasejs/' + FIREBASE_VERSION + '/firebase-' + name + '-compat.js"><\/script>';
  });
  document.write(head);

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

  /* ---------- <bold-masthead> ---------- */

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

  class BoldMasthead extends HTMLElement {
    connectedCallback(){
      // `start-hidden`: the page (the homepage) decides when to show it.
      var hidden = this.hasAttribute('start-hidden') ? ' hidden' : '';
      this.innerHTML =
        '<div class="masthead" id="masthead"' + hidden + '>' +
          '<div class="masthead-left">' +
            '<button class="nav-toggle" id="navToggle" type="button" aria-label="Toggle navigation" aria-expanded="false" aria-controls="sidebar"' + hidden + '><span></span></button>' +
            '<div class="masthead-brand">' +
              '<a class="wordmark" href="index.html"><strong>BOLD</strong><span>.</span>OS</a>' +
              '<div class="masthead-sub">Internal</div>' +
            '</div>' +
          '</div>' +
          '<div class="masthead-right"><div id="authRegion"></div></div>' +
        '</div>';
      var region = this.querySelector('#authRegion');
      // Paint the last visit's name at once; auth stays authoritative.
      if (hint) renderAuthRegion(region, { displayName: hint.n, email: hint.e });
      BOLD.onUser(function(user){ renderAuthRegion(region, user); });
    }
  }

  /* ---------- <bold-gate> ---------- */

  class BoldGate extends HTMLElement {
    connectedCallback(){
      this.innerHTML =
        '<div id="pageGate" hidden>' +
          '<div class="gate-box">' +
            '<h1>Sign in required</h1>' +
            '<p>This is an internal BOLD Lab page. Sign in with Slack to continue.</p>' +
            '<button class="auth-signin" id="gateSignInBtn" type="button">Sign in with Slack</button>' +
            '<p class="gate-alt">Not in the BOLD Slack yet?</p>' +
            '<a class="gate-signup-btn" href="https://forms.gle/VzGbWVyERN9v1qJC8" target="_blank" rel="noopener">Sign up here</a>' +
          '</div>' +
        '</div>';
      this.querySelector('#gateSignInBtn').addEventListener('click', BOLD.signIn);
    }
  }

  /* ---------- <bold-shell> ---------- */

  function pageName(){
    return location.pathname.split('/').pop() || 'index.html';
  }

  function navHtml(active){
    // A group's label is "active" only when its own page is the current one
    // and none of its sub-links is (the Guide link and its label share an href).
    return BOLD.nav.map(function(group){
      var subActive = group.links.some(function(l){ return l.href === active; });
      var labelCls = 'nav-group-label' + (!subActive && group.href === active ? ' active' : '');
      return '<div class="nav-group">' +
        '<a class="' + labelCls + '" href="' + esc(group.href) + '">' + esc(group.label) + '</a>' +
        group.links.map(function(l){
          return '<a class="nav-link nav-sub' + (l.href === active ? ' active' : '') + '" href="' + esc(l.href) + '">' + esc(l.label) + '</a>';
        }).join('') +
      '</div>';
    }).join('');
  }

  class BoldShell extends HTMLElement {
    connectedCallback(){
      var isPublic = this.hasAttribute('public');
      this.id = 'shell';
      this.classList.add('shell');
      // Saved sidebar state, applied before first paint so it doesn't animate in.
      try { if (localStorage.getItem('boldNavCollapsed') === '1') this.classList.add('is-collapsed'); } catch (e){}
      this.insertAdjacentHTML('afterbegin',
        '<button class="sidebar-backdrop" id="sidebarBackdrop" type="button" aria-label="Close navigation"></button>' +
        '<nav class="sidebar" id="sidebar" aria-label="Site navigation"' + (this.hasAttribute('start-hidden') ? ' hidden' : '') + '>' +
          '<div class="sidebar-inner">' +
            '<div class="sidebar-head">' +
              '<span class="sidebar-title">Menu</span>' +
              '<button class="sidebar-collapse" id="sidebarCollapse" type="button" aria-label="Collapse navigation" title="Collapse">&laquo;</button>' +
            '</div>' +
            '<div class="nav-groups">' + navHtml(this.getAttribute('active') || pageName()) + '</div>' +
          '</div>' +
        '</nav>');
      if (isPublic) return;

      // Gated page: hidden until signed in. A cached sign-in shows it at
      // once instead of after Firebase Auth resolves; auth stays authoritative.
      var shell = this;
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
    }
  }

  /* ---------- <bold-footer> ---------- */

  class BoldFooter extends HTMLElement {
    connectedCallback(){
      this.innerHTML =
        '<footer>An operating system and research model for fundamental AI research in 2026 &middot; ' +
        '<a href="' + esc(BOLD.repoUrl) + '" target="_blank" rel="noopener">View on GitHub</a></footer>';
    }
  }

  customElements.define('bold-masthead', BoldMasthead);
  customElements.define('bold-gate', BoldGate);
  customElements.define('bold-shell', BoldShell);
  customElements.define('bold-footer', BoldFooter);

  /* ---------- nav behaviour: sidebar collapse + mobile drawer ---------- */

  document.addEventListener('DOMContentLoaded', function(){
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
