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

  // During the week, the schedule opens on today's day. Waits for sign-in,
  // since the page stays hidden until then, and leaves the page alone if
  // the visitor has already scrolled.
  var now = new Date();
  var pad = function(n){ return (n < 10 ? '0' : '') + n; };
  var today = document.querySelector('.day-card[data-date="' + now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + '"]');
  if (!today || panels.schedule.hidden || !BOLD.getAuth()) return;
  var done = false;
  BOLD.onUser(function(user){
    if (!user || done) return;
    done = true;
    requestAnimationFrame(function(){
      if (window.scrollY < 40 && !panels.schedule.hidden) today.scrollIntoView({ block: 'start' });
    });
  });
})();

// Schedule — the cards are built from the programme
// (src/_data/collabWeekSessions.js); a session's edits (title, leads, room)
// live in Firestore's collabWeekSessions and are laid over them here.
(function(){
  var esc = BOLD.escapeHtml;
  var cards = document.querySelectorAll('.session-card[data-session]');
  if (!cards.length || !BOLD.getAuth()) return;
  var db = null;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var unsubscribe = null;
  BOLD.onUser(function(user){
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (!user) return;
    unsubscribe = db.collection('collabWeekSessions').onSnapshot(function(snap){
      snap.forEach(function(doc){
        var s = doc.data();
        Array.prototype.forEach.call(document.querySelectorAll('.session-card[data-session="' + doc.id + '"]'), function(card){
          if (s.title) card.querySelector('.session-title').textContent = s.title;
          if (s.leads) card.querySelector('.session-who').textContent = s.leads.map(function(l){ return l.name; }).join(', ');
          if (s.room !== undefined) card.querySelector('.session-where').innerHTML =
            esc(card.getAttribute('data-venue')) + (s.room ? ' &middot; ' + esc(s.room) : '');
        });
      });
    }, function(err){ console.error('[BOLD Collaboration Week] loading session edits failed', err); });
  });
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
  var NOT_PROPOSER = 'Only whoever proposed it can edit or delete a proposal';
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
          (p.timeLocation ? ' &middot; ' + escapeHtml(p.timeLocation) : '') +
        '</div>' +
        (p.chair ? '<div class="proposal-meta">Chair: ' + escapeHtml(p.chair) + '</div>' : '') +
        (p.abstract ? '<div class="proposal-note">' + escapeHtml(p.abstract) + '</div>' : '') +
        (p.overallDescription ? '<div class="proposal-note">' + escapeHtml(p.overallDescription) + '</div>' : '') +
        // Always shown; greyed out, with the reason on hover, unless it's your own.
        (currentUser && p.email === currentUser.email
          ? '<div class="proposal-actions">' +
              '<a href="event-collaboration-week-propose.html?edit=' + encodeURIComponent(p.id) + '">Edit</a>' +
              '<button type="button" class="btn-text danger" data-delete-id="' + escapeHtml(p.id) + '">Delete</button>' +
            '</div>'
          : '<div class="proposal-actions">' +
              '<button type="button" class="btn-text" disabled title="' + NOT_PROPOSER + '">Edit</button>' +
              '<button type="button" class="btn-text danger" disabled title="' + NOT_PROPOSER + '">Delete</button>' +
            '</div>') +
      '</div>';
    }).join('');
  }

  function deleteProposal(id, btn){
    // Client-side gate is UX only — the Delete button is only enabled for
    // p.email === currentUser.email above, and firestore.rules enforces
    // the same (email() == resource.data.email || hasFullWrite()) as the
    // actual security boundary.
    if (!window.confirm('Delete this proposal? This can’t be undone.')) return;
    btn.disabled = true;
    db.collection('collabWeekProposals').doc(id).delete().catch(function(err){
      console.error('[BOLD Collaboration Week] delete proposal failed', err);
      window.alert('Could not delete the proposal — try again.');
      btn.disabled = false;
    });
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
  els.list.addEventListener('click', function(e){
    var btn = e.target.closest('[data-delete-id]');
    if (!btn) return;
    deleteProposal(btn.getAttribute('data-delete-id'), btn);
  });
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
