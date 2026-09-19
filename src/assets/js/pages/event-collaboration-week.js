// Tabs — independent of Firebase, so switching between Schedule and
// Proposals works even if Firebase fails to load. Neither panel is
// hidden in the raw HTML (progressive enhancement: no-JS visitors see
// both, stacked, rather than losing whichever tab isn't picked), so this
// runs on load to pick a starting tab and hide the other.
(function(){
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var panels = { schedule: document.getElementById('panelSchedule'), proposals: document.getElementById('panelProposals') };
  function activate(name, pushHash){
    buttons.forEach(function(b){
      var on = b.getAttribute('data-tab') === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Object.keys(panels).forEach(function(k){ panels[k].hidden = k !== name; });
    if (pushHash !== false) history.replaceState(null, '', '#' + name);
  }
  buttons.forEach(function(b){
    b.addEventListener('click', function(){ activate(b.getAttribute('data-tab')); });
  });
  var initial = (location.hash || '').slice(1);
  activate(panels[initial] ? initial : 'schedule', false);
})();

// Proposals list — read-only here; submitting lives on its own page
// (event-collaboration-week-propose.html) now.
(function(){
  var escapeHtml = BOLD.escapeHtml;

  var els = {
    signedOut: document.getElementById('proposalsSignedOut'),
    signedIn: document.getElementById('proposalsSignedIn'),
    signInBtn: document.getElementById('signInBtn'),
    list: document.getElementById('proposalsList')
  };

  // FIRESTORE_USE_EMULATOR must be false in anything committed — see
  // audit-board.html's own comment on this flag for why (a real production
  // incident the first time it shipped true). Project/config/auth: bold.js.
  var FIRESTORE_USE_EMULATOR = false;

  var db = null, auth = BOLD.getAuth();
  try {
    db = firebase.firestore(BOLD.getApp());
    if (FIRESTORE_USE_EMULATOR) db.useEmulator('localhost', 8080);
  } catch (e){ db = null; }

  if (!db || !auth){
    els.signedOut.innerHTML = '<p>Could not connect &mdash; reload, or check back shortly.</p>';
    return;
  }

  var currentUser = null;
  var unsubscribeProposals = null;

  function renderProposals(docs){
    if (!docs.length){
      els.list.innerHTML = '<p class="proposal-empty">Nothing proposed yet &mdash; be the first.</p>';
      return;
    }
    els.list.innerHTML = docs.map(function(p){
      return '<div class="proposal-card">' +
        '<div class="proposal-top">' +
          '<span class="proposal-title">' + escapeHtml(p.title || '(untitled)') + '</span>' +
          '<span class="proposal-type">' + escapeHtml(p.contributionType || '') + '</span>' +
        '</div>' +
        '<div class="proposal-meta">' +
          '<strong>' + escapeHtml(p.name || 'Someone') + '</strong>' +
          (p.duration ? ' &middot; ' + escapeHtml(p.duration) : '') +
          (p.pillar ? ' &middot; ' + escapeHtml(p.pillar) : '') +
          (p.coOrganisers === 'yes' ? ' &middot; looking for co-organisers' : '') +
        '</div>' +
        (p.timingConstraints ? '<div class="proposal-meta">Timing: ' + escapeHtml(p.timingConstraints) + '</div>' : '') +
        (p.joiningForces ? '<div class="proposal-meta">Joining forces with: ' + escapeHtml(p.joiningForces) + '</div>' : '') +
        (p.note ? '<div class="proposal-note">' + escapeHtml(p.note) + '</div>' : '') +
        (currentUser && p.email === currentUser.email
          ? '<div class="proposal-actions"><a href="event-collaboration-week-propose.html?edit=' + encodeURIComponent(p.id) + '">Edit</a></div>'
          : '') +
      '</div>';
    }).join('');
  }

  function watchProposals(){
    if (unsubscribeProposals) return;
    unsubscribeProposals = db.collection('collabWeekProposals').orderBy('createdAt', 'desc').onSnapshot(function(snap){
      var docs = [];
      snap.forEach(function(doc){ var d = doc.data(); d.id = doc.id; docs.push(d); });
      renderProposals(docs);
    }, function(err){
      console.error('[BOLD Collaboration Week] proposals listener failed', err);
      els.list.innerHTML = '<p class="proposal-empty">Could not load proposals &mdash; reload, or check back shortly.</p>';
    });
  }

  function stopWatchingProposals(){
    if (unsubscribeProposals){ unsubscribeProposals(); unsubscribeProposals = null; }
  }

  function renderAuth(){
    if (currentUser){
      els.signedOut.hidden = true;
      els.signedIn.hidden = false;
      watchProposals();
    } else {
      els.signedOut.hidden = false;
      document.documentElement.classList.remove('auth-hint');
      els.signedIn.hidden = true;
      stopWatchingProposals();
    }
  }

  els.signInBtn.addEventListener('click', BOLD.signIn);
  // Signed in last visit: skip the "sign in" panel while Firebase Auth
  // resolves. BOLD.onUser below stays authoritative and swaps it
  // back if the session has expired.
  try {
    if (localStorage.getItem('boldAuthHint')){
      els.signedOut.hidden = true;
      els.signedIn.hidden = false;
      els.list.innerHTML = '<p class="proposal-empty">Loading&hellip;</p>';
    }
  } catch (e){}
  BOLD.onUser(function(user){
    currentUser = user ? { email: user.email, name: user.displayName } : null;
    renderAuth();
  });
})();
