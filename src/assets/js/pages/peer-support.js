(function(){
  var root = document.getElementById('peerSupport'), esc = BOLD.escapeHtml, state, user, busy = false;
  if (!root || !BOLD.getAuth()) return;
  function call(data){ return BOLD.getApp().functions('europe-west2').httpsCallable('peerSupport')(data).then(function(r){ return r.data; }); }
  function button(action, label, disabled){ return '<button type="button" class="btn-text" data-action="' + action + '"' + (disabled ? ' disabled title="' + esc(disabled) + '"' : '') + '>' + label + '</button>'; }
  function person(email){ var a = state.ambassadors.concat(state.members || []).filter(function(x){ return x.id === email || x.email === email; })[0]; return a ? a.name : email; }
  function profile(a){ return a.slackId ? '<a href="person.html?id=' + encodeURIComponent(a.slackId) + '">' + esc(a.name) + '</a>' : esc(a.name); }
  function render(){
    var mine = state.mine, can = BOLD.can('peer-support', 'edit'), reason = can ? '' : BOLD.cannotReason('peer-support', 'edit');
    root.innerHTML = '<p id="psError" class="ps-error" role="alert" hidden></p>' +
      (state.content.body ? '<section>' + BoldMarkdown.render(state.content.body) + '</section>' : '') +
      '<p><a href="boldiquette.html#wellbeing">Peer support in the BOLDiquette</a>' +
      (state.content.formUrl ? ' · <a href="' + esc(state.content.formUrl) + '" target="_blank" rel="noopener">Feedback questionnaire</a>' : '') + '</p>' +
      '<section><h2>Your buddy</h2><p>Your assignment is visible to you and the peer support ambassadors.</p>' +
      (mine && mine.status !== 'closed' ? '<p>' + (mine.status === 'pending' ? 'Waiting for an ambassador to offer a match.' :
        (mine.status === 'offered' ? 'Buddy offered: ' : 'Your buddy: ') + esc(person(mine.ambassadorEmail))) + '</p>' +
        (mine.status === 'offered' ? button('accept', 'Accept buddy', reason) : '') + (mine.status === 'pending' && mine.notificationPending ? button('notifyRequest', 'Notify ambassadors', reason) : '') + button('close', 'Close request / decline buddy', reason) : button('request', 'Request a buddy', reason)) + '</section>' +
      '<section><h2>Ambassadors</h2><div class="ps-directory">' + state.ambassadors.map(function(a){
        return '<article class="ps-person"><h3>' + profile(a) + '</h3><p>' + esc(a.bio || '') + '</p>' +
          (a.slackId ? '<a href="slack://user?team=' + encodeURIComponent(BOLD.SLACK_TEAM || '') + '&id=' + encodeURIComponent(a.slackId) + '">Message on Slack</a>' : '') + '</article>';
      }).join('') + '</div>' + (!state.ambassadors.length ? '<p>No ambassadors have been added yet.</p>' : '') +
      button('apply', state.application && state.application.status === 'pending' ? 'Application pending' : 'Apply to be an ambassador', reason || (state.isAmbassador ? 'You are already an ambassador' : state.application && state.application.status === 'pending' ? 'Your application is awaiting review' : '')) + '</section>' +
      (state.application && state.application.status === 'pending' && state.application.notificationPending ? button('notifyApplication', 'Notify ambassadors about application', reason) : '') +
      (state.canBootstrap ? '<section><h2>Initial setup</h2><label>First ambassador’s account email<input id="psFirst" type="email"></label>' + button('bootstrap', 'Appoint first ambassador') + '</section>' : '') +
      '<section><h2>Ambassador console</h2>' + (state.isAmbassador ? consoleHtml() : button('console', 'Open console', 'Only peer support ambassadors can open the console')) + '</section>';
  }
  function consoleHtml(){
    var current = state.ambassadors.filter(function(a){ return a.id === user.email.toLowerCase(); })[0] || {};
    var active = (state.requests || []).filter(function(q){ return ['offered', 'active'].indexOf(q.status) !== -1; });
    return '<h3>Workloads</h3><ul>' + state.ambassadors.map(function(a){ return '<li>' + esc(a.name) + ': ' + active.filter(function(q){ return q.ambassadorEmail === a.id; }).length + ' buddies / offers</li>'; }).join('') + '</ul>' +
      '<h3>Matching</h3>' + (state.requests || []).filter(function(q){ return q.status !== 'closed'; }).map(function(q){
        return '<article class="ps-request" data-email="' + esc(q.memberEmail) + '"><strong>#' + q.number + ' ' + esc(person(q.memberEmail)) + '</strong><p>' + esc(q.status) + (q.ambassadorEmail ? ' · ' + esc(person(q.ambassadorEmail)) : '') + '</p>' +
          (q.status === 'pending' ? '<label>Ambassador<select class="ps-match"><option value="">Choose…</option>' + state.ambassadors.map(function(a){ return '<option value="' + esc(a.id) + '">' + esc(a.name) + '</option>'; }).join('') + '</select></label>' +
          '<label><input type="checkbox" class="ps-conflicts"> I checked that they are not active supervisors or research collaborators.</label>' + button('offer', 'Offer buddy') : q.status === 'offered' && q.notificationPending ? button('notifyOffer', 'Notify member and buddy') : '') + '</article>';
      }).join('') + '<h3>Ambassador applications</h3>' + (state.applications || []).filter(function(a){ return a.status === 'pending'; }).map(function(a){
        return '<div class="ps-request" data-email="' + esc(a.email) + '">' + esc(a.name || a.email) + button('approveApplication', 'Approve application') + '</div>';
      }).join('') + '<h3>Your ambassador profile</h3><label>About you<textarea id="psBio" class="no-tags">' + esc(current.bio || '') + '</textarea></label>' +
      '<label><input id="psNewJoiners" type="checkbox"' + (current.notifyNewJoiners ? ' checked' : '') + '> Notify me in my BOLD.OS inbox when new members join and need a buddy offer.</label>' + button('profile', 'Save profile') +
      '<h3>Page content</h3><label>Description<textarea id="psBody" class="md-field no-tags">' + esc(state.content.body || '') + '</textarea></label>' +
      '<label>Questionnaire URL<input id="psFormUrl" type="url" value="' + esc(state.content.formUrl || '') + '"></label>' + BOLD.linkNote() + button('content', 'Save page content');
  }
  function load(){ return call({ action: 'load' }).then(function(s){ state = s; render(); }); }
  root.addEventListener('click', async function(event){
    var b = event.target.closest('[data-action]'); if (!b || b.disabled || busy) return;
    var action = b.dataset.action, d = { action: action }, row = b.closest('[data-email]');
    if (row) d.email = row.dataset.email;
    if (action === 'offer') { d.ambassadorEmail = row.querySelector('.ps-match').value; d.conflictsChecked = row.querySelector('.ps-conflicts').checked; }
    if (action === 'bootstrap') d.email = document.getElementById('psFirst').value;
    if (action === 'profile') { d.bio = document.getElementById('psBio').value; d.notifyNewJoiners = document.getElementById('psNewJoiners').checked; }
    if (action === 'content') { d.body = document.getElementById('psBody').value; d.formUrl = document.getElementById('psFormUrl').value; }
    busy = true; b.disabled = true;
    try {
      if (['request', 'apply', 'offer', 'notifyRequest', 'notifyApplication', 'notifyOffer'].indexOf(action) !== -1) {
        var ok = await BOLD.confirmAction({ title: b.textContent, always: true,
          effects: ['Save this peer support request or offer.', { key: 'notify', text: action === 'offer' || action === 'notifyOffer' ? 'Notify the member and their proposed buddy in BOLD.OS.' : 'Notify the peer support ambassadors in BOLD.OS.' }],
          go: 'Continue' });
        if (!ok) return;
        d.notify = !ok.skip.notify;
      }
      await call(d); await load();
    } catch (error){ var el = document.getElementById('psError'); el.hidden = false; el.textContent = error.message; }
    finally { busy = false; b.disabled = false; }
  });
  BOLD.onUser(function(u){ user = u; if (!u) { root.innerHTML = ''; return; } load().catch(function(e){ root.textContent = e.message; }); });
})();
