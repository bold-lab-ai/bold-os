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
  var proposals = EventProposals.mount(els.list, 'collaboration-week');

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
  });
})();
