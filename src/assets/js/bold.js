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
  // Its page in Who can see what, when not How to's (firestore.rules guideArea, functions/access.js GUIDE_AREAS).
  BOLD.GUIDE_AREAS = { 'get-started-at-bold': 'get-started' };
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
  // A proposed change (the BOLDiquette, a guide, a skill, a tool) tells every PI and admin on
  // Slack when it's proposed, edited, withdrawn or decided (functions/index.js onProposed,
  // onProposalDecided): asked every time, as it reaches them all. what: propose | edit |
  // withdraw | accept | decline | restore; who: whoever proposed it (accept, decline); more:
  // what else it does (["Every agent gets it at once"]). → Promise of true to go ahead.
  BOLD.confirmProposal = function(what, who, more){
    var them = who ? who + ', who proposed it,' : 'whoever proposed it';
    var o = {
      propose: ['Propose it?', 'Propose it', 'Send every PI and admin a Slack message asking them to review it'],
      restore: ['Propose restoring it?', 'Propose it', 'Send every PI and admin a Slack message asking them to review it'],
      edit: ['Update your proposed change?', 'Update it', 'Tell every PI and admin on Slack what it is now'],
      withdraw: ['Withdraw your proposed change?', 'Withdraw it', 'Tell every PI and admin on Slack it’s withdrawn'],
      accept: ['Accept it?', 'Accept it', 'Tell ' + them + ' on Slack that you accepted it, and the other PIs and admins'],
      decline: ['Decline it?', 'Decline it', 'Tell ' + them + ' on Slack that you declined it, and the other PIs and admins'],
    }[what];
    return BOLD.confirmAction({ title: o[0], go: o[1], effects: (more || []).concat([o[2]]), always: true });
  };
  // The same, asked every time ("Don't ask me again" doesn't skip it): for what reaches many
  // people or leaves BOLD.OS (Calendar, Slack or GitHub invitations, emails, a whole group).
  BOLD.confirmAlways = function(o){ return BOLD.confirmAction(Object.assign({}, o, { always: true })); };
  BOLD.confirmAction = function(o){
    // o.always: asked even with "Don't ask me again" (it reaches many people), and not offered.
    return (o.always ? Promise.resolve(false) : BOLD.getSkipConfirm()).then(function(skip){
      if (skip) return { skip: {} };
      return new Promise(function(resolve){
        var d = document.createElement('dialog');
        d.className = 'confirm-dialog';
        d.innerHTML = '<h2>' + esc(o.title || 'Go ahead?') + '</h2>' +
          ((o.effects || []).length ? '<p>This will:</p><ul>' + o.effects.map(function(e){
            return e.key ? '<li class="confirm-opt"><label><input type="checkbox" checked data-key="' + esc(e.key) + '"> ' + esc(e.text) + '</label></li>' : '<li>' + esc(e.text || e) + '</li>';
          }).join('') + '</ul>' : '') +
          (auth && auth.currentUser && !o.always ? '<label class="confirm-skip"><input type="checkbox"> Don’t ask me again (you can turn it back on in your profile)</label>' : '') +
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

  // View as (#172; functions/index.js onCall): a PI or admin sees the site as a lower group,
  // in this tab, until they stop (the eye chip's panel, or the bar it shows). Every callable then
  // carries viewAs; the server honours it for PIs and admins only, and getMyAccess says so
  // (access.viewAs). The rules still read as them, so data a page reads straight from the
  // database is theirs: the page hides what that group wouldn't see.
  var VIEW_AS = ['staff', 'internal', 'associate', 'pan'];
  var viewAs = null;
  try { viewAs = sessionStorage.getItem('boldViewAs'); } catch (e){}
  if (VIEW_AS.indexOf(viewAs) < 0) viewAs = null;
  BOLD.viewAs = function(){ return viewAs; };
  // The pages' caches of what the server sent are for the other view.
  function dropCaches(){
    try {
      Object.keys(localStorage).forEach(function(k){
        if (/^(boldProfile:|boldProject:|boldProjects:|boldBoardsIndex:|boldAccess$|boldBranches$)/.test(k) && k !== 'boldProjects:view') localStorage.removeItem(k);
      });
    } catch (e){}
  }
  BOLD.setViewAs = function(g){
    try { if (VIEW_AS.indexOf(g) >= 0) sessionStorage.setItem('boldViewAs', g); else sessionStorage.removeItem('boldViewAs'); } catch (e){}
    dropCaches();
    location.reload();
  };

  // Branches (#177): the site as an open proposal would make it, like checking out a git
  // branch: one proposal anywhere (the BOLDiquette, a guide, a skill, a tool, who can see
  // what), chosen on the Version pill under the eye chip, for this tab until you go back to
  // the site now. Each page shows it where it applies (pages/guide.js, skill.js, tool.js);
  // one that changes Who can see what applies its table here (levelFor) and, for PIs and
  // admins, on the server too (every callable carries `branch`: functions/index.js onCall).
  // branch: { ref (the proposal's path), num, title, url (its page), pages? } or null.
  // ?branch=<path> in the address (a link to one) picks it; `branches` fills in the rest.
  var BRANCH_REF = /^(handbook|guides|skills|agentTools)\/[a-z0-9_-]{1,64}\/proposals\/[A-Za-z0-9]{1,40}$/;
  var branch = null;
  try { branch = JSON.parse(sessionStorage.getItem('boldBranch') || 'null'); } catch (e){}
  (function(){
    var linked = '';
    try { linked = new URLSearchParams(location.search).get('branch') || ''; } catch (e){}
    if (BRANCH_REF.test(linked) && (!branch || branch.ref !== linked)) { branch = { ref: linked, title: '', url: '' }; try { sessionStorage.setItem('boldBranch', JSON.stringify(branch)); } catch (e){} }
  })();
  if (branch && !BRANCH_REF.test(branch.ref || '')) branch = null;
  BOLD.branch = function(){ return branch; };
  // b: a branch from `branches`, or null for the site now. o.go: open its page (else reload this one).
  BOLD.setBranch = function(b, o){
    branch = b && BRANCH_REF.test(b.ref || '') ? { ref: b.ref, num: b.num || 0, title: b.title || '', url: b.url || '', pages: b.pages || null } : null;
    try { if (branch) sessionStorage.setItem('boldBranch', JSON.stringify(branch)); else sessionStorage.removeItem('boldBranch'); } catch (e){}
    // Quiet: no reload (a page showing its own proposal); its details from `branches`, unless they're from there.
    if (o && o.quiet) { drawAccess(); previewBar(); if (branch && !o.known && access && access.e) loadBranches(); return; }
    dropCaches();
    var here = location.pathname + location.search.replace(/([?&])branch=[^&]*&?/, '$1').replace(/[?&]$/, '');
    if (o && o.go && branch && branch.url) location.href = pageOf(branch.url);
    else location.replace(here + location.hash);
  };
  // A page of this site from its full address (as the server gives it), so it opens here
  // whether the site is served from GitHub Pages or a preview.
  function pageOf(url){ try { var u = new URL(url, location.href); return u.pathname.split('/').pop() + u.search; } catch (e){ return url; } }

  // Every callable's data gets viewAs and branch, from wherever the page calls it.
  function viewAsCalls(){
    if (!(viewAs || branch) || !app || typeof app.functions !== 'function' || app.functions.viewAs) return;
    var plain = app.functions;
    var wrapped = function(){
      var f = plain.apply(app, arguments);
      if (f && f.httpsCallable && !f.httpsCallable.viewAs) {
        var hc = f.httpsCallable;
        f.httpsCallable = function(){
          var c = hc.apply(f, arguments);
          return function(d){
            var extra = {};
            if (viewAs) extra.viewAs = viewAs;
            if (branch) extra.branch = branch.ref;
            return c(d == null ? extra : typeof d === 'object' && !Array.isArray(d) ? Object.assign({}, d, extra) : d);
          };
        };
        f.httpsCallable.viewAs = true;
      }
      return f;
    };
    wrapped.viewAs = true;
    app.functions = wrapped;
  }

  /* ---------- Firebase + auth ---------- */

  var app = null, auth = null, authReady = false, current = null, listeners = [];

  BOLD.getApp = function(){
    if (app) return app;
    try { app = firebase.apps.length ? firebase.app() : firebase.initializeApp(BOLD.firebaseConfig); } catch (e){ app = null; }
    viewAsCalls();
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

  // Signed in: your name opens a menu (Profile; Requests, yours (requests.html); Settings, for
  // PIs and admins only, shown once that's known; Sign out). Signed out: Sign in with Slack.
  function renderAuthRegion(region, user){
    if (user) {
      // Your name only (your email is on your profile); without a name, the email.
      var who = esc(user.displayName || user.email || 'Signed in');
      region.innerHTML =
        '<div class="mast-auth mast-menu-wrap">' +
          '<button class="mast-auth-name mast-menu-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="mastMenu">' + who + ' <span class="mast-caret" aria-hidden="true">▾</span></button>' +
          '<ul class="mast-menu" id="mastMenu" role="menu" hidden>' +
            '<li role="none"><a role="menuitem" href="profile.html">Profile</a></li>' +
            '<li role="none"><a role="menuitem" href="requests.html">Requests</a></li>' +
            '<li role="none" class="mast-menu-settings"' + (BOLD.isFullWrite() ? '' : ' hidden') + '><a role="menuitem" href="settings.html">Settings</a></li>' +
            '<li role="none"><button role="menuitem" type="button" id="mastSignOutBtn">Sign out</button></li>' +
          '</ul>' +
        '</div>';
      var btn = region.querySelector('.mast-menu-btn'), menu = region.querySelector('.mast-menu');
      var open = function(yes){ menu.hidden = !yes; btn.setAttribute('aria-expanded', String(yes)); };
      btn.addEventListener('click', function(e){ e.stopPropagation(); open(menu.hidden); });
      document.addEventListener('click', function(e){ if (!region.contains(e.target)) open(false); });
      document.addEventListener('focusin', function(e){ if (!region.contains(e.target)) open(false); });
      region.addEventListener('keydown', function(e){ if (e.key === 'Escape' && !menu.hidden) { open(false); btn.focus(); } });
      region.querySelector('#mastSignOutBtn').addEventListener('click', BOLD.signOut);
    } else {
      region.innerHTML = '<button class="auth-signin" type="button" id="mastSignInBtn">Sign in with Slack</button>';
      region.querySelector('#mastSignInBtn').addEventListener('click', BOLD.signIn);
    }
  }

  // While on a branch or viewing as a group (access.viewAs): a bar saying so, to go back.
  function branchLabel(b){ return b ? (b.num ? '#' + b.num + ' ' : '') + (b.title || 'a proposed change') : 'The site now'; }
  function previewBar(){
    var bar = document.getElementById('viewAsBar'), g = access && access.viewAs;
    if (!g && !branch) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'viewAsBar'; bar.className = 'viewas-bar'; bar.setAttribute('role', 'status');
      document.body.appendChild(bar);
    }
    bar.innerHTML = (branch ? '<span class="vb-part"><span class="vb-text">On ' + esc(branchLabel(branch)) + '</span>' +
        (branch.url && pageOf(branch.url) !== (location.pathname.split('/').pop() || 'index.html') ? ' <a href="' + esc(pageOf(branch.url)) + '">Its page</a>' : '') +
        ' <button type="button" data-vb="branch">Back to the site now</button></span>' : '') +
      (g ? '<span class="vb-part">Viewing as ' + esc(LEVEL_NAMES[g] || g) + ' <button type="button" data-vb="as">Stop</button></span>' : '');
    bar.onclick = function(e){
      var b = e.target.closest('[data-vb]');
      if (!b) return;
      if (b.getAttribute('data-vb') === 'as') BOLD.setViewAs(null); else BOLD.setBranch(null);
    };
  }

  // The open proposals, for the Version pill (`branches`, kept a minute in this tab), and the
  // branch you're on brought up to date from them: gone (accepted, declined or withdrawn
  // meanwhile), you're back on the site now.
  var branchList = null, branchError = false, branchLoading = false;
  function loadBranches(){
    if (branchLoading || !access || !access.e) return;
    try {
      var c = JSON.parse(sessionStorage.getItem('boldBranches') || 'null');
      var fresh = c && c.e === access.e && c.as === (viewAs || '') && Date.now() - c.t < 60000;
      // Not without the branch you're on (one proposed since): asked again.
      if (fresh && (!branch || c.list.some(function(b){ return b.ref === branch.ref; }))) { gotBranches(c.list); return; }
    } catch (e){}
    branchLoading = true;
    withFunctions(function(){
      firebase.app().functions('europe-west2').httpsCallable('branches')().then(function(r){
        var list = (r.data && r.data.branches) || [];
        try { sessionStorage.setItem('boldBranches', JSON.stringify({ e: access.e, as: viewAs || '', t: Date.now(), list: list })); } catch (e){}
        branchLoading = false; gotBranches(list);
      }).catch(function(err){ console.error('[BOLD Lab] loading the open proposals failed', err); branchLoading = false; branchError = true; drawAccess(); });
    });
  }
  function gotBranches(list){
    branchList = list; branchError = false;
    if (branch) {
      var now = list.filter(function(b){ return b.ref === branch.ref; })[0];
      if (!now) { BOLD.setBranch(null); return; }
      // Its table changed (or first known, from a link): the page is drawn again with it.
      if (JSON.stringify(now.pages || null) !== JSON.stringify(branch.pages || null)) { BOLD.setBranch(now); return; }
      BOLD.setBranch(now, { quiet: true, known: true });
      return;
    }
    drawAccess(); previewBar();
  }

  // Called right after the masthead markup.
  BOLD.mountMasthead = function(){
    var region = document.getElementById('authRegion');
    // Paint the last visit's name at once; auth stays authoritative.
    if (hint) renderAuthRegion(region, { displayName: hint.n, email: hint.e });
    BOLD.onUser(function(user){ renderAuthRegion(region, user); });
    // Settings, in the menu, once the viewer is known to be a PI or admin.
    BOLD.onAccess(function(a){
      var g = region.querySelector('.mast-menu-settings'); if (g) g.hidden = !a.fullWrite;
      previewBar();
      if (branch && !branchList) loadBranches();
    });
    alignSearch();
  };

  // The masthead's search starts where the page's content does (its first block's text, after
  // its padding), wherever the sidebar and the window put it; kept so as they change. Where
  // that would run into the wordmark (a narrow window), it stays at the right, in the flow.
  function alignSearch(){
    var mast = document.getElementById('masthead'), box = mast && mast.querySelector('.mast-search');
    if (!box) return;
    var place = function(){
      var main = document.querySelector('.shell-main'), first = main && main.querySelector('.hero, main');
      var brand = mast.querySelector('.masthead-brand');
      if (!first || !brand || !first.getBoundingClientRect().width) { mast.classList.remove('is-search-left'); return; }
      var left = first.getBoundingClientRect().left + parseFloat(getComputedStyle(first).paddingLeft) - mast.getBoundingClientRect().left;
      var fits = left > brand.getBoundingClientRect().right - mast.getBoundingClientRect().left + 24;
      mast.classList.toggle('is-search-left', fits);
      mast.style.setProperty('--search-left', left + 'px');
    };
    var later = function(){ requestAnimationFrame(place); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', later); else later();
    window.addEventListener('load', later);
    window.addEventListener('resize', later);
    // The sidebar opening, closing or sliding, and the page drawing its content.
    if (window.ResizeObserver) { var ro = new ResizeObserver(later); document.addEventListener('DOMContentLoaded', function(){ var m = document.querySelector('.shell-main'); if (m) ro.observe(m); }); }
    document.addEventListener('transitionend', function(e){ if (e.target.classList && e.target.classList.contains('sidebar')) later(); });
  }

  /* ---------- who can see what ---------- */

  // The BOLDiquette's Who can see what (settings/access, functions/access.js): for each
  // page (area), the lowest group of Who is BOLD that may view it, edit on it and propose
  // changes on it. The viewer's group is their members/{email} `category` (PAN-BOLD
  // without one; getMyAccess, where the page has functions, also counts PIs and admins
  // as BOLD-exec). The rules enforce it; this only decides what the page shows.
  // Everyone is everyone signed in, the same as PAN-BOLD; not signed in ('out') is below every level.
  var LEVELS = ['everyone', 'pan', 'associate', 'internal', 'staff', 'exec', 'none'];
  var RANKS = { out: 0, everyone: 1, pan: 1, associate: 2, internal: 3, staff: 4, exec: 5, none: 6 };
  var LEVEL_NAMES = { out: 'not signed in', everyone: 'Everyone', pan: 'PAN-BOLD', associate: 'BOLD-associate', internal: 'BOLD-internal', staff: 'BOLD-staff', exec: 'BOLD-exec', none: 'nobody' };
  function rankOf(level){ return level in RANKS ? RANKS[level] : 3; }
  var access = null, accessListeners = [];
  // The last visit's, for the first paint (same person only).
  try {
    var seen = JSON.parse(localStorage.getItem('boldAccess') || 'null');
    if (seen && hint && seen.e === hint.e && (seen.viewAs || null) === viewAs) access = seen;
  } catch (e){}
  function setAccess(a){
    access = a;
    try { if (a.e) localStorage.setItem('boldAccess', JSON.stringify(a)); else localStorage.removeItem('boldAccess'); } catch (e){}
    accessListeners.slice().forEach(function(fn){ fn(a); });
  }
  // Pages where every change is a proposal someone reviews (functions/access.js REVIEWED).
  var REVIEWED = ['boldiquette', 'guides', 'skills', 'tools', 'get-started'];
  // A page's level for `what`: view, or edit (propose is edit).
  // PAN-BOLD is Everyone (everyone signed in): one level.
  function levelFor(area, what){
    // On a branch that changes Who can see what: the table it would make.
    var pages = (branch && branch.pages) || (access && access.pages);
    var p = (pages && pages[area]) || {};
    var l = (what === 'view' ? p.view : p.edit) || 'internal';
    return l === 'pan' ? 'everyone' : l;
  }
  // Whether the viewer may view | edit | propose on `area` (a page key: projects, …); list:
  // view or edit (on Projects, Edit without View sees the titles and joins; functions/access.js).
  BOLD.can = function(area, what){
    if (!access) return false;
    if (what === 'list') return BOLD.can(area, 'view') || BOLD.can(area, 'edit');
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
    var table = !user ? null : db.collection('settings').doc('access').get().then(function(s){ return (s.exists && s.data().pages) || {}; }).catch(function(){ return {}; });
    if (!user) { setAccess({ e: '', group: 'out', pages: {} }); return; }
    var mine = db.collection('members').doc(String(user.email || '').toLowerCase()).get().then(function(s){
      var c = s.exists && s.data().category;
      return ['exec', 'staff', 'internal', 'associate', 'pan'].indexOf(c) >= 0 ? c : 'pan';
    }).catch(function(){ return 'pan'; });
    Promise.all([table, mine]).then(function(r){
      var known = access && access.e === (user.email || '') ? access : null;
      // Viewing as a group: the server says which (getMyAccess), not the member record.
      if (!viewAs) setAccess({ e: user.email || '', group: known && known.fullWrite ? 'exec' : r[1], pages: r[0], fullWrite: !!(known && known.fullWrite) });
      // PIs and admins count as BOLD-exec and change who can see what, which only the server knows.
      withFunctions(function(){
        firebase.app().functions('europe-west2').httpsCallable('getMyAccess')().then(function(x){
          var d = x.data || {};
          // Asked to view as a group but not a PI or admin: the server ignored it, and so do we.
          if (viewAs && !d.viewAs) { viewAs = null; try { sessionStorage.removeItem('boldViewAs'); } catch (e){} }
          setAccess(Object.assign({ e: user.email || '', group: d.group || r[1], pages: d.pages || r[0], fullWrite: !!d.fullWrite }, d.viewAs ? { viewAs: d.viewAs } : {}));
        }).catch(function(){});
      });
    });
  }
  // fn() once the Functions SDK is there: loaded (same pinned version) if the page hasn't it.
  function withFunctions(fn){
    if (firebase.functions) return fn();
    var app = document.querySelector('script[src*="firebase-app-compat.js"]');
    if (!app) return;
    var el = document.createElement('script');
    el.src = app.src.replace('firebase-app-compat.js', 'firebase-functions-compat.js');
    el.onload = function(){ viewAsCalls(); fn(); };
    document.head.appendChild(el);
  }
  BOLD.isFullWrite = function(){ return !!(access && access.fullWrite); };

  // ---------- who can see this page: a chip at its top right, and its panel ----------
  // The chip says who can see the page; it opens the page's row of the BOLDiquette's Who
  // can see what as a ladder (each group can do what the groups below it can): for each
  // action, the lowest group allowed. Everyone can open it; PIs and admins propose a change
  // there, as a proposal on the BOLDiquette that another PI or admin accepts, and the chip
  // says while one waits.
  // The pages, as the table names them (functions/access.js PAGES, kept in sync by hand).
  var AREA_NAMES = { boldiquette: 'BOLDiquette', projects: 'Projects', profile: 'Your profile', calendar: 'Calendar', 'ml-cycle': 'ML Conference Cycle',
    people: 'People', requests: 'Requests', events: 'Events', agents: 'Agents', tools: 'Tools', skills: 'Skills', guides: 'How to',
    'service-desk': 'Service desk', 'get-started': 'Get started', search: 'Search', changelog: 'Changes' };
  var WHAT = ['view', 'edit'];
  var WHAT_ROW = { view: 'View', edit: 'Edit' };
  var WHAT_VERB = { view: 'view', edit: 'edit' };
  var LADDER = ['everyone', 'associate', 'internal', 'staff', 'exec', 'none'];
  var LADDER_HEAD = { everyone: 'Everyone', pan: 'PAN-BOLD', associate: 'Associate', internal: 'Internal', staff: 'Staff', exec: 'Exec', none: 'Nobody' };
  var ACCESS_INTRO = 'Who can view each page of BOLD.OS, and who can edit it (on the BOLDiquette, How to, Skills and Tools, by proposing). Everyone means everyone signed in; each group can do everything the groups below it can; — is nobody. Only PIs and admins change this table, and who is in which group.';
  var ICON_EYE = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8z"/><circle cx="8" cy="8" r="2"/></svg>';
  var panel = null;      // open: { lv: {view, edit, propose}, note, busy, error, done }
  var waiting = null;    // this page's row in an open proposal: { id, lv } | null
  var waitingUnsub = null;
  function pageArea(){ var sh = document.getElementById('shell'); return sh && sh.getAttribute('data-area'); }
  function currentLevels(area){ var lv = {}; WHAT.forEach(function(w){ lv[w] = levelFor(area, w); }); return lv; }
  function sameLevels(a, b){ return WHAT.every(function(w){ return a[w] === b[w]; }); }
  function groupName(l){ return l === 'everyone' ? 'Everyone' : l === 'none' ? 'Nobody' : LEVEL_NAMES[l]; }
  function who(l){ return l === 'everyone' ? 'Everyone' : l === 'none' ? 'Nobody' : l === 'exec' ? 'BOLD-exec' : LEVEL_NAMES[l] + ' and above'; }
  // One sentence for the ladder: "BOLD-internal and above can view and edit it."
  function sentence(lv){
    if (lv.view === lv.edit) return who(lv.view) + ' can view and edit it.';
    var low = function(l){ var s = who(l); return l === 'none' || l === 'everyone' ? s.charAt(0).toLowerCase() + s.slice(1) : s; };
    return who(lv.view) + ' can view it; ' + low(lv.edit) + ' can edit it.';
  }
  // Pure: a table cell or row ↔ levels, as functions/access.js reads them.
  var norm = function(c){ return String(c || '').replace(/[*_`]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim().toLowerCase(); };
  function levelOfCell(c){
    c = norm(c);
    if (c === '' || c === '-' || c === '—' || c === '–') return 'none';
    return LADDER.filter(function(l){ return norm(groupName(l)) === c; })[0] || null;
  }
  function rowOf(body, area){
    var out = null;
    String(body || '').split('\n').forEach(function(l){
      if (out || !/^\s*\|/.test(l)) return;
      var cells = l.trim().replace(/^\||\|$/g, '').split('|');
      if (norm(cells[0]) !== norm(AREA_NAMES[area])) return;
      // View | Edit; a row as the table first was (View | Edit | Propose) reads as functions/access.js reads it.
      var old = cells.length >= 4, lv = { view: levelOfCell(cells[1]), edit: levelOfCell(cells[old ? (REVIEWED.indexOf(area) >= 0 ? 3 : 2) : 2]) };
      if (lv.view && lv.edit) out = lv;
    });
    return out;
  }
  function accessRow(area, lv){ return '| ' + AREA_NAMES[area] + ' | ' + WHAT.map(function(w){ return lv[w] === 'none' ? '—' : groupName(lv[w]); }).join(' | ') + ' |'; }
  // The part's new body: this page's row replaced (or added), the rest as it is.
  function accessBody(body, area, lv){
    if (!body) {
      var pages = Object.assign({}, access.pages); pages[area] = lv;
      return ACCESS_INTRO + '\n\n| Page | View | Edit |\n|---|---|---|\n' + Object.keys(AREA_NAMES).map(function(k){
        var q = pages[k] || {};
        return accessRow(k, { view: q.view || 'internal', edit: q.edit || 'internal' });
      }).join('\n');
    }
    // In the table headed Page (the part also has the groups' ranks and the roles), as
    // functions/access.js setAccessRow.
    var lines = body.split('\n'), last = -1, done = false, inTable = false;
    lines = lines.map(function(l, i){
      if (!/^\s*\|/.test(l)) { inTable = false; return l; }
      var first = norm(l.trim().replace(/^\|/, '').split('|')[0]);
      if (first === 'page') { inTable = true; last = i; return l; }
      if (!inTable) return l;
      last = i;
      if (first === norm(AREA_NAMES[area])) { done = true; return accessRow(area, lv); }
      return l;
    });
    if (!done) { if (last === -1) lines.push('', '| Page | View | Edit |', '|---|---|---|', accessRow(area, lv)); else lines.splice(last + 1, 0, accessRow(area, lv)); }
    return lines.join('\n');
  }
  // An open proposal changing this page's row (the newest), for the chip and the panel.
  function watchWaiting(){
    if (waitingUnsub) { waitingUnsub(); waitingUnsub = null; }
    waiting = null;
    var area = pageArea();
    if (!area || !access || !access.e || !firebase.firestore || !BOLD.can('boldiquette', 'view')) return;
    waitingUnsub = firebase.firestore(BOLD.getApp()).collection('handbook').doc('boldiquette').collection('proposals')
      .where('status', '==', 'open').onSnapshot(function(snap){
        var cur = currentLevels(area);
        waiting = null;
        snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); }).sort(function(a, b){ return b.at - a.at; }).some(function(q){
          var changes = q.kind === 'batch' ? (q.changes || []) : [q];
          return changes.some(function(c){
            // One row (kind 'access'), or the whole part with this page's row in it.
            var lv = c.kind === 'access' ? (c.area === area && c.after) : c.partId === 'access' && c.after && rowOf(c.after.body, area);
            if (lv && !sameLevels(lv, cur)) { waiting = { id: q.id, lv: lv }; return true; }
            return false;
          });
        });
        drawAccess();
      }, function(){ waiting = null; drawAccess(); });
  }
  function ladderHtml(lv, ghost, editable){
    var head = '<div class="ac-row ac-head"><span></span>' + LADDER.map(function(l){ return '<span' + (l === 'everyone' ? ' title="Everyone signed in (PAN-BOLD and above)"' : '') + '>' + esc(LADDER_HEAD[l]) + '</span>'; }).join('') + '</div>';
    return '<div class="ac-ladder" role="group" aria-label="Who can see this page">' + head + WHAT.map(function(w){
      var at = LADDER.indexOf(lv[w]), ghostAt = ghost ? LADDER.indexOf(ghost[w]) : -1;
      return '<div class="ac-row" role="radiogroup" aria-label="' + esc(WHAT_ROW[w]) + '"><span class="ac-what">' + esc(WHAT_ROW[w]) + '</span>' + LADDER.map(function(l, i){
        var on = lv[w] === 'none' ? l === 'none' : (l !== 'none' && i >= at);
        var cls = 'ac-cell' + (on ? ' is-on' : '') + (i === at ? ' is-pick' : '') + (ghost && (ghost[w] === 'none' ? l === 'none' : l !== 'none' && i >= ghostAt) ? ' is-ghost' : '');
        var tip = who(l) + ' can ' + WHAT_VERB[w] + ' it';
        return '<button type="button" class="' + cls + '" role="radio" aria-checked="' + (i === at) + '" data-what="' + w + '" data-level="' + l + '" title="' + esc(tip) + '"' +
          (editable ? '' : ' disabled') + '><span class="ac-dot"></span></button>';
      }).join('') + '</div>';
    }).join('') + '</div>';
  }
  var brOpen = false;   // the Version pill's list is open
  var ICON_CARET = '<svg class="ac-caret" viewBox="0 0 10 10" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5"/></svg>';
  var ICON_BRANCH = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="5.5" r="1.6"/><path d="M4.5 5.1v5.8M11.5 7.1c0 2.6-2.2 3.4-5.4 4.4"/></svg>';
  function drawAccess(){
    var el = document.getElementById('pageAccess'), area = pageArea();
    if (!el) return;
    if (!area || !AREA_NAMES[area] || !access || !access.e) { el.hidden = true; el.innerHTML = ''; return; }
    var cur = currentLevels(area);
    var html = '<button type="button" class="ac-chip" aria-expanded="' + !!panel + '" aria-controls="acPanel" title="Who can see this page">' + ICON_EYE +
      '<span>' + esc(groupName(cur.view)) + '</span>' + (waiting ? '<span class="ac-waiting">· 1 change waiting</span>' : '') + ICON_CARET + '</button>' +
      // The Version pill (branches): the site now, or as an open proposal would make it.
      '<button type="button" class="ac-chip br-chip' + (branch ? ' is-on' : '') + '" aria-expanded="' + brOpen + '" aria-controls="brPanel" title="See the site as an open proposal would make it">' + ICON_BRANCH +
      '<span class="br-label">' + esc(branchLabel(branch)) + '</span>' + ICON_CARET + '</button>';
    if (brOpen) {
      html += '<div class="ac-panel br-panel" id="brPanel" role="dialog" aria-label="Versions of the site"><div class="ac-title">Version</div>' +
        '<p class="ac-note">See the whole site as an open proposal would make it, before anyone accepts it. Only you see it, in this tab.</p>' +
        '<ul class="br-list"><li><button type="button" class="br-item' + (branch ? '' : ' is-on') + '" data-ref=""><span class="br-t">The site now</span></button></li>' +
        (branchList || []).map(function(b){
          return '<li><button type="button" class="br-item' + (branch && branch.ref === b.ref ? ' is-on' : '') + '" data-ref="' + esc(b.ref) + '">' +
            '<span class="br-t">' + esc(branchLabel(b)) + '</span><span class="br-by">' + esc((b.by ? 'by ' + b.by : '') + (b.pages ? ' · changes who can see what' : '')) + '</span></button></li>';
        }).join('') + '</ul>' +
        (branchError ? '<p class="ev-error">Couldn’t load the proposals — try again.</p>' : !branchList ? '<p class="ac-note">Loading…</p>' : !branchList.length ? '<p class="ac-note">No proposals are open.</p>' : '') +
        '<div class="ac-actions"><button type="button" class="btn-text br-close">Close</button></div></div>';
    }
    if (panel) {
      var can = !!access.fullWrite, lv = panel.lv, changed = !sameLevels(lv, cur);
      html += '<div class="ac-panel" id="acPanel" role="dialog" aria-label="Who can see this page"><div class="ac-title">Who can see ' + esc(AREA_NAMES[area]) + '</div>';
      if (panel.done) html += '<p class="ac-sentence">Proposed. Another PI or admin accepts it on <a href="boldiquette.html#proposal-' + esc(panel.done) + '">the BOLDiquette</a>.</p>' +
        '<div class="ac-actions"><button type="button" class="btn-text ac-close">Close</button></div>';
      else {
        html += ladderHtml(lv, waiting && !changed ? waiting.lv : null, can) +
          '<p class="ac-sentence">' + esc(sentence(lv)) + '</p>' +
          (REVIEWED.indexOf(area) >= 0 ? '<p class="ac-note">Edits here are proposals that a PI or admin reviews.</p>' : '') +
          (waiting && !changed ? '<p class="ac-note">Waiting: ' + esc(sentence(waiting.lv)) + ' <a href="boldiquette.html#proposal-' + esc(waiting.id) + '">See it on the BOLDiquette</a>.</p>' : '');
        // View as: PIs and admins (and whoever is viewing as a group) see the site as a group.
        if (can || access.viewAs) html += '<div class="ac-viewas" role="radiogroup" aria-label="View the site as"><span class="ac-what">View as</span>' +
          VIEW_AS.slice().reverse().concat(['']).map(function(g){
            var on = (access.viewAs || '') === g;
            return '<button type="button" class="ac-as' + (on ? ' is-on' : '') + '" role="radio" aria-checked="' + on + '" data-view-as="' + g + '" title="' + esc(g ? 'See the site as ' + LEVEL_NAMES[g] + ' sees it' : 'See the site as you') + '">' + esc(g === 'pan' ? 'PAN-BOLD' : g ? LADDER_HEAD[g] : 'Yourself') + '</button>';
          }).join('') + '</div>';
        if (!can) html += (access.viewAs ? '' : '<p class="ac-note">Only PIs and admins change this.</p>') + '<div class="ac-actions"><button type="button" class="btn-text ac-close">Close</button></div>';
        else html += (changed ? '<label class="ac-why">Why?<textarea class="ac-note-input" maxlength="1000" rows="2">' + esc(panel.note || '') + '</textarea></label>' : '') +
          '<p class="ev-error"' + (panel.error ? '' : ' hidden') + '>' + esc(panel.error || '') + '</p>' +
          '<div class="ac-actions"><button type="button" class="btn-text ac-close">' + (changed ? 'Cancel' : 'Close') + '</button>' +
          '<button type="button" class="btn-box is-primary ac-propose"' + (!changed || panel.busy ? ' disabled' : '') + (changed ? '' : ' title="Change a row first"') + '>Propose change</button></div>';
      }
      html += '</div>';
    }
    el.innerHTML = html;
    el.hidden = false;
  }
  // For the BOLDiquette's list of proposed changes (pages/guide.js): a one-row proposal in
  // words, and the part with it applied.
  BOLD.accessProposal = {
    pageName: function(area){ return AREA_NAMES[area] || area; },
    levelName: function(l){ return l === 'none' ? '—' : groupName(l); },
    // "Who can see Calendar: View and Edit, BOLD-internal → BOLD-associate"
    describe: function(q){
      var b = q.before || {}, a = q.after || {}, n = BOLD.accessProposal.levelName;
      var ch = WHAT.filter(function(w){ return b[w] !== a[w]; });
      var what = !ch.length ? 'no change' : ch.length === 2 && b.view === b.edit && a.view === a.edit ? 'View and Edit, ' + n(b.view) + ' → ' + n(a.view)
        : ch.map(function(w){ return WHAT_ROW[w] + ', ' + n(b[w]) + ' → ' + n(a[w]); }).join('; ');
      return 'Who can see ' + (AREA_NAMES[q.area] || q.area) + ': ' + what;
    },
    body: function(body, area, lv){ return accessBody(body, area, lv); },
  };
  function proposeAccess(){
    var area = pageArea(), u = auth && auth.currentUser;
    if (!String(panel.note || '').trim()) { panel.error = 'Say why, for whoever reviews it.'; drawAccess(); return; }
    var lv = Object.assign({}, panel.lv);
    panel.busy = true; panel.error = ''; drawAccess();
    // Just this page's row: accepting it sets that row in the table as it is then
    // (functions/index.js appliedProposal), whatever else changes in the part meanwhile.
    var ref = firebase.firestore(BOLD.getApp()).collection('handbook').doc('boldiquette');
    BOLD.confirmProposal('propose').then(function(ok){
      if (!ok) throw { cancelled: true };
      return ref.collection('proposals').add({
        kind: 'access', partId: 'access', area: area, before: currentLevels(area), after: { view: lv.view, edit: lv.edit },
        note: String(panel.note).trim(), by: { email: u.email || '', name: u.displayName || '' }, at: Date.now(), status: 'open',
      });
    }).then(function(d){ panel.busy = false; panel.done = d.id; drawAccess(); }, function(err){
      if (err && err.cancelled) { panel.busy = false; drawAccess(); return; }
      console.error('[BOLD Lab] proposing who can see what failed', err);
      panel.busy = false; panel.error = 'Couldn’t propose it — try again.'; drawAccess();
    });
  }
  // Whoever can edit a page can view it: raising View raises Edit with it, and lowering
  // Edit lowers View with it. Nobody viewing it means nobody edits it.
  function setLevel(w, l){
    var lv = panel.lv, rank = function(x){ return LADDER.indexOf(x); };
    lv[w] = l;
    if (w === 'view' && lv.edit !== 'none' && (l === 'none' || rank(lv.edit) < rank(l))) lv.edit = l;
    if (w === 'edit' && l !== 'none' && rank(l) < rank(lv.view)) lv.view = l;
  }
  document.addEventListener('click', function(e){
    var box = document.getElementById('pageAccess');
    if (!box) return;
    if (!box.contains(e.target)) {
      if (panel && !panel.busy && !(panel.note && !panel.done)) { panel = null; drawAccess(); }
      if (brOpen) { brOpen = false; drawAccess(); }
      return;
    }
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.classList.contains('br-chip')) { brOpen = !brOpen; if (brOpen) { panel = null; loadBranches(); } drawAccess(); return; }
    if (t.classList.contains('br-close')) { brOpen = false; drawAccess(); return; }
    if (t.classList.contains('br-item')) {
      var r = t.getAttribute('data-ref');
      if (branch ? branch.ref === r : !r) { brOpen = false; drawAccess(); return; }
      BOLD.setBranch(r ? (branchList || []).filter(function(b){ return b.ref === r; })[0] : null, { go: !!r });
      return;
    }
    if (t.classList.contains('ac-chip')) brOpen = false;
    if (t.classList.contains('ac-chip')) panel = panel ? null : { lv: currentLevels(pageArea()), note: '' };
    else if (t.classList.contains('ac-close')) panel = null;
    else if (t.classList.contains('ac-cell')) setLevel(t.getAttribute('data-what'), t.getAttribute('data-level'));
    else if (t.classList.contains('ac-propose')) { proposeAccess(); return; }
    else if (t.classList.contains('ac-as')) { if (t.getAttribute('aria-checked') !== 'true') BOLD.setViewAs(t.getAttribute('data-view-as')); return; }
    drawAccess();
    var again = panel && box.querySelector('.ac-cell[data-what="' + t.getAttribute('data-what') + '"][data-level="' + t.getAttribute('data-level') + '"]');
    if (again) again.focus();
  });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && brOpen) { brOpen = false; drawAccess(); var bc = document.querySelector('#pageAccess .br-chip'); if (bc) bc.focus(); return; }
    if (e.key === 'Escape' && panel && !panel.busy) { panel = null; drawAccess(); var c = document.querySelector('#pageAccess .ac-chip'); if (c) c.focus(); }
  });
  document.addEventListener('input', function(e){
    if (e.target.classList && e.target.classList.contains('ac-note-input') && panel) panel.note = e.target.value;
  });
  // Watched again when the person, the table or the page changes. A remembered visit's
  // access comes before the page's body (and its area) is there: watched once it is.
  var watchedFor = null;
  function rewatch(a){
    var key = pageArea() + '|' + a.e + '|' + JSON.stringify(a.pages);
    if (watchedFor !== key) { watchedFor = key; watchWaiting(); }
  }
  BOLD.onAccess(function(a){
    rewatch(a);
    if (!panel || panel.done) drawAccess();
  });
  document.addEventListener('DOMContentLoaded', function(){ if (access) rewatch(access); drawAccess(); });

  /* ---------- shell: sidebar state + gating ---------- */

  // The gate when signed in but the page is for groups above theirs.
  function showLevelGate(gate, area, what){
    if (!gate) return;
    var level = levelFor(area, 'view');
    if (what === 'list' && rankOf(levelFor(area, 'edit')) < rankOf(level)) level = levelFor(area, 'edit');
    gate.innerHTML = '<div class="gate-box"><h1>Not open to your group</h1>' +
      '<p>This page is for ' + esc(LEVEL_NAMES[level]) + ' and above; you’re in ' + esc(LEVEL_NAMES[access.group] || 'PAN-BOLD') + '. ' +
      '<a href="boldiquette.html#access">Who can see what</a>.</p>' +
      '<a class="gate-signup-btn" href="profile.html">Ask for another group on your profile</a></div>';
    gate.setAttribute('data-level-gate', '');
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
    var area = shell.getAttribute('data-area') || 'internal', areaWhat = shell.getAttribute('data-area-what') || 'view';

    // Gated page: hidden until signed in and allowed. A cached sign-in shows it at once
    // instead of after Firebase Auth resolves; auth stays authoritative.
    shell.hidden = !hint || !BOLD.can(area, areaWhat);
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
      var ok = BOLD.can(area, areaWhat);
      shell.hidden = !ok;
      // Allowed after all (the server's answer, a PI's say): the gate shown on the first guess goes.
      var shown = document.getElementById('pageGate');
      if (ok && shown && shown.hasAttribute('data-level-gate')) shown.hidden = true;
      if (!ok) {
        // Checked again when it's drawn: the server may have said yes by then.
        var show = function(){ if (!BOLD.can(area, areaWhat)) showLevelGate(document.getElementById('pageGate'), area, areaWhat); };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
      }
    });
  };

  // The sidebar shows only the pages the viewer may view ([data-area] on its groups and links).
  function sidebarAccess(){
    BOLD.onAccess(function(){
      Array.prototype.forEach.call(document.querySelectorAll('#sidebar [data-area]'), function(el){
        el.hidden = !BOLD.can(el.getAttribute('data-area'), el.getAttribute('data-area-what') || 'view');
      });
      // A group the viewer can't open still shows for a link in it they can (Get started under the
      // Service desk, for PAN-BOLD): only those links, and its heading goes to the first of them.
      Array.prototype.forEach.call(document.querySelectorAll('#sidebar .nav-group[data-area]'), function(g){
        var label = g.querySelector('.nav-group-label');
        if (label && !label.hasAttribute('data-href')) label.setAttribute('data-href', label.getAttribute('href'));
        var open = BOLD.can(g.getAttribute('data-area'), g.getAttribute('data-area-what') || 'view'), own = [];
        Array.prototype.forEach.call(g.querySelectorAll('.nav-sub'), function(a){
          var area = a.getAttribute('data-area');
          if (!area) a.hidden = !open; else if (!a.hidden) own.push(a);
        });
        g.hidden = !open && !own.length;
        if (label) label.setAttribute('href', open || !own.length ? label.getAttribute('data-href') : own[0].getAttribute('href'));
      });
      // A divider shows only between groups the viewer sees: none first, last or twice in a row.
      var seen = false, pending = null;
      Array.prototype.forEach.call(document.querySelectorAll('#sidebar .nav-groups > *'), function(el){
        if (el.classList.contains('nav-sep')) { el.hidden = true; if (seen) pending = el; seen = false; return; }
        if (el.hidden) return;
        if (pending) { pending.hidden = false; pending = null; }
        seen = true;
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
        // Only its organisers, PIs and admins see it until it's released.
        if (e.hidden) { a.classList.add('nav-hidden'); a.title = e.title + ' (hidden: not released yet)'; }
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
        // What only this person may see isn't remembered for whoever signs in next.
        try { localStorage.setItem(cacheKey, JSON.stringify(list.filter(function(e){ return !e.hidden; }))); } catch (e){}
      }).catch(function(err){ console.error('[BOLD Lab] loading the ' + key + ' for the sidebar failed', err); });
    });
  }

  // The event series (eventSeries; series.html), by title, each to its own page; then the
  // one-off events (events/{slug} with no series), newest first: an event with its own page
  // links there, the rest to event.html?event=<slug>. The released ones for everyone; a new
  // one, until it's released, for whoever sees it on Events (PIs and admins, its organisers,
  // whoever added it), marked hidden. The same queries as pages/events.js.
  function eventsNav(){
    firestoreNav('events', 'boldNavEvents', 'events', function(db){
      var me = String((access && access.e) || '').toLowerCase(), all = BOLD.isFullWrite();
      var se = db.collection('eventSeries'), ev = db.collection('events');
      var get = function(qs){
        return Promise.all(qs.map(function(q){ return q.get().then(function(s){ return s.docs.map(function(d){ return d.data(); }); }, function(){ return []; }); }))
          .then(function(lists){ return [].concat.apply([], lists); });
      };
      return Promise.all([
        get(all ? [se] : [se.where('hidden', '==', false)].concat(me ? [se.where('organisers', 'array-contains', me)] : [])),
        get(all ? [ev] : [ev.where('hidden', '==', false)].concat(me ? [ev.where('createdBy', '==', me)] : [])),
      ]).then(function(r){
        var seen = {}, once = function(k){ if (seen[k]) return false; seen[k] = true; return true; };
        var series = r[0].filter(function(x){ return x.id && x.title && once('s:' + x.id); })
          .sort(function(a, b){ return a.title.localeCompare(b.title); })
          .map(function(x){ return { title: x.title, href: x.page || 'series.html?series=' + encodeURIComponent(x.id), hidden: !!x.hidden }; });
        var single = r[1].filter(function(e){ return e.slug && e.title && !e.series && once('e:' + e.slug); })
          .sort(function(a, b){ return a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : 0; })
          .map(function(e){ return { title: e.title, href: e.page || 'event.html?event=' + encodeURIComponent(e.slug), hidden: !!e.hidden }; });
        return series.concat(single);
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
