(function(){
  var masthead = document.getElementById('masthead');
  var shell = document.getElementById('shell');
  var sidebar = document.getElementById('sidebar');
  var navToggle = document.getElementById('navToggle');
  var guestNote = document.getElementById('homeGuestNote');
  var heroSignInBtn = document.getElementById('homeSignInBtn');
  var heroTitle = document.getElementById('homeHeroTitle');
  var chromeRevealed = false;
  // A signed-in visitor who hasn't clicked "BOLD.OS" within this long gets the
  // click simulated for them — once per page load, so it never re-opens menus
  // they've closed.
  var AUTO_REVEAL_MS = 600;
  var autoRevealTimer = null;
  var autoRevealDone = false;
  function cancelAutoReveal(){
    if (autoRevealTimer){ clearTimeout(autoRevealTimer); autoRevealTimer = null; }
    autoRevealDone = true;
  }

  if (heroSignInBtn) heroSignInBtn.addEventListener('click', BOLD.signIn);

  // Reveals the masthead + sidebar with .sidebar's own transition (see
  // its CSS) rather than the instant [hidden] cut a signed-in visitor got
  // before 2026-09-18+5. Idempotent and only meaningful once signed in —
  // renderGuestChrome below re-collapses (and un-reveals) on sign-out, so
  // a later sign-in starts collapsed again rather than staying open from
  // a previous session.
  function revealChrome(){
    if (chromeRevealed) return;
    chromeRevealed = true;
    if (shell) shell.classList.remove('chrome-collapsed');
    if (masthead) masthead.classList.remove('chrome-collapsed');
    // A stored "collapsed" preference would otherwise open only the 40px
    // rail; clicking the hero means "open it", so expand fully through the
    // sidebar's own button (which also updates its icon and stored state).
    var railBtn = document.getElementById('sidebarCollapse');
    if (shell && railBtn && shell.classList.contains('is-collapsed')) railBtn.click();
  }
  // The reverse of revealChrome(): "BOLD.OS" cycles the menus open and closed.
  function hideChrome(){
    if (!chromeRevealed) return;
    chromeRevealed = false;
    if (shell) shell.classList.add('chrome-collapsed');
    if (masthead) masthead.classList.add('chrome-collapsed');
    syncHeroLabel();
  }
  function toggleChrome(){
    if (chromeRevealed) hideChrome(); else { revealChrome(); syncHeroLabel(); }
  }
  function syncHeroLabel(){
    if (heroTitle && chromeIsClickable) heroTitle.setAttribute('aria-label', chromeRevealed ? 'Hide navigation' : 'Show navigation');
  }
  var chromeIsClickable = false;
  if (heroTitle){
    heroTitle.addEventListener('click', function(){ if (chromeIsClickable){ cancelAutoReveal(); toggleChrome(); } });
    heroTitle.addEventListener('keydown', function(e){
      if (chromeIsClickable && (e.key === 'Enter' || e.key === ' ')){ e.preventDefault(); cancelAutoReveal(); toggleChrome(); }
    });
  }
  // The masthead's own "BOLD.OS" links home, which is where we already are:
  // here it closes the menus instead of reloading. Capture phase on document,
  // so it runs before bold.js's wordmark handler (which would store "collapsed").
  document.addEventListener('click', function(e){
    var w = e.target.closest && e.target.closest('.wordmark');
    if (!w || !chromeIsClickable) return;
    e.preventDefault();
    e.stopPropagation();
    cancelAutoReveal();
    hideChrome();
  }, true);

  // The homepage's own content (the hero) stays public either way — a
  // signed-out visitor gets no masthead and no sidebar at all, just the
  // hero plus its own brief sign-up/log-in line; the masthead (with its
  // sidebar-only "Internal" branding) only makes sense once someone's
  // actually signed in. Toggling `hidden` on plain wrappers rather than
  // on .masthead/.gate-signup-btn/.auth-signin themselves matters: those
  // classes set their own `display`, which as an author rule beats the
  // browser's default [hidden]{display:none} at equal specificity, so
  // hidden silently does nothing on them directly (see .masthead[hidden]
  // and #pageGate[hidden] on the other pages for the same fix).
  //
  // For a signed-in visitor, masthead/sidebar are unhidden (mounted) but
  // start in the CSS-driven .chrome-collapsed state instead of appearing
  // outright — clicking the "BOLD.OS" hero heading is what actually
  // reveals them, via revealChrome() above (2026-09-18+5, per Eduardo).
  function renderGuestChrome(signedIn){
    if (masthead) masthead.hidden = !signedIn;
    if (sidebar) sidebar.hidden = !signedIn;
    if (navToggle) navToggle.hidden = !signedIn;
    if (guestNote) guestNote.hidden = signedIn;
    chromeIsClickable = signedIn;
    if (heroTitle){
      heroTitle.classList.toggle('hero-clickable', signedIn);
      if (signedIn){
        heroTitle.setAttribute('role', 'button');
        heroTitle.setAttribute('tabindex', '0');
        syncHeroLabel();
      } else {
        heroTitle.removeAttribute('role');
        heroTitle.removeAttribute('tabindex');
        heroTitle.removeAttribute('aria-label');
      }
    }
    if (signedIn){
      // Guard on chromeRevealed so a second onAuthStateChanged firing
      // while still signed in (e.g. a token refresh) can't re-collapse
      // chrome the visitor already opened this session.
      if (!chromeRevealed){
        if (shell) shell.classList.add('chrome-collapsed');
        if (masthead) masthead.classList.add('chrome-collapsed');
        if (!autoRevealDone && !autoRevealTimer){
          autoRevealTimer = setTimeout(function(){
            autoRevealTimer = null;
            autoRevealDone = true;
            if (chromeIsClickable && !chromeRevealed) toggleChrome();
          }, AUTO_REVEAL_MS);
        }
      }
    } else {
      // Signed out: drop the pending auto-open, but let a later sign-in
      // on this page start a fresh countdown.
      if (autoRevealTimer){ clearTimeout(autoRevealTimer); autoRevealTimer = null; }
      chromeRevealed = false;
      if (shell) shell.classList.remove('chrome-collapsed');
      if (masthead) masthead.classList.remove('chrome-collapsed');
    }
  }

  if (!BOLD.getAuth()) {
    renderGuestChrome(false);
  } else {
    // Auth restores asynchronously, so without this the hero's pointer
    // cursor and click handler only arrive after a beat. The cached hint
    // from the last signed-in visit sets them up front; onAuthStateChanged
    // below corrects it if the session has since expired.
    if (BOLD.authHint()) renderGuestChrome(true);
    BOLD.onUser(function(user){ renderGuestChrome(!!user); });
  }
  // Your next steps, for whoever just joined BOLD or a new group (#152): the Get started
  // checklist's steps for everyone and those under their group's heading (BoldJoin.sectionsFor),
  // read from the guide, so they change as it does. Shown until they say Done, and again
  // after each change of group (bold.js sends them here then: #next-steps); "Your next
  // steps" brings it back. Done is remembered in this browser, per group.
  (function(){
    var box = document.getElementById('next-steps');
    if (!box || !window.BoldJoin || !window.BoldMarkdown) return;
    var body = null, mine = null, email = '', open = false;
    var key = function(){ return 'boldStepsDone:' + email; };
    var store = function(v){ try { if (v === undefined) return localStorage.getItem(key()); localStorage.setItem(key(), v); } catch (e){ return null; } };
    var links = function(md){ return BoldMarkdown.render(md.replace(/\]\(#/g, '](get-started.html#')); };
    function render(){
      if (body === null || !mine) return;
      var done = store() === mine && !open && location.hash !== '#next-steps';
      if (done) { box.innerHTML = '<button type="button" class="btn-text home-steps-again">Your next steps</button>'; box.hidden = false; return; }
      var s = BoldJoin.sectionsFor(body, mine);
      box.innerHTML = '<p class="home-steps-head">Welcome to ' + BoldJoin.groupBadge(mine) + '. Your next steps:</p>' +
        '<div class="home-steps-text">' + (s.common ? links(s.common) : '') + (s.group ? '<p class="home-steps-sub">For ' + BoldJoin.groupBadge(mine) + '</p>' + links(s.group) : '') +
          (!s.common && !s.group ? '<p>None yet: <a href="get-started.html">propose some</a>.</p>' : '') + '</div>' +
        '<p class="home-steps-foot"><a href="get-started.html">Get started at BOLD</a> · <a href="boldiquette.html#who-is-bold">Who is BOLD</a>' +
          '<button type="button" class="btn-box is-primary home-steps-done">Done</button></p>';
      box.hidden = false;
    }
    box.addEventListener('click', function(e){
      if (e.target.closest('.home-steps-done')) {
        store(mine); open = false;
        if (location.hash === '#next-steps') history.replaceState(null, '', location.pathname + location.search);
        render();
      } else if (e.target.closest('.home-steps-again')) { open = true; render(); }
    });
    window.addEventListener('hashchange', function(){ if (location.hash === '#next-steps') { open = true; render(); } });
    var asked = false;
    BOLD.onAccess(function(a){
      // Viewing as a group: what that group would see, never saved as Done.
      if (!a || a.group === 'out') { box.hidden = true; return; }
      mine = a.group; email = a.e; render();
      if (asked) return;
      asked = true;
      firebase.firestore(BOLD.getApp()).collection('guides').doc('get-started-at-bold').get().then(function(s){
        var p = ((s.exists && s.data().parts) || []).filter(function(x){ return x.id === 'everyone'; })[0];
        body = (p && p.body) || ''; render();
      }).catch(function(err){ console.error('[BOLD Home] loading the Get started checklist failed', err); });
    });
  })();
})();
