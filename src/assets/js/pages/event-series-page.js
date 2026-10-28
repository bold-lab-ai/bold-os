// A series' own page with tabs, Schedule (or Agenda), Projects and Proposals (the
// Festival's, Collaboration week's): the tabs, and the shown edition's proposals
// (event-proposals.js); pages/event.js fills Projects.
// Tabs — independent of Firebase, so switching between Schedule and
// Proposals works even if Firebase fails to load. Neither panel is
// hidden in the raw HTML (progressive enhancement: no-JS visitors see
// both, stacked, rather than losing whichever tab isn't picked), so this
// runs on load to pick a starting tab and hide the other.
(function(){
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var panels = { schedule: document.getElementById('panelSchedule'), proposals: document.getElementById('panelProposals'), projects: document.getElementById('panelProjects') };
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
    b.addEventListener('click', function(){
      BOLD.switchTab('.tabs', b.closest('main'), function(){ activate(b.getAttribute('data-tab')); });
    });
  });
  var initial = (location.hash || '').slice(1);
  activate(panels[initial] ? initial : 'schedule', false);
})();

// Proposals list — read-only here (event-proposals.js); submitting lives on its own page
// (event-collaboration-week-propose.html).
(function(){
  var els = {
    signedOut: document.getElementById('proposalsSignedOut'),
    signedIn: document.getElementById('proposalsSignedIn'),
    signInBtn: document.getElementById('signInBtn'),
    list: document.getElementById('proposalsList')
  };
  if (!BOLD.getAuth()){
    els.signedOut.innerHTML = '<p>Could not connect &mdash; reload, or check back shortly.</p>';
    return;
  }
  // The edition shown (series-editions.js may have chosen it from ?edition=).
  var slug = document.getElementById('eventBody').getAttribute('data-event');
  var proposals = EventProposals.mount(els.list, slug);

  // The call for proposals, the occurrence's own (`proposalsOpen` on events/{slug}; closed
  // unless opened): open, a Propose button; its organisers, PIs and admins open and close it.
  var callEl = document.getElementById('proposalsCall'), db = firebase.firestore(BOLD.getApp());
  var ev = null, series = null, me = null, busy = false;
  function canRun(){
    return !!(me && ev && (BOLD.isFullWrite() || (ev.createdBy && ev.createdBy === me.email) ||
      (series && (series.organisers || []).indexOf(String(me.email).toLowerCase()) >= 0)));
  }
  function drawCall(){
    if (!callEl || !ev) return;
    var open = ev.proposalsOpen === true;
    callEl.innerHTML = '<p class="cfp-state">' + (open ? 'The call for proposals is open.' : 'The call for proposals is closed.') + '</p>' +
      (open ? '<a class="btn-box is-primary cfp-propose" href="event-collaboration-week-propose.html?event=' + encodeURIComponent(slug) + '">Propose a workshop, pitch or talk</a>' : '') +
      (canRun() ? '<button type="button" class="btn-text cfp-toggle"' + (busy ? ' disabled' : '') + '>' + (open ? 'Close the call' : 'Open the call') + '</button>' : '');
  }
  if (callEl) callEl.addEventListener('click', function(e){
    var b = e.target.closest('.cfp-toggle');
    if (!b || b.disabled) return;
    busy = true; drawCall();
    db.collection('events').doc(slug).update({ proposalsOpen: ev.proposalsOpen !== true, updatedAt: Date.now(), updatedBy: me.email }).then(function(){
      busy = false;
    }).catch(function(err){ console.error('[BOLD Events] opening or closing the call failed', err); busy = false; drawCall(); window.alert('Couldn’t change that — try again.'); });
  });
  BOLD.onAccess(drawCall);

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
    els.signedOut.hidden = !!user;
    els.signedIn.hidden = !user;
    if (!user) document.documentElement.classList.remove('auth-hint');
    proposals.update(user);
    me = user;
    if (!user) return;
    db.collection('events').doc(slug).onSnapshot(function(d){
      ev = d.exists ? d.data() : null; drawCall();
      if (ev && ev.series && !series) db.collection('eventSeries').doc(ev.series).get().then(function(x){ series = x.exists ? x.data() : null; drawCall(); }).catch(function(){});
    }, function(){});
  });
})();
