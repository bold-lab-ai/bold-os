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
  // the caller's own Slack custom profile fields (getMyProfile). Silent on
  // failure: the page is complete without them.
  function renderSlackFacts(data){
    var box = el('slackFacts');
    var fields = data.fields || [];
    box.innerHTML = '';
    fields.forEach(function(f){
      var row = document.createElement('div'); row.className = 'fact';
      var dt = document.createElement('dt'); dt.textContent = f.label;
      var dd = document.createElement('dd'); dd.textContent = f.value;
      row.appendChild(dt); row.appendChild(dd); box.appendChild(row);
    });
    box.hidden = !fields.length;
  }

  function renderIdentity(name, email){
    el('profileName').textContent = name || email || 'Profile';
    el('factName').textContent = name || '\u2014';
    el('factEmail').textContent = email || '\u2014';
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
  function hasGithub(user){
    return !!(user && (user.providerData || []).some(function(p){ return p && p.providerId === 'github.com'; }));
  }

  // The GitHub row of the linked accounts: the account and its bold-lab-ai
  // membership, with the button to link or unlink it.
  function renderGithub(link){
    var box = el('githubBody');
    var off = ghBusy ? ' disabled' : '';
    var err = ghError ? '<span class="gh-error">' + escapeHtml(ghError) + '</span>' : '';
    if (!link) {
      box.innerHTML = '<span class="gh-line">Not linked. Linking it invites you to the bold-lab-ai organisation.</span>' + err +
        '<span class="gh-actions"><button type="button" class="btn-box is-primary gh-link"' + off + '>Link GitHub</button></span>';
      return;
    }
    var status = link.status === 'active' ? 'member of bold-lab-ai' :
      link.status === 'pending' ? 'invited to bold-lab-ai: <a href="' + ORG + '/invitation" target="_blank" rel="noopener">accept the invitation</a>' :
      'not invited to bold-lab-ai: ' + escapeHtml(link.error || 'GitHub refused.');
    box.innerHTML = '<span class="gh-line"><a href="https://github.com/' + encodeURIComponent(link.github) + '" target="_blank" rel="noopener">@' + escapeHtml(link.github) + '</a>, ' + status + '</span>' + err +
      '<span class="gh-actions">' + (link.status === 'failed' ? '<button type="button" class="btn-box is-primary gh-retry"' + off + '>Try again</button>' : '') +
      '<button type="button" class="btn-box gh-unlink"' + off + '>Unlink GitHub</button></span>';
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
      ghError = err && err.code === 'functions/failed-precondition' && err.message ? err.message : 'Couldn’t reach GitHub — try again.';
      renderGithub(null);
    });
  }

  function showGithub(user){
    if (!user) { el('githubBody').innerHTML = ''; return; }
    if (hasGithub(user)) loadGithub(); else renderGithub(null);
  }

  el('githubBody').addEventListener('click', function(e){
    var t = e.target.closest('button');
    var user = BOLD.getAuth() && BOLD.getAuth().currentUser;
    if (!t || t.disabled || !user) return;
    ghError = '';
    if (t.classList.contains('gh-link')) {
      ghBusy = true; renderGithub(null);
      // After a popup (localhost) the account is linked here; live, the page goes to GitHub and back.
      BOLD.link(new firebase.auth.GithubAuthProvider()).then(function(){ loadGithub(); }).catch(function(err){
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
    if (!user) { cacheClear(); el('slackFacts').hidden = true; return; }
    renderIdentity(user.displayName || '', user.email);
    showPhoto(user.photoURL);
    if (user.photoURL) cachePut('photo', user.photoURL); else cacheClearKey('photo');

    if (!user.email) return;
    loadCached('getMyProfile', user.email, renderSlackFacts, function(){});
    loadCached('getMyProjects', user.email, renderProjects, function(){
      el('projMsg').textContent = 'Could not load projects.';
    });
  }

  function renderProject(p){
    var li = document.createElement('li');
    var a = document.createElement('a');
    a.className = 'proj-title';
    a.href = 'audit-board.html#board=' + encodeURIComponent(p.boardId) + '&card=' + encodeURIComponent(p.cardId);
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

  // The caller's papers on the Internal Review Board, by relationship
  // (getMyProjects).
  function renderProjects(data){
    [['projOwner', data.owner, 'cntOwner'], ['projAuthor', data.author, 'cntAuthor'], ['projReviewer', data.reviewer, 'cntReviewer']].forEach(function(g){
      var ul = el(g[0]); ul.innerHTML = '';
      var items = g[1] || [];
      el(g[2]).textContent = items.length || '';
      if (!items.length) {
        var li = document.createElement('li');
        li.innerHTML = '<p class="proj-empty">None</p>';
        ul.appendChild(li);
      }
      items.forEach(function(p){ ul.appendChild(renderProject(p)); });
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
  // Projects and Linked accounts, one shown at a time; the #hash names it.
  var TABS = ['projects', 'linked-accounts'];
  function showTab(){
    var want = String(location.hash || '').replace(/^#/, '');
    if (TABS.indexOf(want) === -1) want = TABS[0];
    TABS.forEach(function(id){ el(id).hidden = id !== want; });
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
})();
