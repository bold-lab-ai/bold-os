// The profile's Linked accounts › Test account (PIs and admins, 2026-11-02): a second account of
// theirs in the BOLD Slack, to try BOLD.OS as someone else (testAccount in functions/index.js).
// Link it by its email; then set its group directly, reset it to a newcomer, or unlink it. They
// sign in as it in a private window, with Slack, like anyone. Everyone else sees it greyed out.
(function(){
  var esc = BOLD.escapeHtml;
  var box = document.getElementById('testAccountBody');
  if (!box || !BOLD.getAuth()) return;
  var acct = undefined, busy = false, msg = '', linking = false;
  var GROUPS = [['pan', 'PAN-BOLD'], ['associate', 'BOLD-associate'], ['internal', 'BOLD-internal'], ['staff', 'BOLD-staff']];
  function call(d){ return firebase.app().functions('europe-west2').httpsCallable('testAccount')(d); }
  function render(){
    if (!BOLD.isFullWrite()) {
      box.innerHTML = '<span class="proj-msg">A second Slack account to try BOLD.OS as someone else.</span> <button type="button" class="btn-text" disabled title="Test accounts are for PIs and admins">Link one</button>';
      return;
    }
    if (acct === undefined) { box.innerHTML = '<span class="proj-msg">Loading&hellip;</span>'; return; }
    var off = busy ? ' disabled' : '';
    var note = msg ? '<p class="proj-meta">' + esc(msg) + '</p>' : '';
    if (!acct) {
      box.innerHTML = linking
        ? '<div class="ta-form"><label>Its email (a second account of yours in the BOLD Slack)<input type="email" class="ta-email" autocomplete="off"></label>' +
          '<div class="event-form-actions"><button type="button" class="btn-box is-primary ta-link"' + off + '>Link it</button><button type="button" class="btn-box ta-cancel">Cancel</button></div>' + note + '</div>'
        : '<span class="proj-msg">None. A second account of yours in the BOLD Slack, to try BOLD.OS as someone else.</span> <button type="button" class="btn-text ta-open">Link one</button>' + note;
      return;
    }
    box.innerHTML = '<div><strong>' + esc(acct.name) + '</strong> <span class="acct-handle">' + esc(acct.email) + '</span></div>' +
      '<label class="ta-group">Its group <select class="ta-g"' + off + '>' + GROUPS.map(function(g){ return '<option value="' + g[0] + '"' + (g[0] === acct.group ? ' selected' : '') + '>' + g[1] + '</option>'; }).join('') + '</select></label>' +
      '<p class="proj-meta">Sign in as it in a private window, with Slack. Only you see it on People.</p>' +
      '<div class="event-controls"><button type="button" class="btn-text ta-reset"' + off + '>Reset it to a newcomer</button><button type="button" class="btn-text danger ta-unlink"' + off + '>Unlink</button></div>' + note;
  }
  function run(d, done){
    busy = true; msg = ''; render();
    call(d).then(function(r){ acct = r.data.account; msg = done || ''; linking = false; })
      .catch(function(err){ msg = (err && err.message) || 'That didn’t work — try again.'; })
      .then(function(){ busy = false; render(); });
  }
  box.addEventListener('click', function(e){
    var b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.classList.contains('ta-open')) { linking = true; msg = ''; render(); var f = box.querySelector('.ta-email'); if (f) f.focus(); }
    else if (b.classList.contains('ta-cancel')) { linking = false; msg = ''; render(); }
    else if (b.classList.contains('ta-link')) run({ action: 'link', email: (box.querySelector('.ta-email') || {}).value || '' }, 'Linked.');
    else if (b.classList.contains('ta-unlink')) {
      BOLD.confirmAction({ title: 'Unlink your test account?', go: 'Unlink', effects: ['It becomes an ordinary account again, shown on People'] }).then(function(ok){ if (ok) run({ action: 'unlink' }); });
    } else if (b.classList.contains('ta-reset')) {
      BOLD.confirmAction({ title: 'Reset your test account?', go: 'Reset', effects: ['Its details, onboarding, group requests, project invitations and asks go', 'It leaves the projects and event series it joined', 'It’s PAN-BOLD again (projects it registered stay)'] })
        .then(function(ok){ if (ok) run({ action: 'reset' }, 'Reset: it’s a newcomer again.'); });
    }
  });
  box.addEventListener('change', function(e){
    if (!e.target.classList.contains('ta-g')) return;
    var g = e.target.value, label = (GROUPS.filter(function(x){ return x[0] === g; })[0] || [])[1];
    BOLD.confirmAction({ title: 'Put your test account in ' + label + '?', go: 'Change', effects: ['Its group is ' + label + ' at once, without a request', 'Slack adds it to that group’s channels, as for anyone'] })
      .then(function(ok){ if (ok) run({ action: 'group', group: g }, 'It’s in ' + label + ' now.'); else render(); });
  });
  BOLD.onAccess(function(){
    render();
    if (BOLD.isFullWrite() && acct === undefined) {
      call({ action: 'get' }).then(function(r){ acct = r.data.account; }).catch(function(){ acct = null; msg = 'Couldn’t load it.'; }).then(render);
    }
  });
})();
