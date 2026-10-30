// join-requests.html (People → Requests): whoever an applicant names as inviting them approves
// or declines their request to join BOLD (decideJoinRequest; #i=<id> from their DM);
// PIs and admins see them all but decide only one without an inviter; members' requests to be in another group of Who is BOLD
// (groupRequests, groupRequest), decided the same way: whoever invited them, or the PIs and admins when nobody did; PIs and admins also see whether each welcome email went (sendWelcomeEmail
// sends one again); BOLD.OS's settings (the invite link, the email, the join form, the
// groups' channels, the pilots) are on settings.html (pages/settings.js).
// Only PIs and admins can read all of it (firestore.rules); everyone else sees, under Sign up,
// the requests naming them and members who named them on their profile (setMyInviter), and
// confirms or says they didn't invite them (confirmJoinInvite), and under Group change those
// they decide. One list for everyone: each person's own are also on their Requests (requests.html).
// PIs and admins also decide requests to let an agent act for someone (apiTokens
// 'actRequests'/'decideAct' in functions/api.js; the Agents tab).
// Tabs, by #hash: #signup, #groups, #agents (#r=, #g=, #i= open their request's tab; #invited,
// the old Invited by you tab, opens Sign up); #settings, the old Settings tab, opens settings.html. A request's answers are behind Details; names link to person.html.
(function(){
  var esc = BOLD.escapeHtml;
  var main = document.getElementById('joinRequests');
  if (!main || !BOLD.getAuth()) return;
  // Links to the old Settings tab (Slack messages, bookmarks) open the settings page.
  var toSettings = function(){ if (location.hash === '#settings') { location.replace('settings.html'); return true; } };
  if (toSettings()) return;
  window.addEventListener('hashchange', toSettings);
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var fn = function(name){ return firebase.app().functions('europe-west2').httpsCallable(name); };
  var me = null, staff = null, requests = null, invite = null, unsubs = [], busy = {};
  var groupReqs = [], myGroupReqs = [], invited = [], invitedMembers = [], shown = {}, slackIds = {}, actReqs = [];


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
    // Only whoever invited them decides it (decideJoinRequest); PIs and admins only one without an inviter.
    var inv = r.invitedBy && r.invitedBy.email ? r.invitedBy : null, mine = !inv || (me && inv.email === me.email);
    var off = busy[r.id] ? ' disabled' : mine ? '' : ' disabled title="' + esc('Only ' + (inv.name || inv.email) + ', who invited them, decides this') + '"';
    var w = r.welcome || {};
    var status = open ? '' : '<p class="proj-meta">' + (r.status === 'approved' ? 'Approved' : 'Declined') + ' by ' + who(r.decidedByName || r.decidedBy || '', r.decidedBy) + ', ' + when(r.decidedAt) +
      (r.status === 'approved' && staff ? ' · Welcome email: ' + (w.status === 'sent' ? 'sent ' + when(w.at) : 'not sent yet' + (w.error ? ' (' + esc(w.error) + ')' : '')) : '') + '</p>';
    return '<li id="r-' + esc(r.id) + '">' + who(r.name, r.email, 'proj-title') +
      '<span class="proj-meta">' + esc([r.email, r.role, r.institution].filter(Boolean).join(' · ')) + ' · asked ' + when(r.at) + '</span>' + status +
      (toConfirm(r) ? '<p class="proj-meta">They say you invited them.</p>' : '') +
      (open && inv && !mine ? '<p class="proj-meta">Invited by ' + who(inv.name, inv.email) + ', who decides it</p>' : '') +
      // Their answers, collapsed: a request is long.
      (shown[r.id] ? BoldJoin.factsHtml(r, { other: true }) : '') +
      '<div class="event-controls">' + moreBtn(r.id) + (open ?
        '<button type="button" class="btn-text jr-approve" data-id="' + esc(r.id) + '"' + off + '>Approve</button>' +
        '<button type="button" class="btn-text danger jr-decline" data-id="' + esc(r.id) + '"' + off + '>Decline</button>' :
        (toConfirm(r) ? '<button type="button" class="btn-text jr-i-yes" data-iid="' + esc(r.id) + '"' + (busy[r.id] ? ' disabled' : '') + '>Yes, I invited them</button>' +
          '<button type="button" class="btn-text danger jr-i-no" data-iid="' + esc(r.id) + '"' + (busy[r.id] ? ' disabled' : '') + '>I didn’t</button>' : '') +
        (staff && r.status === 'approved' && w.status !== 'sent' ? '<button type="button" class="btn-text jr-resend" data-id="' + esc(r.id) + '"' + (busy[r.id] ? ' disabled' : '') + '>Send the welcome email</button>' : '')) +
      '</div></li>';
  }

  // A member asking to be in another group.
  function groupReqHtml(r){
    var open = r.status === 'open';
    // Whoever invited them decides it (groupRequest); PIs and admins only one without an inviter.
    var others = !!(r.inviterEmail && !(me && r.inviterEmail === me.email.toLowerCase()));
    var off = busy[r.id] || others ? ' disabled' + (others ? ' title="' + esc((r.inviterName || 'Whoever invited them') + ' decides this: they invited them') + '"' : '') : '';
    return '<li id="g-' + esc(r.id) + '">' + who(r.name, r.email, 'proj-title') +
      '<span class="proj-meta">' + esc(r.email) + ' · asked ' + when(r.at) + '</span>' +
      '<p class="jr-move">' + BoldJoin.groupBadge(r.from) + ' → ' + BoldJoin.groupBadge(r.to) + '</p>' +
      (r.note && shown['g:' + r.id] ? '<p class="lt-text">' + esc(r.note) + '</p>' : '') +
      (open && others ? '<p class="proj-meta">Invited by ' + who(r.inviterName || r.inviterEmail, r.inviterEmail) + ', who decides it</p>' : '') +
      (open ? '' : '<p class="proj-meta">' + (r.status === 'withdrawn' ? 'Withdrawn' : (r.status === 'approved' ? 'Approved' : 'Declined') + ' by ' + who(r.decidedByName || r.decidedBy || '', r.decidedBy)) + ', ' + when(r.decidedAt) + '</p>') +
      '<div class="event-controls">' + (r.note ? moreBtn('g:' + r.id) : '') + (open ? '<button type="button" class="btn-text jr-g-approve" data-gid="' + esc(r.id) + '"' + off + '>Approve</button>' +
          '<button type="button" class="btn-text danger jr-g-decline" data-gid="' + esc(r.id) + '"' + off + '>Decline</button>' : '') + '</div></li>';
  }

  // A request to let someone's agent act for them (a token of theirs, functions/api.js).
  function actReqHtml(r){
    var open = r.status === 'open', off = busy['a:' + r.id] ? ' disabled' : '';
    return '<li>' + who(r.owner, r.email, 'proj-title') +
      '<span class="proj-meta">Token “' + esc(r.label) + '” <code>' + esc(r.prefix) + '…</code> · asked ' + when(r.at) + (r.lastUsedAt ? ' · last used ' + when(r.lastUsedAt) : '') + '</span>' +
      (r.note ? '<p class="lt-text">' + esc(r.note) + '</p>' : '') +
      (open ? '' : '<p class="proj-meta">' + ({ approved: 'Approved', declined: 'Declined', stopped: 'Stopped' }[r.status] || r.status) + (r.decidedByName ? ' by ' + esc(r.decidedByName) : '') + ', ' + when(r.decidedAt) + '</p>') +
      '<div class="event-controls">' + (open ? '<button type="button" class="btn-text jr-a-approve" data-aid="' + esc(r.id) + '"' + off + '>Approve</button>' +
        '<button type="button" class="btn-text danger jr-a-decline" data-aid="' + esc(r.id) + '"' + off + '>Decline</button>'
        : r.status === 'approved' ? '<button type="button" class="btn-text danger jr-a-stop" data-aid="' + esc(r.id) + '"' + off + '>Stop acting</button>' : '') + '</div></li>';
  }
  function loadActReqs(){
    return fn('apiTokens')({ action: 'actRequests' }).then(function(r){ actReqs = (r.data && r.data.requests) || []; render(); })
      .catch(function(err){ console.error('[BOLD Join] loading agent requests failed', err); });
  }



  // No invite link, or one expired or about to: welcome emails wait, or will.
  function inviteNotice(){
    var inv = invite || {}, exp = inv.slackInviteExpires || '';
    var today = new Date().toISOString().slice(0, 10), soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    var msg = !inv.slackInviteUrl ? 'There’s no Slack invite link yet: welcome emails wait until you add one under Settings.'
      : exp && exp < today ? 'The Slack invite link expired on ' + when(Date.parse(exp)) + ': welcome emails wait until you add a new one under Settings.'
      : exp && exp <= soon ? 'The Slack invite link expires on ' + when(Date.parse(exp)) + ': add a new one under Settings.' : '';
    return msg ? '<p class="jn-notice" id="jrNotice">' + esc(msg).replace('under Settings', 'under <a href="settings.html">Settings</a>') + '</p>' : '';
  }

  // Approved by a PI or admin, naming you as inviting them: confirm it, or say you didn't.
  function toConfirm(r){ var inv = r.invitedBy || {}; return r.status === 'approved' && me && inv.email === me.email && inv.status === 'pending'; }
  // A member who named you on their profile (setMyInviter): the same, by their email.
  function invitedMemberHtml(m){
    var st = (m.invitedBy || {}).status, key = 'm:' + m.email, off = busy[key] ? ' disabled' : '';
    return '<li>' + who(m.name, m.email, 'proj-title') +
      '<span class="proj-meta">' + esc([m.role, m.institution].filter(Boolean).join(', ')) + ' · said so on their profile</span>' +
      '<p class="proj-meta">' + (st === 'confirmed' ? 'You confirmed you invited them.' : st === 'denied' ? 'You said you didn’t invite them.' : 'They name you as their point of contact, who invited them.') + '</p>' +
      '<div class="event-controls">' + (st !== 'confirmed' ? '<button type="button" class="btn-text jr-i-yes" data-mid="' + esc(m.email) + '"' + off + '>Yes, I invited them</button>' : '') +
        (st !== 'denied' ? '<button type="button" class="btn-text danger jr-i-no" data-mid="' + esc(m.email) + '"' + off + '>I didn’t</button>' : '') + '</div></li>';
  }
  function render(){
    if (!me) return;
    if (staff === null || (staff && requests === null)) { main.innerHTML = '<p class="proj-msg">Loading&hellip;</p>'; return; }
    // PIs and admins see every request; everyone else those naming them as inviting them, and
    // who named them on their profile. Theirs are also on their own Requests (requests.html).
    var reqs = staff ? requests : invited, groupsAll = staff ? groupReqs : myGroupReqs;
    var waits = function(r){ return r.status === 'open' || toConfirm(r); };
    var open = reqs.filter(waits), done = reqs.filter(function(r){ return !waits(r); });
    var mOpen = invitedMembers.filter(function(m){ return (m.invitedBy || {}).status === 'pending'; });
    var mDone = invitedMembers.filter(function(m){ return (m.invitedBy || {}).status !== 'pending'; });
    var gOpen = groupsAll.filter(function(r){ return r.status === 'open'; });
    var gDone = groupsAll.filter(function(r){ return r.status !== 'open'; });
    var aOpen = actReqs.filter(function(r){ return r.status === 'open'; });
    var aDone = actReqs.filter(function(r){ return r.status !== 'open'; });
    var ul = function(html){ return html ? '<ul class="proj-list">' + html + '</ul>' : ''; };
    var rows = function(items, html){ return items.map(html).join(''); };
    var n = function(k){ return k ? ' (' + k + ')' : ''; };
    var openHtml = rows(open, requestHtml) + rows(mOpen, invitedMemberHtml), doneHtml = rows(done, requestHtml) + rows(mDone, invitedMemberHtml);
    // Tabs, named by the #hash: joining BOLD, changing group, and agents acting (PIs and admins).
    main.innerHTML =
      '<nav class="guide-tabs profile-tabs" id="jrTabs" aria-label="Requests">' +
        '<a class="guide-tab" href="#signup">Sign up' + n(open.length + mOpen.length) + '</a>' +
        '<a class="guide-tab" href="#groups">Group change' + n(gOpen.length) + '</a>' +
        (staff ? '<a class="guide-tab" href="#agents">Agents' + n(aOpen.length) + '</a>' : '') + '</nav>' +
      (staff ? inviteNotice() : '') +
      '<section class="profile-panel" id="signup">' +
        (ul(openHtml) || '<p class="proj-msg">No requests waiting.</p>') +
        (doneHtml ? '<div class="proj-group"><h3>Decided</h3>' + ul(doneHtml) + '</div>' : '') + '</section>' +
      '<section class="profile-panel" id="groups">' +
        (ul(rows(gOpen, groupReqHtml)) || '<p class="proj-msg">No requests waiting.</p>') +
        (gDone.length ? '<div class="proj-group"><h3>Decided</h3>' + ul(rows(gDone, groupReqHtml)) + '</div>' : '') + '</section>' +
      (staff ? '<section class="profile-panel" id="agents"><p class="hero-note">Requests to let an agent act for someone, in their name: join projects, ask for introductions and letters, comment, propose changes and more. <a href="agents.html#activity">What agents did</a>.</p>' +
        (ul(rows(aOpen, actReqHtml)) || '<p class="proj-msg">No requests waiting.</p>') +
        (aDone.length ? '<div class="proj-group"><h3>Decided</h3>' + ul(rows(aDone, actReqHtml)) + '</div>' : '') + '</section>' : '');
    showTab();
    jump();
  }
  // The tab a #hash names: links to one request (#r=, #g=, #i=) open its tab; #invited, the
  // old Invited by you tab (Slack messages), is Sign up.
  function tabOf(h){
    var m = /^#([rgi])=/.exec(h);
    if (m) return { r: 'signup', g: 'groups', i: 'signup' }[m[1]];
    if (h === '#invited') return 'signup';
    return ['#signup', '#groups', '#agents'].indexOf(h) >= 0 ? h.slice(1) : '';
  }
  function showTab(){
    var tabs = document.getElementById('jrTabs');
    if (!tabs) return;
    var want = tabOf(location.hash) || 'signup';
    var note = document.getElementById('jrNotice');
    if (note) note.hidden = want !== 'signup';
    if (!document.getElementById(want)) want = 'signup';
    ['signup', 'groups', 'agents'].forEach(function(t){ var x = document.getElementById(t); if (x) x.hidden = t !== want; });
    Array.prototype.forEach.call(tabs.querySelectorAll('.guide-tab'), function(a){
      var on = a.getAttribute('href') === '#' + want;
      a.classList.toggle('is-current', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  window.addEventListener('hashchange', showTab);
  function jump(){
    var m = /#([rgi])=([A-Za-z0-9]+)/.exec(location.hash);
    var t = m && (m[1] === 'i' ? 'r' : m[1]);   // #i=, from an inviter's DM: the same row
    var key = m && (t === 'r' ? m[2] : t + ':' + m[2]);
    if (key && !shown[key] && !render.jumped) { shown[key] = true; render(); return; }
    var el = m ? document.getElementById(t + '-' + m[2]) : null;
    if (el && !render.jumped) { render.jumped = true; el.scrollIntoView({ block: 'start' }); }
  }


  main.addEventListener('click', function(e){
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.classList.contains('jr-more')) { var mo = t.getAttribute('data-more'); shown[mo] = !shown[mo]; render(); return; }
    var iid = t.getAttribute('data-iid'), mid = t.getAttribute('data-mid');
    if (iid || mid) {
      var yes = t.classList.contains('jr-i-yes'), key = iid || 'm:' + mid;
      (yes ? Promise.resolve(true) : BOLD.confirmAlways({ title: 'Say you didn’t invite them?', go: 'Say so', effects: ['Tell the PIs and admins on Slack'] })).then(function(ok){
        if (ok) confirmInvite(key, iid, mid, yes);
      });
      return;
    }
    var aid = t.getAttribute('data-aid');
    if (aid) {
      var a = actReqs.filter(function(q){ return q.id === aid; })[0];
      if (!a) return;
      var stop = t.classList.contains('jr-a-stop'), ayes = t.classList.contains('jr-a-approve');
      BOLD.confirmAction(stop ? { title: 'Stop ' + a.owner + '’s agent acting for them?', go: 'Stop', effects: ['It still reads'] }
        : ayes ? { title: 'Let ' + a.owner + '’s agent act for them?', go: 'Approve', effects: ['Tell ' + a.owner + ' on Slack', 'Let their agent act in their name: people get Slack messages from them'] }
        : { title: 'Decline ' + a.owner + '’s request?', go: 'Decline', effects: ['Tell ' + a.owner + ' on Slack'] }).then(function(ok){ if (ok) decideAct(t, aid, stop, ayes); });
      return;
    }
    var gid = t.getAttribute('data-gid');
    if (gid) {
      var g = groupReqs.concat(myGroupReqs).filter(function(q){ return q.id === gid; })[0];
      if (!g) return;
      var accept = t.classList.contains('jr-g-approve');
      BOLD.confirmAction({ title: (accept ? 'Move ' + g.name + ' to ' : 'Decline ' + g.name + '’s request for ') + BoldJoin.categoryLabel(g.to) + '?', go: accept ? 'Move' : 'Decline',
        effects: ['Tell ' + g.name + ' on Slack'].concat(accept ? ['Add them to the Slack channels of ' + BoldJoin.categoryLabel(g.to) + ', if it has any'] : []) })
        .then(function(ok){ if (ok) decideGroup(t, gid, accept); });
      return;
    }
    rest(t);
  });
  function confirmInvite(key, iid, mid, yes){
    busy[key] = true; render();
    fn('confirmJoinInvite')(iid ? { id: iid, confirm: yes } : { member: mid, confirm: yes }).catch(function(err){
      console.error('[BOLD Join] confirming the invitation failed', err);
      window.alert(err && err.message && err.code !== 'functions/internal' ? err.message : 'Couldn’t do that — try again.');
    }).then(function(){ delete busy[key]; render(); });
  }
  function decideAct(t, aid, stop, yes){
    busy['a:' + aid] = true; t.disabled = true;
    fn('apiTokens')(stop ? { action: 'stopAct', id: aid } : { action: 'decideAct', id: aid, accept: yes }).catch(function(err){
      console.error('[BOLD Join] deciding the agent request failed', err);
      window.alert(err && err.message && err.code !== 'functions/internal' ? err.message : 'Couldn’t do that — try again.');
    }).then(function(){ delete busy['a:' + aid]; return loadActReqs(); });
  }
  function decideGroup(t, gid, accept){
    busy[gid] = true; t.disabled = true;
    fn('groupRequest')({ action: 'decide', id: gid, accept: accept }).catch(function(err){
      console.error('[BOLD Join] deciding the group request failed', err);
      window.alert(err && err.message && err.code !== 'functions/internal' ? err.message : 'Couldn’t do that — try again.');
    }).then(function(){ delete busy[gid]; render(); });
  }
  function rest(t){
    var id = t.getAttribute('data-id');
    var r = (requests || []).concat(invited).filter(function(q){ return q.id === id; })[0];
    if (!r) return;
    var run = function(job){
      busy[id] = true; t.disabled = true;
      job().catch(function(err){
        console.error('[BOLD Join] that failed', err);
        window.alert(err && err.message && err.code !== 'functions/internal' ? err.message : 'Couldn’t do that — try again.');
      }).then(function(){ delete busy[id]; render(); });
    };
    if (t.classList.contains('jr-approve')) {
      var inv = r.invitedBy || {};
      var group = BoldJoin.cappedGroup(BoldJoin.roleGroup(r.role), staff ? 'exec' : BOLD.myGroup());
      var unconfirmed = !inv.name || inv.email === me.email ? '' : inv.status === 'denied' ? inv.name + ' says they didn’t invite them.'
        : inv.status !== 'confirmed' ? inv.name + ' hasn’t confirmed inviting them yet.' : '';
      BOLD.confirmAlways({ title: 'Approve ' + r.name + '?' + (unconfirmed ? ' ' + unconfirmed : ''), go: 'Approve', effects: ['Email ' + r.name + ' the welcome, with how to join the BOLD Slack', 'Put them in ' + BoldJoin.categoryLabel(group) + (staff ? ' (change it on People)' : ' (a PI or admin can change it)')] })
        .then(function(ok){ if (ok) run(function(){ return fn('decideJoinRequest')({ id: id, accept: true }); }); });
    } else if (t.classList.contains('jr-decline')) {
      if (window.confirm('Decline ' + r.name + '’s request? They aren’t told.')) run(function(){ return fn('decideJoinRequest')({ id: id, accept: false }); });
    } else if (t.classList.contains('jr-resend')) {
      BOLD.confirmAlways({ title: 'Send the welcome email again?', go: 'Send', effects: ['Email ' + r.name + ' the welcome again'] })
        .then(function(ok){ if (ok) run(function(){ return fn('sendWelcomeEmail')({ id: id }); }); });
    }
  }

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
        .filter(function(r){ return r.status === 'open' || (r.status === 'approved' && (r.invitedBy || {}).status === 'pending'); })
        .sort(function(a, b){ return b.at - a.at; });
      render();
    }, function(err){ console.error('[BOLD Join] loading your invitations failed', err); }));
    // Requests to change group from people you invited (you decide them).
    unsubs.push(db.collection('groupRequests').where('inviterEmail', '==', me.email.toLowerCase()).onSnapshot(function(snap){
      myGroupReqs = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); }).sort(function(a, b){ return b.at - a.at; });
      render();
    }, function(err){ console.error('[BOLD Join] loading group requests for you failed', err); }));
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
      unsubs.push(db.collection('groupRequests').orderBy('at', 'desc').limit(200).onSnapshot(function(snap){
        groupReqs = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); }); render();
      }, function(err){ console.error('[BOLD Join] loading group requests failed', err); }));
      loadActReqs();
    }).catch(function(err){ console.error('[BOLD Join] checking access failed', err); staff = false; render(); });
  });
})();
