(function(){
  var escapeHtml = BOLD.escapeHtml;

  // The masthead, gate and sidebar are bold.js's; this page only fills in the profile.
  if (!BOLD.getAuth()) return;

  /* ---------- profile ---------- */
  var el = function(id){ return document.getElementById(id); };

  // Cloud Function results are cached per person in localStorage: shown at
  // once on open, refetched only once older than CACHE_TTL_MS (and cleared
  // on sign-out). If a refetch fails, the cached copy stays on screen.
  var CACHE_TTL_MS = 15 * 60 * 1000;
  var CACHE_PREFIX = 'boldProfile:';

  function cacheGet(key){
    try { return JSON.parse(localStorage.getItem(CACHE_PREFIX + key) || 'null'); } catch (e) { return null; }
  }
  function cachePut(key, data){
    try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), d: data })); } catch (e){}
  }
  function cacheClearKey(key){
    try { localStorage.removeItem(CACHE_PREFIX + key); } catch (e){}
  }
  function showPhoto(url){
    var photo = el('profilePhoto');
    if (url) { if (photo.getAttribute('src') !== url) photo.src = url; photo.hidden = false; } else { photo.hidden = true; }
  }
  function cacheClear(){
    try {
      Object.keys(localStorage).forEach(function(k){ if (k.indexOf(CACHE_PREFIX) === 0) localStorage.removeItem(k); });
    } catch (e){}
  }

  // Renders from cache if any, then calls the function only if there's no
  // fresh cache. onError only fires when there was nothing cached to show.
  function loadCached(fn, email, render, onError){
    var key = fn + ':' + email.toLowerCase();
    var hit = cacheGet(key);
    if (hit) render(hit.d);
    var age = hit ? Math.round((Date.now() - hit.t) / 1000) : null;
    if (hit && Date.now() - hit.t < CACHE_TTL_MS) { console.info('[BOLD Lab] ' + fn + ': cache hit (' + age + 's old), no call'); return; }
    var call;
    try { call = firebase.app().functions('europe-west2').httpsCallable(fn); }
    catch (e) { if (!hit) onError(e); return; }
    var t0 = performance.now();
    call().then(function(res){
      var data = res.data || {};
      console.info('[BOLD Lab] ' + fn + ': fetched in ' + Math.round(performance.now() - t0) + 'ms (' + (hit ? 'stale cache shown ' + age + 's old' : 'no cache') + ')');
      cachePut(key, data);
      render(data);
    }).catch(function(err){
      console.error('[BOLD Lab] ' + fn + ' failed', err);
      if (!hit) onError(err);
    });
  }

  // Institution, role, supervisor, research interests, start date, ... —
  // the caller's own Slack custom profile fields (getMyProfile), handed to
  // member-details.js, which shows them with "Your details" (BOLD.slackFields,
  // event bold:slackfields). Silent on failure: the page is complete without them.
  function renderSlackFacts(data){
    renderSlackAccount(data.slack);
    BOLD.slackFields = data.fields || [];
    document.dispatchEvent(new Event('bold:slackfields'));
  }

  function renderIdentity(name, email){
    el('profileName').textContent = name || email || 'Profile';
  }

  /* ---------- GitHub ---------- */
  // Linking GitHub to this sign-in (BOLD.link) proves the account is theirs;
  // linkGithub (functions/index.js) then invites it to bold-lab-ai and reports
  // the membership: active, pending (invited, not yet accepted) or failed.
  var ORG = 'https://github.com/orgs/bold-lab-ai';
  var ghError = '', ghBusy = false;
  var GH_ERRORS = {
    'auth/credential-already-in-use': 'That GitHub account is already linked to another BOLD.OS account.',
    'auth/provider-already-linked': 'A GitHub account is already linked.',
    'auth/popup-closed-by-user': '',
    'auth/cancelled-popup-request': '',
  };
  function ghMessage(err){
    var code = err && err.code;
    return code in GH_ERRORS ? GH_ERRORS[code] : 'Couldn’t link GitHub — try again.';
  }
  function providerOf(user, id){
    return ((user && user.providerData) || []).filter(function(p){ return p && p.providerId === id; })[0] || null;
  }
  function hasGithub(user){ return !!providerOf(user, 'github.com'); }
  function me(){ return BOLD.getAuth() && BOLD.getAuth().currentUser; }

  // An account on another platform: its name (linking to the profile there),
  // handle and a note. a: { name, url, handle, note }.
  function accountHtml(a){
    var name = escapeHtml(a.name || a.handle || '');
    return '<span class="acct">' +
      '<span class="acct-text"><span class="acct-name">' + (a.url ? '<a href="' + escapeHtml(a.url) + '" target="_blank" rel="noopener">' + name + '</a>' : name) +
      (a.handle && a.handle !== a.name ? ' <span class="acct-handle">@' + escapeHtml(a.handle) + '</span>' : '') + '</span>' +
      (a.note ? '<span class="acct-note">' + a.note + '</span>' : '') + '</span></span>';
  }

  // Slack, the account they sign in with; its handle and profile come from getMyProfile.
  function renderSlackAccount(slack){
    var user = me(), p = providerOf(user, 'oidc.slack');
    el('slackAccount').innerHTML = accountHtml({
      name: (user && user.displayName) || (p && p.displayName) || '',
      handle: slack && slack.handle, url: slack && slack.url, note: 'Signed in with Slack',
    });
  }

  // The GitHub login of a linked account, from GitHub's public API (no token),
  // so the account shows even if the org check fails.
  var ghLogin = {};
  function githubLogin(id){
    if (ghLogin[id] !== undefined) return Promise.resolve(ghLogin[id]);
    return fetch('https://api.github.com/user/' + encodeURIComponent(id)).then(function(r){ return r.ok ? r.json() : {}; })
      .then(function(j){ ghLogin[id] = j.login || ''; return ghLogin[id]; }).catch(function(){ return ''; });
  }

  // The GitHub row of the linked accounts: the account and its bold-lab-ai
  // membership, with the button to link or unlink it.
  // The completeness bar (profile-progress.js) counts linked accounts: tell it when they change.
  function accountsChanged(){ document.dispatchEvent(new Event('bold:accounts')); }

  function renderGithub(link){
    accountsChanged();
    var box = el('githubBody');
    var off = ghBusy ? ' disabled' : '';
    var err = ghError ? '<span class="gh-error">' + escapeHtml(ghError) + '</span>' : '';
    if (!link) {
      box.innerHTML = '<span class="gh-line">Not linked. Linking it invites you to the bold-lab-ai organisation.</span>' + err +
        '<span class="gh-actions"><button type="button" class="btn-box is-primary gh-link"' + off + '>Link GitHub</button></span>';
      return;
    }
    var p = providerOf(me(), 'github.com');
    var login = link.github || (p && ghLogin[p.uid]) || '';
    var status = link.status === 'active' ? 'Member of bold-lab-ai' :
      link.status === 'pending' ? 'Invited to bold-lab-ai: <a href="' + ORG + '/invitation" target="_blank" rel="noopener">accept the invitation</a>' :
      link.status === 'unchecked' ? 'Linked, but couldn’t check bold-lab-ai' :
      'Not invited to bold-lab-ai: ' + escapeHtml(link.error || 'GitHub refused.');
    box.innerHTML = accountHtml({
      name: (p && p.displayName) || login, handle: login,
      url: login ? 'https://github.com/' + encodeURIComponent(login) : '', note: status,
    }) + err +
      '<span class="gh-actions">' + (link.status === 'failed' || link.status === 'unchecked' ? '<button type="button" class="btn-box is-primary gh-retry"' + off + '>Try again</button>' : '') +
      '<button type="button" class="btn-box gh-unlink"' + off + '>Unlink GitHub</button></span>';
    // The login isn't known until GitHub says (only the numeric id is): ask, then redraw.
    if (!login && p && ghLogin[p.uid] === undefined) githubLogin(p.uid).then(function(l){ if (l) renderGithub(link); });
  }

  // Asks linkGithub for the link's state (inviting the account if need be).
  function loadGithub(){
    ghBusy = true;
    el('githubBody').innerHTML = '<span class="proj-msg">Checking GitHub&hellip;</span>';
    firebase.app().functions('europe-west2').httpsCallable('linkGithub')().then(function(res){
      ghBusy = false; renderGithub((res.data || {}).link || null);
    }).catch(function(err){
      console.error('[BOLD Lab] linkGithub failed', err);
      ghBusy = false;
      // The SDK may or may not prefix the code with "functions/".
      ghError = err && /failed-precondition$/.test(err.code || '') && err.message ? err.message : 'Couldn’t reach GitHub — try again.';
      // Still linked, if it is: only the check failed.
      var user = BOLD.getAuth() && BOLD.getAuth().currentUser;
      renderGithub(hasGithub(user) ? { status: 'unchecked' } : null);
    });
  }

  function showGithub(user){
    if (!user) { el('githubBody').innerHTML = ''; return; }
    if (hasGithub(user)) loadGithub(); else renderGithub(null);
  }

  /* ---------- Google ---------- */
  // Linking the Google account they use (BOLD.link) proves it's theirs; linkGoogle
  // (functions/index.js) then sends their projects' meeting invitations, slides and
  // notes to it instead of their Slack email.
  var gError = '', gBusy = false;
  var G_ERRORS = {
    'auth/credential-already-in-use': 'That Google account is already linked to another BOLD.OS account.',
    'auth/provider-already-linked': 'A Google account is already linked.',
    'auth/popup-closed-by-user': '',
    'auth/cancelled-popup-request': '',
  };
  function renderGoogle(link){
    accountsChanged();
    var box = el('googleBody');
    var off = gBusy ? ' disabled' : '';
    var err = gError ? '<span class="gh-error">' + escapeHtml(gError) + '</span>' : '';
    if (!link) {
      box.innerHTML = '<span class="gh-line">Not linked. Your projects\u2019 meeting invitations, slides and notes go to your Slack email.</span>' + err +
        '<span class="gh-actions"><button type="button" class="btn-box is-primary g-link"' + off + '>Link Google</button></span>';
      return;
    }
    var p = providerOf(me(), 'google.com');
    box.innerHTML = accountHtml({ name: (p && p.displayName) || link.google, handle: '', note: escapeHtml(link.google) + ' \u00b7 your projects\u2019 meeting invitations, slides and notes go here' }) + err +
      '<span class="gh-actions"><button type="button" class="btn-box g-unlink"' + off + '>Unlink Google</button></span>';
  }
  // Tells linkGoogle what's linked now (it moves their projects over if that changed).
  function loadGoogle(){
    gBusy = true;
    el('googleBody').innerHTML = '<span class="proj-msg">Checking Google&hellip;</span>';
    firebase.app().functions('europe-west2').httpsCallable('linkGoogle')().then(function(res){
      gBusy = false; renderGoogle((res.data || {}).link || null);
    }).catch(function(err){
      console.error('[BOLD Lab] linkGoogle failed', err);
      gBusy = false;
      gError = 'Couldn\u2019t check your Google account \u2014 reload to try again.';
      var p = providerOf(me(), 'google.com');
      renderGoogle(p ? { google: p.email || '' } : null);
    });
  }
  function showGoogle(user){
    if (!user) { el('googleBody').innerHTML = ''; return; }
    loadGoogle();
  }
  el('googleBody').addEventListener('click', function(e){
    var t = e.target.closest('button');
    var user = me();
    if (!t || t.disabled || !user) return;
    gError = '';
    if (t.classList.contains('g-link')) {
      gBusy = true; renderGoogle(null);
      // After a popup (localhost) the account is linked here; live, the page goes to Google and back.
      BOLD.link(new firebase.auth.GoogleAuthProvider()).then(loadGoogle).catch(function(err){
        if (err && err.code === 'auth/provider-already-linked') { loadGoogle(); return; }
        console.error('[BOLD Lab] linking Google failed', err);
        gBusy = false; gError = err && err.code in G_ERRORS ? G_ERRORS[err.code] : 'Couldn\u2019t link Google \u2014 try again.'; renderGoogle(null);
      });
    } else if (t.classList.contains('g-unlink')) {
      if (!window.confirm('Unlink your Google account? Your projects\u2019 invitations and files go back to your Slack email.')) return;
      t.disabled = true;
      user.unlink('google.com').then(loadGoogle).catch(function(err){
        console.error('[BOLD Lab] unlinking Google failed', err);
        gError = 'Couldn\u2019t unlink Google \u2014 try again.'; loadGoogle();
      });
    }
  });

  el('githubBody').addEventListener('click', function(e){
    var t = e.target.closest('button');
    var user = BOLD.getAuth() && BOLD.getAuth().currentUser;
    if (!t || t.disabled || !user) return;
    ghError = '';
    if (t.classList.contains('gh-link')) {
      ghBusy = true; renderGithub(null);
      // After a popup (localhost) the account is linked here; live, the page goes to GitHub and back.
      BOLD.link(new firebase.auth.GithubAuthProvider()).then(function(){ loadGithub(); }).catch(function(err){
        // Linked already (the page didn't know): just check it.
        if (err && err.code === 'auth/provider-already-linked') { loadGithub(); return; }
        console.error('[BOLD Lab] linking GitHub failed', err);
        ghBusy = false; ghError = ghMessage(err); renderGithub(null);
      });
    } else if (t.classList.contains('gh-retry')) {
      loadGithub();
    } else if (t.classList.contains('gh-unlink')) {
      if (!window.confirm('Unlink your GitHub account? You stay in bold-lab-ai on GitHub.')) return;
      t.disabled = true;
      user.unlink('github.com').then(loadGithub).catch(function(err){
        console.error('[BOLD Lab] unlinking GitHub failed', err);
        ghError = 'Couldn’t unlink GitHub — try again.'; loadGithub();
      });
    }
  });

  // Back from linking GitHub by redirect: say why it failed, if it did (other
  // round-trip errors are sign-in's, which bold.js reports).
  if (BOLD.redirectResult) BOLD.redirectResult.catch(function(err){
    var code = err && err.code;
    if (code !== 'auth/credential-already-in-use' && code !== 'auth/provider-already-linked') return;
    ghError = ghMessage(err);
    var user = BOLD.getAuth() && BOLD.getAuth().currentUser;
    if (user && !hasGithub(user)) renderGithub(null);
  });

  function renderProfile(user){
    showGithub(user);
    showGoogle(user);
    if (user) renderSlackAccount(null);
    if (!user) { cacheClear(); BOLD.slackFields = []; return; }
    renderIdentity(user.displayName || '', user.email);
    showPhoto(user.photoURL);
    if (user.photoURL) cachePut('photo', user.photoURL); else cacheClearKey('photo');

    if (!user.email) return;
    loadCached('getMyProfile', user.email, renderSlackFacts, function(){});
    loadCached('getMyProjects', user.email, renderProjects, function(){
      el('projMsg').textContent = 'Could not load projects.';
    });
  }

  function renderProject(p, member){
    var li = document.createElement('li');
    var a = document.createElement('a');
    a.className = 'proj-title';
    // A paper on a venue opens on the board; a project with no venue (or one you're only a member of), its project page.
    a.href = p.boardId && !member ? 'audit-board.html#board=' + encodeURIComponent(p.boardId) + '&card=' + encodeURIComponent(p.cardId)
      : 'project.html#id=' + encodeURIComponent(p.cardId) + (p.boardId ? '&board=' + encodeURIComponent(p.boardId) : '');
    a.textContent = p.title;
    var meta = document.createElement('span');
    meta.className = 'proj-meta';
    meta.textContent = [p.boardLabel, p.role && p.role + ' reviewer'].filter(Boolean).join(' · ');
    li.appendChild(a); li.appendChild(meta);
    if (p.badges && p.badges.length) {
      var row = document.createElement('div');
      row.className = 'proj-badges';
      p.badges.forEach(function(b){
        var span = document.createElement('span');
        span.className = 'badge badge-' + String(b.kind).replace(/[^a-z_-]/g, '');
        span.textContent = b.label;
        row.appendChild(span);
      });
      li.appendChild(row);
    }
    return li;
  }

  // The caller's projects, by relationship (getMyProjects): papers on the Internal
  // Review Board and projects with no venue yet; Member, the others they're in.
  function renderProjects(data){
    [['projOwner', data.owner, 'cntOwner'], ['projAuthor', data.author, 'cntAuthor'], ['projMember', data.member, 'cntMember'], ['projReviewer', data.reviewer, 'cntReviewer']].forEach(function(g){
      var ul = el(g[0]); ul.innerHTML = '';
      var items = g[1] || [];
      el(g[2]).textContent = items.length || '';
      if (!items.length) {
        var li = document.createElement('li');
        li.innerHTML = '<p class="proj-empty">None</p>';
        ul.appendChild(li);
      }
      items.forEach(function(p){ ul.appendChild(renderProject(p, g[0] === 'projMember')); });
    });
    el('projMsg').hidden = true;
    el('projGroups').hidden = false;
  }
  // First paint from the last visit's sign-in hint (same one the masthead
  // uses) plus any cached sections — before Firebase has loaded or signed
  // in. Cache only, no network; renderProfile() above takes over once auth
  // resolves.
  try {
    var hint = BOLD.authHint();
    if (hint && hint.e) {
      renderIdentity(hint.n || '', hint.e);
      var ph = cacheGet('photo');
      if (ph && ph.d) showPhoto(ph.d);
      [['getMyProfile', renderSlackFacts], ['getMyProjects', renderProjects]].forEach(function(p){
        var hit = cacheGet(p[0] + ':' + hint.e.toLowerCase());
        if (hit) p[1](hit.d);
      });
    }
  } catch (e){}

  /* ---------- tabs ---------- */
  // Your details, Studies (PhD and Master students; pages/studies.js shows its tab),
  // Projects, Connections (connections.js, drawn the first time it's shown), Linked
  // accounts and Agents (pages/profile-api.js), one shown at a time; the #hash names it.
  var TABS = ['details', 'studies', 'projects', 'connections', 'linked-accounts', 'agents'];
  var connectionsFor = '', connectionsUser = null;
  function drawConnections(){
    // connections.js loads after this script.
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', drawConnections); return; }
    var u = connectionsUser;
    if (!u || !u.email || !window.BoldConnections || connectionsFor === u.email) return;
    connectionsFor = u.email;
    BoldConnections.mountPerson(el('connectionsBody'), u.email, u.email);
  }
  function showTab(){
    var want = String(location.hash || '').replace(/^#/, '');
    if (TABS.indexOf(want) === -1) want = TABS[0];
    TABS.forEach(function(id){ el(id).hidden = id !== want; });
    if (want === 'connections') drawConnections();
    Array.prototype.forEach.call(document.querySelectorAll('#profileTabs .guide-tab'), function(a){
      var on = a.getAttribute('href') === '#' + want;
      a.classList.toggle('is-current', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  window.addEventListener('hashchange', showTab);
  showTab();

  // Last, so everything above is defined if the user is already known.
  BOLD.onUser(renderProfile);
  BOLD.onUser(function(u){ connectionsUser = u; if (!el('connections').hidden) drawConnections(); });
})();
