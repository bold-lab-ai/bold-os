// join-requests.html: the PIs and admins approve or decline requests to join
// BOLD (decideJoinRequest) and members' requests to be in another group of Who is BOLD
// (groupRequests, groupRequest), see whether each welcome email went (sendWelcomeEmail
// sends one again), and edit the Slack invite link, the email's text
// (settings/joinInvite), the join form's choices (settings/joinForm) and each group's
// Slack channel (settings/groups: whoever is in the group is added to it).
// Only PIs and admins can read any of it (firestore.rules), except "Invited by you":
// anyone an applicant named as inviting them to the Slack confirms it, or says they
// didn't (confirmJoinInvite; #i=<id> from their DM), and so do members who named them on
// their profile (setMyInviter; #invited).
// Tabs, by #hash: #signup, #invited, #groups, #settings (#r=, #g=, #i= open their
// request's tab). A request's answers are behind Details; names link to person.html.
(function(){
  var esc = BOLD.escapeHtml;
  var main = document.getElementById('joinRequests');
  if (!main || !BOLD.getAuth()) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var fn = function(name){ return firebase.app().functions('europe-west2').httpsCallable(name); };
  var me = null, staff = null, requests = null, invite = null, form = null, unsubs = [], busy = {}, editing = false;
  var groupReqs = [], groups = {}, invited = [], invitedMembers = [], shown = {}, slackIds = {};

  var SUBJECT = 'Welcome to BOLD';
  var BODY = ['Hi {name},', '', 'Welcome to BOLD! Your request to join has been approved. Here are your next steps:', '',
    '1. Join the BOLD Slack: {slackInvite}', '   You sign in to BOLD.OS with your Slack account, using this email address.',
    '2. Complete your profile: {site}profile.html', '3. Link your accounts (GitHub and Google): {site}profile.html#linked-accounts',
    '4. Read the BOLDiquette: {site}boldiquette.html', '5. Add your projects, if you have any: {site}projects-register.html', '',
    'See you on Slack,', 'The BOLD team'].join('\n');

  // Someone's name, linked to their page once they're on the BOLD Slack (the people roster).
  function who(name, email, cls){
    var id = slackIds[String(email || '').toLowerCase()], c = cls ? ' class="' + cls + '"' : '';
    return id ? '<a' + c + ' href="person.html?id=' + encodeURIComponent(id) + '">' + esc(name || email) + '</a>' : '<span' + c + '>' + esc(name || email) + '</span>';
  }
  // Details, collapsed: key is what's shown (shown[key]).
  function moreBtn(key){ return '<button type="button" class="btn-text jr-more" data-more="' + esc(key) + '" aria-expanded="' + !!shown[key] + '">' + (shown[key] ? 'Hide details' : 'Details') + '</button>'; }
  function when(t){ return t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }

  function requestHtml(r){
    var open = r.status === 'open';
    var w = r.welcome || {};
    var status = open ? '' : '<p class="proj-meta">' + (r.status === 'approved' ? 'Approved' : 'Declined') + ' by ' + who(r.decidedByName || r.decidedBy || '', r.decidedBy) + ', ' + when(r.decidedAt) +
      (r.status === 'approved' ? ' · Welcome email: ' + (w.status === 'sent' ? 'sent ' + when(w.at) : 'not sent yet' + (w.error ? ' (' + esc(w.error) + ')' : '')) : '') + '</p>';
    return '<li id="r-' + esc(r.id) + '">' + who(r.name, r.email, 'proj-title') +
      '<span class="proj-meta">' + esc([r.email, r.role, r.institution].filter(Boolean).join(' · ')) + ' · asked ' + when(r.at) + '</span>' + status +
      // Their answers, collapsed: a request is long.
      (shown[r.id] ? BoldJoin.factsHtml(r, { other: true }) : '') +
      '<div class="event-controls">' + moreBtn(r.id) + (open ?
        '<button type="button" class="btn-text jr-approve" data-id="' + esc(r.id) + '"' + (busy[r.id] ? ' disabled' : '') + '>Approve</button>' +
        '<button type="button" class="btn-text danger jr-decline" data-id="' + esc(r.id) + '"' + (busy[r.id] ? ' disabled' : '') + '>Decline</button>' :
        r.status === 'approved' && w.status !== 'sent' ? '<button type="button" class="btn-text jr-resend" data-id="' + esc(r.id) + '"' + (busy[r.id] ? ' disabled' : '') + '>Send the welcome email</button>' : '') +
      '</div></li>';
  }

  // A member asking to be in another group.
  function groupReqHtml(r){
    var open = r.status === 'open';
    return '<li id="g-' + esc(r.id) + '">' + who(r.name, r.email, 'proj-title') +
      '<span class="proj-meta">' + esc(r.email) + ' · asked ' + when(r.at) + '</span>' +
      '<p class="jr-move">' + BoldJoin.groupBadge(r.from) + ' → ' + BoldJoin.groupBadge(r.to) + '</p>' +
      (r.note && shown['g:' + r.id] ? '<p class="lt-text">' + esc(r.note) + '</p>' : '') +
      (open ? '' : '<p class="proj-meta">' + (r.status === 'withdrawn' ? 'Withdrawn' : (r.status === 'approved' ? 'Approved' : 'Declined') + ' by ' + who(r.decidedByName || r.decidedBy || '', r.decidedBy)) + ', ' + when(r.decidedAt) + '</p>') +
      '<div class="event-controls">' + (r.note ? moreBtn('g:' + r.id) : '') + (open ? '<button type="button" class="btn-text jr-g-approve" data-gid="' + esc(r.id) + '"' + (busy[r.id] ? ' disabled' : '') + '>Approve</button>' +
          '<button type="button" class="btn-text danger jr-g-decline" data-gid="' + esc(r.id) + '"' + (busy[r.id] ? ' disabled' : '') + '>Decline</button>' : '') + '</div></li>';
  }

  function settingsHtml(){
    var inv = invite || {}, f = form || {};
    var group = function(title){ return '<fieldset class="md-group"><legend>' + title + '</legend>'; };
    return '<section class="profile-panel" id="settings">' +
      '<div class="event-form join-form jr-settings">' +
      group('Slack invite') + '<label>Link (in Slack: Invite people → Copy invite link; replace it when it expires)<input type="url" class="jr-invite" maxlength="300" value="' + esc(inv.slackInviteUrl || '') + '" placeholder="https://join.slack.com/t/…"></label>' +
      '<label>Expires on (PIs and admins hear 3 days before)<input type="date" class="jr-expires" value="' + esc(inv.slackInviteExpires || '') + '"></label>' +
      '</fieldset>' + group('Welcome email') + '<label>Subject<input type="text" class="jr-subject" maxlength="200" value="' + esc(inv.subject || SUBJECT) + '"></label>' +
      '<label>Text ({name}: their first name, {slackInvite}: the link above, {site}: BOLD.OS)<textarea class="jr-body no-tags" rows="14" maxlength="5000">' + esc(inv.body || BODY) + '</textarea></label>' +
      '</fieldset>' + group('Slack channels') + '<p class="proj-meta">Everyone in a group, and in the groups above it, is added to its channel (<a href="boldiquette.html#who-is-bold">Who is BOLD</a>).</p>' +
        BoldJoin.CATEGORIES.filter(function(c){ return c[0] !== 'pan'; }).map(function(c){
          var err = (groups.channelErrors || {})[c[0]];
          return '<label>' + esc(c[1]) + '<input type="text" class="jr-chan" data-group="' + c[0] + '" maxlength="80" value="' + esc(((groups.channels || {})[c[0]]) || '') + '" placeholder="#channel (none: nobody is added)"></label>' +
            (err ? '<p class="st-error">' + esc(err) + '</p>' : '');
        }).join('') + '</fieldset>' + group('Join form') +
      '<label>Roles, one per line<textarea class="jr-roles no-tags" rows="6">' + esc((f.roles || BoldJoin.ROLES).join('\n')) + '</textarea></label>' +
      '<label>Research pillars, one per line<textarea class="jr-pillars no-tags" rows="4">' + esc((f.pillars || BoldJoin.PILLARS).join('\n')) + '</textarea></label></fieldset>' +
      '<p class="ev-error" hidden></p><div class="event-form-actions"><button type="button" class="ev-save jr-save">Save settings</button></div></div></section>';
  }

  // No invite link, or one expired or about to: welcome emails wait, or will.
  function inviteNotice(){
    var inv = invite || {}, exp = inv.slackInviteExpires || '';
    var today = new Date().toISOString().slice(0, 10), soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    var msg = !inv.slackInviteUrl ? 'There’s no Slack invite link yet: welcome emails wait until you add one under Settings.'
      : exp && exp < today ? 'The Slack invite link expired on ' + when(Date.parse(exp)) + ': welcome emails wait until you add a new one under Settings.'
      : exp && exp <= soon ? 'The Slack invite link expires on ' + when(Date.parse(exp)) + ': add a new one under Settings.' : '';
    return msg ? '<p class="jn-notice" id="jrNotice">' + esc(msg).replace('under Settings', 'under <a href="#settings">Settings</a>') + '</p>' : '';
  }

  // A request that names you as inviting them: confirm it, or say you didn't.
  function invitedHtml(r){
    var st = (r.invitedBy || {}).status, off = busy[r.id] ? ' disabled' : '';
    return '<li id="i-' + esc(r.id) + '">' + who(r.name, r.email, 'proj-title') +
      '<span class="proj-meta">' + esc(r.email) + ' · ' + esc([r.role, r.institution].filter(Boolean).join(', ')) + ' · asked ' + when(r.at) + '</span>' +
      '<p class="proj-meta">' + (st === 'confirmed' ? 'You confirmed you invited them.' : st === 'denied' ? 'You said you didn’t invite them.' : 'They say you invited them to the BOLD Slack.') + '</p>' +
      (shown['i:' + r.id] ? BoldJoin.factsHtml(r, { other: true }) : '') +
      '<div class="event-controls">' + moreBtn('i:' + r.id) + (st !== 'confirmed' ? '<button type="button" class="btn-text jr-i-yes" data-iid="' + esc(r.id) + '"' + off + '>Yes, I invited them</button>' : '') +
        (st !== 'denied' ? '<button type="button" class="btn-text danger jr-i-no" data-iid="' + esc(r.id) + '"' + off + '>I didn’t</button>' : '') + '</div></li>';
  }
  // A member who named you on their profile (setMyInviter): the same, by their email.
  function invitedMemberHtml(m){
    var st = (m.invitedBy || {}).status, key = 'm:' + m.email, off = busy[key] ? ' disabled' : '';
    return '<li>' + who(m.name, m.email, 'proj-title') +
      '<span class="proj-meta">' + esc([m.role, m.institution].filter(Boolean).join(', ')) + ' · said so on their profile</span>' +
      '<p class="proj-meta">' + (st === 'confirmed' ? 'You confirmed you invited them.' : st === 'denied' ? 'You said you didn’t invite them.' : 'They say you invited them to the BOLD Slack.') + '</p>' +
      '<div class="event-controls">' + (st !== 'confirmed' ? '<button type="button" class="btn-text jr-i-yes" data-mid="' + esc(m.email) + '"' + off + '>Yes, I invited them</button>' : '') +
        (st !== 'denied' ? '<button type="button" class="btn-text danger jr-i-no" data-mid="' + esc(m.email) + '"' + off + '>I didn’t</button>' : '') + '</div></li>';
  }
  // Without tabs (not a PI or admin), it keeps its heading.
  function invitedSection(tabbed){
    if (!invited.length && !invitedMembers.length) return '';
    var waiting = invited.concat(invitedMembers).filter(function(r){ return (r.invitedBy || {}).status === 'pending'; }).length;
    return '<section class="' + (tabbed ? 'profile-panel' : 'block') + '" id="invited">' + (tabbed ? '' : '<div class="block-head"><h2>Invited by you<span class="proj-count">' + waiting + ' to confirm</span></h2></div>') +
      '<ul class="proj-list">' + invited.map(invitedHtml).join('') + invitedMembers.map(invitedMemberHtml).join('') + '</ul></section>';
  }

  function render(){
    if (!me) return;
    if (staff === false) {
      main.innerHTML = invitedSection() + (invited.length || invitedMembers.length ? '' : '<p class="proj-msg">Only PIs and admins review these requests.</p>');
      jump();
      return;
    }
    if (staff === null || requests === null) { main.innerHTML = '<p class="proj-msg">Loading&hellip;</p>'; return; }
    if (editing) return; // don't redraw over settings being changed
    var open = requests.filter(function(r){ return r.status === 'open'; });
    var done = requests.filter(function(r){ return r.status !== 'open'; });
    var gOpen = groupReqs.filter(function(r){ return r.status === 'open'; });
    var gDone = groupReqs.filter(function(r){ return r.status !== 'open'; });
    var list = function(items, html, none){ return items.length ? '<ul class="proj-list">' + items.map(html).join('') + '</ul>' : '<p class="proj-msg">' + none + '</p>'; };
    var waiting = invited.concat(invitedMembers).filter(function(r){ return (r.invitedBy || {}).status === 'pending'; }).length;
    var n = function(k){ return k ? ' (' + k + ')' : ''; };
    // Four tabs, named by the #hash: joining BOLD, invited by you, changing group, settings.
    main.innerHTML =
      '<nav class="guide-tabs profile-tabs" id="jrTabs" aria-label="Requests">' +
        '<a class="guide-tab" href="#signup">Sign up' + n(open.length) + '</a>' +
        '<a class="guide-tab" href="#invited">Invited by you' + n(waiting) + '</a>' +
        '<a class="guide-tab" href="#groups">Groups' + n(gOpen.length) + '</a>' +
        '<a class="guide-tab" href="#settings">Settings</a></nav>' +
      inviteNotice() +
      '<section class="profile-panel" id="signup">' +
        list(open, requestHtml, 'No requests waiting.') +
        (done.length ? '<div class="proj-group"><h3>Decided</h3>' + list(done, requestHtml, '') + '</div>' : '') + '</section>' +
      (invitedSection(true) || '<section class="profile-panel" id="invited"><p class="proj-msg">Nobody says you invited them.</p></section>') +
      '<section class="profile-panel" id="groups">' +
        list(gOpen, groupReqHtml, 'No requests waiting.') +
        (gDone.length ? '<div class="proj-group"><h3>Decided</h3>' + list(gDone, groupReqHtml, '') + '</div>' : '') + '</section>' +
      settingsHtml();
    var s = main.querySelector('.jr-settings');
    s.addEventListener('input', function(){ editing = true; });
    showTab();
    jump();
  }
  // The tab a #hash names: links to one request (#r=, #g=, #i=) open its tab.
  function tabOf(h){
    var m = /^#([rgi])=/.exec(h);
    if (m) return { r: 'signup', g: 'groups', i: 'invited' }[m[1]];
    return ['#signup', '#invited', '#groups', '#settings'].indexOf(h) >= 0 ? h.slice(1) : '';
  }
  function showTab(){
    var tabs = document.getElementById('jrTabs');
    if (!tabs) return;
    var want = tabOf(location.hash) || 'signup';
    var note = document.getElementById('jrNotice');
    if (note) note.hidden = want !== 'signup' && want !== 'settings';
    ['signup', 'invited', 'groups', 'settings'].forEach(function(t){ var x = document.getElementById(t); if (x) x.hidden = t !== want; });
    Array.prototype.forEach.call(tabs.querySelectorAll('.guide-tab'), function(a){
      var on = a.getAttribute('href') === '#' + want;
      a.classList.toggle('is-current', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  window.addEventListener('hashchange', showTab);
  function jump(){
    var m = /#([rgi])=([A-Za-z0-9]+)/.exec(location.hash);
    var key = m && (m[1] === 'r' ? m[2] : m[1] + ':' + m[2]);
    if (key && !shown[key] && !render.jumped) { shown[key] = true; render(); return; }
    var el = m ? document.getElementById(m[1] + '-' + m[2]) : null;
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
    var channels = {};
    Array.prototype.forEach.call(s.querySelectorAll('.jr-chan'), function(i){ var v = i.value.trim().replace(/^#/, '').toLowerCase(); if (v) channels[i.getAttribute('data-group')] = v; });
    if (Object.keys(channels).some(function(k){ return !/^[a-z0-9_-]{1,80}$/.test(channels[k]); })) { err.textContent = 'Slack channel names use letters, numbers, hyphens and underscores.'; err.hidden = false; return; }
    var stamp = { updatedAt: Date.now(), updatedBy: me.email };
    btn.disabled = true; err.hidden = true;
    Promise.all([
      db.collection('settings').doc('joinInvite').set(Object.assign({ slackInviteUrl: url, slackInviteExpires: v('.jr-expires'), subject: v('.jr-subject').trim() || SUBJECT, body: v('.jr-body') || BODY }, stamp)),
      db.collection('settings').doc('joinForm').set(Object.assign({ roles: roles, pillars: pillars }, stamp)),
      db.collection('settings').doc('groups').set(Object.assign({ channels: channels }, stamp)),
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
    if (t.classList.contains('jr-more')) { var mo = t.getAttribute('data-more'); shown[mo] = !shown[mo]; render(); return; }
    var iid = t.getAttribute('data-iid'), mid = t.getAttribute('data-mid');
    if (iid || mid) {
      var yes = t.classList.contains('jr-i-yes'), key = iid || 'm:' + mid;
      if (!yes && !window.confirm('Say you didn’t invite them? The PIs and admins are told.')) return;
      busy[key] = true; render();
      fn('confirmJoinInvite')(iid ? { id: iid, confirm: yes } : { member: mid, confirm: yes }).catch(function(err){
        console.error('[BOLD Join] confirming the invitation failed', err);
        window.alert(err && err.message && err.code !== 'functions/internal' ? err.message : 'Couldn’t do that — try again.');
      }).then(function(){ delete busy[key]; render(); });
      return;
    }
    var gid = t.getAttribute('data-gid');
    if (gid) {
      var g = groupReqs.filter(function(q){ return q.id === gid; })[0];
      if (!g) return;
      var accept = t.classList.contains('jr-g-approve');
      if (!window.confirm((accept ? 'Move ' + g.name + ' to ' : 'Decline ' + g.name + '’s request for ') + BoldJoin.categoryLabel(g.to) + '? They’re told on Slack.')) return;
      busy[gid] = true; t.disabled = true;
      fn('groupRequest')({ action: 'decide', id: gid, accept: accept }).catch(function(err){
        console.error('[BOLD Join] deciding the group request failed', err);
        window.alert(err && err.message && err.code !== 'functions/internal' ? err.message : 'Couldn’t do that — try again.');
      }).then(function(){ delete busy[gid]; render(); });
      return;
    }
    var id = t.getAttribute('data-id');
    var r = requests && requests.filter(function(q){ return q.id === id; })[0];
    if (!r) return;
    var job;
    if (t.classList.contains('jr-approve')) {
      var inv = r.invitedBy || {};
      var unconfirmed = !inv.name ? '' : inv.status === 'denied' ? '\n\n' + inv.name + ' says they didn’t invite them.'
        : inv.status !== 'confirmed' ? '\n\n' + inv.name + ' hasn’t confirmed inviting them yet.' : '';
      if (!window.confirm('Approve ' + r.name + '? They’ll get the welcome email.' + unconfirmed)) return;
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
    staff = null; requests = null; invited = []; invitedMembers = [];
    db.collection('people').get().then(function(ps){
      ps.docs.forEach(function(d){ var e = String(d.data().email || '').toLowerCase(); if (e) slackIds[e] = d.id; });
      render();
    }).catch(function(){});
    if (!user) return;
    render();
    // Requests that name you as inviting them (readable by you: firestore.rules).
    unsubs.push(db.collection('joinRequests').where('invitedBy.email', '==', me.email).onSnapshot(function(snap){
      invited = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); })
        .filter(function(r){ return r.status === 'open' || (r.invitedBy || {}).status === 'pending'; })
        .sort(function(a, b){ return b.at - a.at; });
      render();
    }, function(err){ console.error('[BOLD Join] loading your invitations failed', err); }));
    // Members who named you on their profile (those from a request to join are listed above).
    unsubs.push(db.collection('members').where('invitedBy.email', '==', me.email).onSnapshot(function(snap){
      invitedMembers = snap.docs.map(function(d){ return Object.assign({ email: d.id }, d.data()); })
        .filter(function(m){ return (m.invitedBy || {}).via === 'profile'; })
        .sort(function(a, b){ return (b.invitedBy.askedAt || 0) - (a.invitedBy.askedAt || 0); });
      render();
    }, function(err){ console.error('[BOLD Join] loading members you invited failed', err); }));
    fn('getMyAccess')().then(function(r){
      staff = !!(r.data && r.data.fullWrite);
      if (!staff) { render(); return; }
      unsubs.push(db.collection('joinRequests').orderBy('at', 'desc').limit(200).onSnapshot(function(snap){
        requests = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
        render();
      }, function(err){ console.error('[BOLD Join] loading requests failed', err); }));
      unsubs.push(db.collection('settings').doc('joinInvite').onSnapshot(function(s){ invite = s.exists ? s.data() : {}; render(); }, function(){}));
      unsubs.push(db.collection('settings').doc('joinForm').onSnapshot(function(s){ form = s.exists ? s.data() : {}; render(); }, function(){}));
      unsubs.push(db.collection('groupRequests').orderBy('at', 'desc').limit(200).onSnapshot(function(snap){
        groupReqs = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); }); render();
      }, function(err){ console.error('[BOLD Join] loading group requests failed', err); }));
      unsubs.push(db.collection('settings').doc('groups').onSnapshot(function(s){ groups = s.exists ? s.data() : {}; render(); }, function(){}));
    }).catch(function(err){ console.error('[BOLD Join] checking access failed', err); staff = false; render(); });
  });
})();
