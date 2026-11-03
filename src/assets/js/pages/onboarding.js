// Onboarding (onboarding.html; on Get started until 2026-11-03): the viewer's steps for their group, each ticked when BOLD.OS sees it done
// (onboarding-common.js), and the tour of BOLD.OS (tour.js; its steps are the guide's part
// `tour`, else the tour's own).
// #tour starts the tour (the home page's and the steps' link); finishing it marks it done.
(function(){
  var esc = BOLD.escapeHtml;
  var box = document.getElementById('onboarding');
  if (!box || !BOLD.getAuth() || !window.BoldOnboarding || !window.BoldTour) return;
  var status = null, tourMd = null, started = false;

  function render(){
    if (!status) return;
    var done = status.done;
    box.innerHTML = '<div class="ob-head"><h2 id="obHead">' + (done ? 'You’re set up' : 'Your first steps') + '</h2>' +
        '<span class="ob-count">' + esc(BoldOnboarding.count(status)) + ' done</span></div>' +
      '<p class="ob-note">' + (done ? 'Everything ' + esc(BoldJoinLabel(status.group)) + ' asks of a newcomer is done.' +
          (status.group !== 'exec' ? ' To do more in BOLD, <a href="group-request.html">ask for another group</a>.' : '')
        : 'What everyone in ' + esc(BoldJoinLabel(status.group)) + ' does first. Each is ticked when BOLD.OS sees it done.') + '</p>' +
      BoldOnboarding.listHtml(status, 'your first steps') +
      '<div class="event-form-actions"><button type="button" class="btn-box' + (!status.tour ? ' is-primary' : '') + ' ob-tour">Take the tour</button></div>';
    box.hidden = false;
  }
  function BoldJoinLabel(g){ return { exec: 'BOLD-exec', staff: 'BOLD-staff', internal: 'BOLD-internal', associate: 'BOLD-associate' }[g] || 'PAN-BOLD'; }

  function loadTour(cb){
    if (tourMd !== null) return cb(tourMd);
    firebase.firestore(BOLD.getApp()).collection('guides').doc('get-started-at-bold').get().then(function(s){
      var p = ((s.exists && s.data().parts) || []).filter(function(x){ return x.id === 'tour'; })[0];
      tourMd = (p && p.body) || '';
    }).catch(function(){ tourMd = ''; }).then(function(){ cb(tourMd); });
  }
  function tour(){
    loadTour(function(md){
      BoldTour.start({ markdown: md, onDone: function(finished){
        if (location.hash === '#tour') history.replaceState(null, '', location.pathname + location.search);
        if (!finished) return;
        BoldOnboarding.mark('tour').then(function(s){ status = s; render(); }).catch(function(err){ console.error('[BOLD Onboarding] marking the tour failed', err); });
      } });
    });
  }
  box.addEventListener('click', function(e){ if (e.target.closest('.ob-tour')) tour(); });
  window.addEventListener('hashchange', function(){ if (location.hash === '#tour') tour(); });

  BOLD.onUser(function(user){
    if (!user) return;
    BoldOnboarding.load(function(s){
      status = s; render();
      // From the home page or a step's link: start it once the menu is there.
      if (location.hash === '#tour' && !started) { started = true; setTimeout(tour, 400); }
    });
  });
})();
