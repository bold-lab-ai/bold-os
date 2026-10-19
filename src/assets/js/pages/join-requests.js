// join-requests.html: the PIs and admins approve or decline requests to join
// BOLD (decideJoinRequest), see whether each welcome email went (sendWelcomeEmail
// sends one again), and edit the Slack invite link, the email's text
// (settings/joinInvite) and the join form's choices (settings/joinForm).
// Only PIs and admins can read any of it (firestore.rules).
(function(){
  var esc = BOLD.escapeHtml;
  var main = document.getElementById('joinRequests');
  if (!main || !BOLD.getAuth()) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var fn = function(name){ return firebase.app().functions('europe-west2').httpsCallable(name); };
  var me = null, staff = null, requests = null, invite = null, form = null, unsubs = [], busy = {}, editing = false;

  var SUBJECT = 'Welcome to BOLD';
  var BODY = ['Hi {name},', '', 'Welcome to BOLD! Your request to join has been approved. Here are your next steps:', '',
    '1. Join the BOLD Slack: {slackInvite}', '   You sign in to BOLD.OS with your Slack account, using this email address.',
    '2. Complete your profile: {site}profile.html', '3. Link your accounts (GitHub and Google): {site}profile.html#linked-accounts',
    '4. Read the BOLDiquette: {site}boldiquette.html', '5. Add your projects, if you have any: {site}projects-register.html', '',
    'See you on Slack,', 'The BOLD team'].join('\n');

  function when(t){ return t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }

  function requestHtml(r){
    var open = r.status === 'open';
    var w = r.welcome || {};
    var status = open ? '' : '<p class="proj-meta">' + (r.status === 'approved' ? 'Approved' : 'Declined') + ' by ' + esc(r.decidedByName || r.decidedBy || '') + ', ' + when(r.decidedAt) +
      (r.status === 'approved' ? ' · Welcome email: ' + (w.status === 'sent' ? 'sent ' + when(w.at) : 'not sent yet' + (w.error ? ' (' + esc(w.error) + ')' : '')) : '') + '</p>';
    return '<li id="r-' + esc(r.id) + '"><span class="proj-title">' + esc(r.name) + '</span>' +
      '<span class="proj-meta">' + esc(r.email) + ' · asked ' + when(r.at) + '</span>' + status +
      BoldJoin.factsHtml(r) +
      '<div class="event-controls">' + (open ?
        '<button type="button" class="btn-text jr-approve" data-id="' + esc(r.id) + '"' + (busy[r.id] ? ' disabled' : '') + '>Approve</button>' +
        '<button type="button" class="btn-text danger jr-decline" data-id="' + esc(r.id) + '"' + (busy[r.id] ? ' disabled' : '') + '>Decline</button>' :
        r.status === 'approved' && w.status !== 'sent' ? '<button type="button" class="btn-text jr-resend" data-id="' + esc(r.id) + '"' + (busy[r.id] ? ' disabled' : '') + '>Send the welcome email</button>' : '') +
      '</div></li>';
  }

  function settingsHtml(){
    var inv = invite || {}, f = form || {};
    return '<section class="block" id="settings"><div class="block-head"><h2>Settings</h2></div>' +
      '<div class="event-form join-form jr-settings">' +
      '<label>Slack invite link (in Slack: Invite people → Copy invite link; replace it when it expires)<input type="url" class="jr-invite" maxlength="300" value="' + esc(inv.slackInviteUrl || '') + '" placeholder="https://join.slack.com/t/…"></label>' +
      '<label>The invite link expires on (PIs and admins hear 3 days before)<input type="date" class="jr-expires" value="' + esc(inv.slackInviteExpires || '') + '"></label>' +
      '<label>Welcome email subject<input type="text" class="jr-subject" maxlength="200" value="' + esc(inv.subject || SUBJECT) + '"></label>' +
      '<label>Welcome email ({name}: their first name, {slackInvite}: the link above, {site}: BOLD.OS)<textarea class="jr-body no-tags" rows="14" maxlength="5000">' + esc(inv.body || BODY) + '</textarea></label>' +
      '<label>Roles on the join form, one per line<textarea class="jr-roles no-tags" rows="6">' + esc((f.roles || BoldJoin.ROLES).join('\n')) + '</textarea></label>' +
      '<label>Research pillars on the join form, one per line<textarea class="jr-pillars no-tags" rows="4">' + esc((f.pillars || BoldJoin.PILLARS).join('\n')) + '</textarea></label>' +
      '<p class="ev-error" hidden></p><div class="event-form-actions"><button type="button" class="ev-save jr-save">Save settings</button></div></div></section>';
  }

  // No invite link, or one expired or about to: welcome emails wait, or will.
  function inviteNotice(){
    var inv = invite || {}, exp = inv.slackInviteExpires || '';
    var today = new Date().toISOString().slice(0, 10), soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    var msg = !inv.slackInviteUrl ? 'There’s no Slack invite link yet: welcome emails wait until you add one under Settings.'
      : exp && exp < today ? 'The Slack invite link expired on ' + when(Date.parse(exp)) + ': welcome emails wait until you add a new one under Settings.'
      : exp && exp <= soon ? 'The Slack invite link expires on ' + when(Date.parse(exp)) + ': add a new one under Settings.' : '';
    return msg ? '<p class="jn-notice">' + esc(msg).replace('under Settings', 'under <a href="#settings">Settings</a>') + '</p>' : '';
  }

  function render(){
    if (!me) return;
    if (staff === false) { main.innerHTML = '<p class="proj-msg">Only PIs and admins review requests to join.</p>'; return; }
    if (staff === null || requests === null) { main.innerHTML = '<p class="proj-msg">Loading&hellip;</p>'; return; }
    if (editing) return; // don't redraw over settings being changed
    var open = requests.filter(function(r){ return r.status === 'open'; });
    var done = requests.filter(function(r){ return r.status !== 'open'; });
    main.innerHTML =
      inviteNotice() +
      '<section class="block"><div class="block-head"><h2>Waiting<span class="proj-count">' + open.length + '</span></h2></div>' +
        (open.length ? '<ul class="proj-list">' + open.map(requestHtml).join('') + '</ul>' : '<p class="proj-msg">No requests waiting.</p>') + '</section>' +
      '<section class="block"><div class="block-head"><h2>Decided</h2></div>' +
        (done.length ? '<ul class="proj-list">' + done.map(requestHtml).join('') + '</ul>' : '<p class="proj-msg">None yet.</p>') + '</section>' +
      settingsHtml();
    var s = main.querySelector('.jr-settings');
    s.addEventListener('input', function(){ editing = true; });
    var m = /#r=([A-Za-z0-9]+)/.exec(location.hash), el = m && document.getElementById('r-' + m[1]);
    if (el && !render.jumped) { render.jumped = true; el.scrollIntoView({ block: 'start' }); }
  }

  function lines(t){ return t.split('\n').map(function(l){ return l.trim(); }).filter(Boolean); }

  function saveSettings(btn){
    var s = main.querySelector('.jr-settings'), err = s.querySelector('.ev-error');
    var v = function(c){ return s.querySelector(c).value; };
    var url = v('.jr-invite').trim();
    if (url && !/^https:\/\/\S+$/.test(url)) { err.textContent = 'The invite link starts with https://'; err.hidden = false; return; }
    var roles = lines(v('.jr-roles')), pillars = lines(v('.jr-pillars'));
    if (!roles.length) { err.textContent = 'Give at least one role.'; err.hidden = false; return; }
    var stamp = { updatedAt: Date.now(), updatedBy: me.email };
    btn.disabled = true; err.hidden = true;
    Promise.all([
      db.collection('settings').doc('joinInvite').set(Object.assign({ slackInviteUrl: url, slackInviteExpires: v('.jr-expires'), subject: v('.jr-subject').trim() || SUBJECT, body: v('.jr-body') || BODY }, stamp)),
      db.collection('settings').doc('joinForm').set(Object.assign({ roles: roles, pillars: pillars }, stamp)),
    ]).then(function(){
      editing = false; btn.disabled = false; btn.textContent = 'Saved'; setTimeout(function(){ btn.textContent = 'Save settings'; }, 1500);
    }).catch(function(e){
      console.error('[BOLD Join] saving the settings failed', e);
      err.textContent = 'Couldn’t save — try again.'; err.hidden = false; btn.disabled = false;
    });
  }

  main.addEventListener('click', function(e){
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.classList.contains('jr-save')) { saveSettings(t); return; }
    var id = t.getAttribute('data-id');
    var r = requests && requests.filter(function(q){ return q.id === id; })[0];
    if (!r) return;
    var job;
    if (t.classList.contains('jr-approve')) {
      if (!window.confirm('Approve ' + r.name + '? They’ll get the welcome email.')) return;
      job = fn('decideJoinRequest')({ id: id, accept: true });
    } else if (t.classList.contains('jr-decline')) {
      if (!window.confirm('Decline ' + r.name + '’s request? They aren’t told.')) return;
      job = fn('decideJoinRequest')({ id: id, accept: false });
    } else if (t.classList.contains('jr-resend')) job = fn('sendWelcomeEmail')({ id: id });
    if (!job) return;
    busy[id] = true; t.disabled = true;
    job.catch(function(err){
      console.error('[BOLD Join] that failed', err);
      window.alert(err && err.message && err.code !== 'functions/internal' ? err.message : 'Couldn’t do that — try again.');
    }).then(function(){ delete busy[id]; render(); });
  });

  BOLD.onUser(function(user){
    unsubs.forEach(function(u){ u(); }); unsubs = [];
    me = user ? { email: (user.email || '').toLowerCase() } : null;
    staff = null; requests = null;
    if (!user) return;
    render();
    fn('getMyAccess')().then(function(r){
      staff = !!(r.data && r.data.fullWrite);
      if (!staff) { render(); return; }
      unsubs.push(db.collection('joinRequests').orderBy('at', 'desc').limit(200).onSnapshot(function(snap){
        requests = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
        render();
      }, function(err){ console.error('[BOLD Join] loading requests failed', err); }));
      unsubs.push(db.collection('settings').doc('joinInvite').onSnapshot(function(s){ invite = s.exists ? s.data() : {}; render(); }, function(){}));
      unsubs.push(db.collection('settings').doc('joinForm').onSnapshot(function(s){ form = s.exists ? s.data() : {}; render(); }, function(){}));
    }).catch(function(err){ console.error('[BOLD Join] checking access failed', err); staff = false; render(); });
  });
})();
