// join-requests.html: whoever an applicant names as inviting them approves or declines
// their request to join BOLD (decideJoinRequest; "Invited by you", #i=<id> from their DM);
// PIs and admins see them all but decide only one without an inviter; members' requests to be in another group of Who is BOLD
// (groupRequests, groupRequest), decided the same way: whoever invited them, or the PIs and admins when nobody did; PIs and admins also see whether each welcome email went (sendWelcomeEmail
// sends one again), and edit the Slack invite link, the email's text
// (settings/joinInvite), the join form's choices (settings/joinForm) and each group's
// Slack channel (settings/groups: whoever is in the group is added to it).
// Only PIs and admins can read any of it (firestore.rules), except "Invited by you": the
// requests naming you, and members who named you on their profile (setMyInviter;
// #invited), who you confirm or say you didn't invite (confirmJoinInvite).
// and requests to let an agent act for someone (apiTokens 'actRequests'/'decideAct' in
// functions/api.js; the Agents tab).
// Tabs, by #hash: #signup, #invited, #groups, #agents, #settings (#r=, #g=, #i= open their
// request's tab). A request's answers are behind Details; names link to person.html.
(function(){
  var esc = BOLD.escapeHtml;
  var main = document.getElementById('joinRequests');
  if (!main || !BOLD.getAuth()) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var fn = function(name){ return firebase.app().functions('europe-west2').httpsCallable(name); };
  var me = null, staff = null, requests = null, invite = null, form = null, unsubs = [], busy = {}, editing = false;
  // Pilots (settings/pilot; functions/index.js pilotSlack): a new Slack feature only messages
  // its testers until it's switched live here. pilotDraft: the form's testers and switches.
  var pilot = null, pilotDraft = null, pilotError = '', roster = [];
  var groupReqs = [], myGroupReqs = [], groups = {}, invited = [], invitedMembers = [], shown = {}, slackIds = {}, actReqs = [];

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
    // Only whoever invited them decides it (decideJoinRequest); PIs and admins only one without an inviter.
    var inv = r.invitedBy && r.invitedBy.email ? r.invitedBy : null, mine = !inv || (me && inv.email === me.email);
    var off = busy[r.id] ? ' disabled' : mine ? '' : ' disabled title="' + esc('Only ' + (inv.name || inv.email) + ', who invited them, decides this') + '"';
    var w = r.welcome || {};
    var status = open ? '' : '<p class="proj-meta">' + (r.status === 'approved' ? 'Approved' : 'Declined') + ' by ' + who(r.decidedByName || r.decidedBy || '', r.decidedBy) + ', ' + when(r.decidedAt) +
      (r.status === 'approved' ? ' · Welcome email: ' + (w.status === 'sent' ? 'sent ' + when(w.at) : 'not sent yet' + (w.error ? ' (' + esc(w.error) + ')' : '')) : '') + '</p>';
    return '<li id="r-' + esc(r.id) + '">' + who(r.name, r.email, 'proj-title') +
      '<span class="proj-meta">' + esc([r.email, r.role, r.institution].filter(Boolean).join(' · ')) + ' · asked ' + when(r.at) + '</span>' + status +
      (open && inv && !mine ? '<p class="proj-meta">Invited by ' + who(inv.name, inv.email) + ', who decides it</p>' : '') +
      // Their answers, collapsed: a request is long.
      (shown[r.id] ? BoldJoin.factsHtml(r, { other: true }) : '') +
      '<div class="event-controls">' + moreBtn(r.id) + (open ?
        '<button type="button" class="btn-text jr-approve" data-id="' + esc(r.id) + '"' + off + '>Approve</button>' +
        '<button type="button" class="btn-text danger jr-decline" data-id="' + esc(r.id) + '"' + off + '>Decline</button>' :
        r.status === 'approved' && w.status !== 'sent' ? '<button type="button" class="btn-text jr-resend" data-id="' + esc(r.id) + '"' + (busy[r.id] ? ' disabled' : '') + '>Send the welcome email</button>' : '') +
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

  function settingsHtml(){
    var inv = invite || {}, f = form || {};
    var group = function(title){ return '<fieldset class="md-group"><legend>' + title + '</legend>'; };
    return '<section class="profile-panel" id="settings">' +
      '<div class="event-form join-form jr-settings">' +
      group('Slack invite') + '<label>Link (in Slack: Invite people → Copy invite link; replace it when it expires)<input type="url" class="jr-invite" maxlength="300" value="' + esc(inv.slackInviteUrl || '') + '" placeholder="https://join.slack.com/t/…"></label>' +
      '<label>Expires on (PIs and admins hear 3 days before)<input type="date" class="jr-expires" value="' + esc(inv.slackInviteExpires || '') + '"></label>' +
      '</fieldset>' + group('Welcome email') + '<label>Subject<input type="text" class="jr-subject" maxlength="200" value="' + esc(inv.subject || SUBJECT) + '"></label>' +
      '<label>Text ({name}: their first name, {slackInvite}: the link above, {site}: BOLD.OS)<textarea class="jr-body no-tags" rows="14" maxlength="5000">' + esc(inv.body || BODY) + '</textarea></label>' +
      '</fieldset>' + group('Slack channels') + '<p class="proj-meta">Everyone in a group, and in the groups above it, is added to its channels (<a href="boldiquette.html#who-is-bold">Who is BOLD</a>). Several are separated by commas.</p>' +
        BoldJoin.CATEGORIES.filter(function(c){ return c[0] !== 'pan'; }).map(function(c){
          var err = (groups.channelErrors || {})[c[0]];
          return '<label>' + esc(c[1]) + '<input type="text" class="jr-chan" data-group="' + c[0] + '" maxlength="400" value="' + esc(((groups.channels || {})[c[0]]) || '') + '" placeholder="#channel, #another (none: nobody is added)"></label>' +
            (err ? '<p class="st-error">' + esc(err) + '</p>' : '');
        }).join('') + '</fieldset>' + group('Slack channels by role') + '<p class="proj-meta">Everyone with a role (on their details) is added to its channels. The roles are the join form’s, below.</p>' +
        (f.roles || BoldJoin.ROLES).map(function(r){
          var err = (groups.roleChannelErrors || {})[r];
          return '<label>' + esc(r) + '<input type="text" class="jr-rchan" data-role="' + esc(r) + '" maxlength="400" value="' + esc(((groups.roleChannels || {})[r]) || '') + '" placeholder="#channel, #another (none: nobody is added)"></label>' +
            (err ? '<p class="st-error">' + esc(err) + '</p>' : '');
        }).join('') + '</fieldset>' + group('Join form') +
      '<label>Roles, one per line<textarea class="jr-roles no-tags" rows="6">' + esc((f.roles || BoldJoin.ROLES).join('\n')) + '</textarea></label>' +
      '<label>Research pillars, one per line<textarea class="jr-pillars no-tags" rows="4">' + esc((f.pillars || BoldJoin.PILLARS).join('\n')) + '</textarea></label></fieldset>' +
      '<p class="ev-error" hidden></p><div class="event-form-actions"><button type="button" class="ev-save jr-save">Save settings</button></div></div>' +
      pilotHtml() + '</section>';
  }

  // ---------- Pilots ----------
  // testers: everyone's, for every pilot; pilotTesters: { feature: [emails] }, for that one too.
  function pilotNow(){
    if (pilotDraft) return pilotDraft;
    var p = pilot || {}, each = {};
    Object.keys(p.pilotTesters || {}).forEach(function(k){ each[k] = (p.pilotTesters[k] || []).slice(); });
    return { testers: (p.testers || []).slice(), pilotTesters: each, live: Object.assign({}, p.live || {}) };
  }
  // A list of testers with Remove beside each and a menu to add one: key '' the general ones.
  function testersHtml(list, key, none){
    return '<ul class="jr-testers">' + (list.length ? list.map(function(e, i){
        return '<li>' + esc(nameOf(e)) + ' <button type="button" class="btn-text danger jr-tester-remove" data-for="' + esc(key) + '" data-i="' + i + '">Remove</button></li>';
      }).join('') : '<li class="proj-meta">' + none + '</li>') + '</ul>' +
      '<select class="jr-tester-add" data-for="' + esc(key) + '" aria-label="Add a tester"><option value="">Add a tester…</option>' + roster.filter(function(p){ return list.indexOf(p.email) < 0; })
        .map(function(p){ return '<option value="' + esc(p.email) + '">' + esc(p.name) + '</option>'; }).join('') + '</select>';
  }
  function testersOf(d, key){ return key ? (d.pilotTesters[key] = d.pilotTesters[key] || []) : d.testers; }
  function nameOf(e){ var p = roster.filter(function(x){ return x.email === e; })[0]; return p ? p.name : e.split('@')[0]; }
  function pilotHtml(){
    if (!pilot) return '';
    var d = pilotNow(), known = pilot.known || {}, keys = Object.keys(known).sort();
    return '<div class="event-form join-form jr-pilot"><fieldset class="md-group"><legend>Pilots</legend>' +
      '<p class="proj-meta">A new Slack feature only messages its testers until it’s live: each message goes to them instead, saying whom it was for.</p>' +
      '<label>Testers of every pilot</label>' + testersHtml(d.testers, '', 'Nobody') +
      '<label>Features</label>' + (keys.length ? keys.map(function(k){
        return '<div class="jr-feature"><label class="jn-check"><input type="checkbox" class="jr-live" data-key="' + esc(k) + '"' + (d.live[k] ? ' checked' : '') + '> ' + esc(known[k]) + ' <span class="proj-meta">· ' + (d.live[k] ? 'live: messages everyone it’s for' : 'in pilot: testers only') + '</span></label>' +
          (d.live[k] ? '' : '<p class="proj-meta">Its own testers, besides those of every pilot:</p>' + testersHtml(d.pilotTesters[k] || [], k, 'None')) + '</div>';
      }).join('') : '<p class="proj-meta">None yet: a feature appears here once it’s deployed.</p>') +
      '</fieldset>' + (pilotError ? '<p class="ev-error">' + esc(pilotError) + '</p>' : '') +
      '<div class="event-form-actions"><button type="button" class="ev-save jr-pilot-save"' + (pilotDraft ? '' : ' disabled title="Nothing changed"') + '>Save pilots</button>' +
        (pilotDraft ? '<button type="button" class="jr-pilot-cancel">Cancel</button>' : '') + '</div></div>';
  }
  function savePilot(btn){
    var d = pilotNow(), was = (pilot || {}).live || {}, known = (pilot || {}).known || {};
    var goingLive = Object.keys(d.live).filter(function(k){ return d.live[k] && !was[k]; });
    // Going live reaches everyone each feature is for: asked every time (the ground rule).
    (goingLive.length ? BOLD.confirmAlways({ title: 'Make ' + (goingLive.length === 1 ? 'it' : 'them') + ' live?', go: 'Make live',
      effects: goingLive.map(function(k){ return 'Let ' + (known[k] || k) + ' message everyone it’s for on Slack, not just the testers'; }) }) : Promise.resolve(true)).then(function(ok){
      if (!ok) return;
      btn.disabled = true; pilotError = '';
      db.collection('settings').doc('pilot').set({ testers: d.testers, pilotTesters: d.pilotTesters, live: d.live, updatedAt: Date.now(), updatedBy: me.email }, { merge: true }).then(function(){
        pilotDraft = null; render();
      }).catch(function(err){ console.error('[BOLD Join] saving the pilots failed', err); pilotError = 'Couldn’t save — try again.'; render(); });
    });
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

  // A request that names you as inviting them: approve or decline it while it's open
  // (from before, one a PI or admin approved: confirm it, or say you didn't).
  function invitedHtml(r){
    var st = (r.invitedBy || {}).status, off = busy[r.id] ? ' disabled' : '';
    if (r.status === 'open') return '<li id="i-' + esc(r.id) + '">' + who(r.name, r.email, 'proj-title') +
      '<span class="proj-meta">' + esc(r.email) + ' · ' + esc([r.role, r.institution].filter(Boolean).join(', ')) + ' · asked ' + when(r.at) + '</span>' +
      '<p class="proj-meta">Asks to join BOLD, and says you invited them.</p>' +
      (shown['i:' + r.id] ? BoldJoin.factsHtml(r, { other: true }) : '') +
      '<div class="event-controls">' + moreBtn('i:' + r.id) + '<button type="button" class="btn-text jr-approve" data-id="' + esc(r.id) + '"' + off + '>Approve</button>' +
        '<button type="button" class="btn-text danger jr-decline" data-id="' + esc(r.id) + '"' + off + '>Decline</button></div></li>';
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
      '<p class="proj-meta">' + (st === 'confirmed' ? 'You confirmed you invited them.' : st === 'denied' ? 'You said you didn’t invite them.' : 'They name you as their point of contact, who invited them.') + '</p>' +
      '<div class="event-controls">' + (st !== 'confirmed' ? '<button type="button" class="btn-text jr-i-yes" data-mid="' + esc(m.email) + '"' + off + '>Yes, I invited them</button>' : '') +
        (st !== 'denied' ? '<button type="button" class="btn-text danger jr-i-no" data-mid="' + esc(m.email) + '"' + off + '>I didn’t</button>' : '') + '</div></li>';
  }
  // Without tabs (not a PI or admin), it keeps its heading.
  function invitedSection(tabbed){
    if (!invited.length && !invitedMembers.length) return '';
    return '<section class="' + (tabbed ? 'profile-panel' : 'block') + '" id="invited">' + (tabbed ? '' : '<div class="block-head"><h2>Invited by you<span class="proj-count">' + invitedWaiting() + ' waiting</span></h2></div>') +
      '<ul class="proj-list">' + invited.map(invitedHtml).join('') + invitedMembers.map(invitedMemberHtml).join('') + '</ul></section>';
  }

  // Requests naming you still open, and members still to confirm.
  function invitedWaiting(){
    return invited.filter(function(r){ return r.status === 'open' || (r.invitedBy || {}).status === 'pending'; }).length +
      invitedMembers.filter(function(m){ return (m.invitedBy || {}).status === 'pending'; }).length;
  }
  function render(){
    if (!me) return;
    if (staff === false) {
      // Someone you invited asking to change group: yours to decide.
      var mine = myGroupReqs.filter(function(r){ return r.status === 'open'; });
      var groupsMine = mine.length ? '<section class="block" id="groups"><div class="block-head"><h2>Changing group<span class="proj-count">' + mine.length + ' waiting</span></h2></div>' +
        '<ul class="proj-list">' + mine.map(groupReqHtml).join('') + '</ul></section>' : '';
      main.innerHTML = invitedSection() + groupsMine + (invited.length || invitedMembers.length || mine.length ? '' : '<p class="proj-msg">Nobody says you invited them.</p>');
      jump();
      return;
    }
    if (staff === null || requests === null) { main.innerHTML = '<p class="proj-msg">Loading&hellip;</p>'; return; }
    if (editing) return; // don't redraw over settings being changed
    var open = requests.filter(function(r){ return r.status === 'open'; });
    var done = requests.filter(function(r){ return r.status !== 'open'; });
    var gOpen = groupReqs.filter(function(r){ return r.status === 'open'; });
    var gDone = groupReqs.filter(function(r){ return r.status !== 'open'; });
    var aOpen = actReqs.filter(function(r){ return r.status === 'open'; });
    var aDone = actReqs.filter(function(r){ return r.status !== 'open'; });
    var list = function(items, html, none){ return items.length ? '<ul class="proj-list">' + items.map(html).join('') + '</ul>' : '<p class="proj-msg">' + none + '</p>'; };
    var waiting = invitedWaiting();
    var n = function(k){ return k ? ' (' + k + ')' : ''; };
    // Five tabs, named by the #hash: joining BOLD, invited by you, changing group, agents acting, settings.
    main.innerHTML =
      '<nav class="guide-tabs profile-tabs" id="jrTabs" aria-label="Requests">' +
        '<a class="guide-tab" href="#signup">Sign up' + n(open.length) + '</a>' +
        '<a class="guide-tab" href="#invited">Invited by you' + n(waiting) + '</a>' +
        '<a class="guide-tab" href="#groups">Groups' + n(gOpen.length) + '</a>' +
        '<a class="guide-tab" href="#agents">Agents' + n(aOpen.length) + '</a>' +
        '<a class="guide-tab" href="#settings">Settings</a></nav>' +
      inviteNotice() +
      '<section class="profile-panel" id="signup">' +
        list(open, requestHtml, 'No requests waiting.') +
        (done.length ? '<div class="proj-group"><h3>Decided</h3>' + list(done, requestHtml, '') + '</div>' : '') + '</section>' +
      (invitedSection(true) || '<section class="profile-panel" id="invited"><p class="proj-msg">Nobody says you invited them.</p></section>') +
      '<section class="profile-panel" id="groups">' +
        list(gOpen, groupReqHtml, 'No requests waiting.') +
        (gDone.length ? '<div class="proj-group"><h3>Decided</h3>' + list(gDone, groupReqHtml, '') + '</div>' : '') + '</section>' +
      '<section class="profile-panel" id="agents"><p class="hero-note">Requests to let an agent act for someone, in their name: join projects, ask for introductions and letters, comment, propose changes and more. <a href="agents.html#activity">What agents did</a>.</p>' +
        list(aOpen, actReqHtml, 'No requests waiting.') +
        (aDone.length ? '<div class="proj-group"><h3>Decided</h3>' + list(aDone, actReqHtml, '') + '</div>' : '') + '</section>' +
      settingsHtml();
    var s = main.querySelector('.jr-settings');
    s.addEventListener('input', function(){ editing = true; });
    if (!editing) { var drawn = readSettings(); settingsFrom = drawn.error ? null : drawn; }
    showTab();
    jump();
  }
  // The tab a #hash names: links to one request (#r=, #g=, #i=) open its tab.
  function tabOf(h){
    var m = /^#([rgi])=/.exec(h);
    if (m) return { r: 'signup', g: 'groups', i: 'invited' }[m[1]];
    return ['#signup', '#invited', '#groups', '#agents', '#settings'].indexOf(h) >= 0 ? h.slice(1) : '';
  }
  function showTab(){
    var tabs = document.getElementById('jrTabs');
    if (!tabs) return;
    var want = tabOf(location.hash) || 'signup';
    var note = document.getElementById('jrNotice');
    if (note) note.hidden = want !== 'signup' && want !== 'settings';
    ['signup', 'invited', 'groups', 'agents', 'settings'].forEach(function(t){ var x = document.getElementById(t); if (x) x.hidden = t !== want; });
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

  // What the settings form says, as saved: { invite, form, groups } (each a settings
  // document's fields), or { error }.
  function readSettings(){
    var s = main.querySelector('.jr-settings');
    var v = function(c){ return s.querySelector(c).value; };
    var url = v('.jr-invite').trim();
    if (url && !/^https:\/\/\S+$/.test(url)) return { error: 'The invite link starts with https://' };
    var roles = lines(v('.jr-roles')), pillars = lines(v('.jr-pillars'));
    if (!roles.length) return { error: 'Give at least one role.' };
    // One or more names each, kept as "a, b".
    var names = function(sel, attr){
      var m = {};
      Array.prototype.forEach.call(s.querySelectorAll(sel), function(i){
        var v = i.value.split(/[\s,]+/).map(function(n){ return n.replace(/^#/, '').toLowerCase(); }).filter(Boolean);
        if (v.length) m[i.getAttribute(attr)] = v.join(', ');
      });
      return m;
    };
    var channels = names('.jr-chan', 'data-group'), roleChannels = names('.jr-rchan', 'data-role');
    var badName = function(m){ return Object.keys(m).some(function(k){ return m[k].split(', ').some(function(n){ return !/^[a-z0-9_-]{1,80}$/.test(n); }); }); };
    if (badName(channels) || badName(roleChannels)) return { error: 'Slack channel names use letters, numbers, hyphens and underscores.' };
    return {
      invite: { slackInviteUrl: url, slackInviteExpires: v('.jr-expires'), subject: v('.jr-subject').trim() || SUBJECT, body: v('.jr-body') || BODY },
      form: { roles: roles, pillars: pillars },
      groups: { channels: channels, roleChannels: roleChannels }
    };
  }
  // What the form showed when it was drawn: saving writes only what was changed since.
  var settingsFrom = null;

  function saveSettings(btn){
    var err = main.querySelector('.jr-settings .ev-error');
    var mine = readSettings();
    if (mine.error) { err.textContent = mine.error; err.hidden = false; return; }
    var channels = mine.groups.channels, roleChannels = mine.groups.roleChannels;
    // Channels added to a group: everyone meant to be in them is invited (onGroupChannels).
    var had = (groups && groups.channels) || {};
    var added = [], newNames = [];
    Object.keys(channels).forEach(function(g){
      var before = String(had[g] || '').split(/[\s,]+/).map(function(n){ return n.replace(/^#/, '').toLowerCase(); });
      channels[g].split(', ').forEach(function(n){ if (before.indexOf(n) < 0) { added.push('Invite everyone in ' + BoldJoin.categoryLabel(g) + ' and the groups above it to #' + n + ' on Slack'); newNames.push(n); } });
    });
    var hadRoles = (groups && groups.roleChannels) || {};
    Object.keys(roleChannels).forEach(function(r){
      var before = String(hadRoles[r] || '').split(/[\s,]+/).map(function(n){ return n.replace(/^#/, '').toLowerCase(); });
      roleChannels[r].split(', ').forEach(function(n){ if (before.indexOf(n) < 0) { added.push('Invite everyone whose role is ' + r + ' to #' + n + ' on Slack'); newNames.push(n); } });
    });
    // A channel the bot can't see (a typo, or a private one it isn't in) isn't saved: nobody
    // would be added to it, and nobody would know (checkGroupChannels).
    btn.disabled = true; err.hidden = true;
    checkChannels(newNames).then(function(missing){
      btn.disabled = false;
      if (missing) { err.textContent = missing; err.hidden = false; return; }
      (added.length ? BOLD.confirmAlways({ title: 'Save the settings?', go: 'Save', effects: added }) : Promise.resolve(true)).then(function(ok){
        if (ok) writeSettings(btn, err, mine);
      });
    }).catch(function(e){
      btn.disabled = false;
      console.error('[BOLD Requests] checking the channels failed', e);
      err.textContent = 'Couldn’t check the channels on Slack — try again.'; err.hidden = false;
    });
  }
  // → Promise of '' (all there) or what's wrong with the names, in words.
  function checkChannels(names){
    names = names.filter(function(n, i){ return names.indexOf(n) === i; });
    if (!names.length) return Promise.resolve('');
    return firebase.app().functions('europe-west2').httpsCallable('checkGroupChannels')({ names: names }).then(function(r){
      var d = r.data || {};
      return (d.missing || []).map(function(m){
        return 'BOLD.OS can’t see #' + m.name + (m.suggest ? ' — did you mean #' + m.suggest + '?' : ': if it’s a private channel, invite ' + (d.bot || 'the BOLD OS app') + ' to it first.');
      }).join(' ');
    });
  }
  // Each settings document is written only if something in it was changed, and then
  // only the fields (and, in a map, the entries) that were: the rest is kept as saved
  // now, so two people saving different settings at once both keep theirs.
  var SETTINGS_DOCS = { invite: 'joinInvite', form: 'joinForm', groups: 'groups' };
  function writeSettings(btn, err, mine){
    var from = settingsFrom || mine;
    var same = function(a, b){ return JSON.stringify(a) === JSON.stringify(b); };
    var isMap = function(x){ return x && typeof x === 'object' && !Array.isArray(x); };
    var merge = function(base, mineV, theirs){
      if (same(mineV, base)) return theirs;
      if (isMap(mineV) && isMap(base) && isMap(theirs)){
        var o = {};
        Object.keys(Object.assign({}, base, mineV, theirs)).forEach(function(k){ var x = merge(base[k], mineV[k], theirs[k]); if (x !== undefined) o[k] = x; });
        return o;
      }
      return mineV;
    };
    var keys = Object.keys(SETTINGS_DOCS).filter(function(k){ return !same(mine[k], from[k]); });
    btn.disabled = true; err.hidden = true;
    db.runTransaction(function(tx){
      var refs = keys.map(function(k){ return db.collection('settings').doc(SETTINGS_DOCS[k]); });
      return Promise.all(refs.map(function(r){ return tx.get(r); })).then(function(snaps){
        snaps.forEach(function(snap, i){
          var k = keys[i], now = snap.exists ? snap.data() : {}, out = {};
          Object.keys(mine[k]).forEach(function(f){
            var x = merge(from[k][f], mine[k][f], now[f] === undefined ? from[k][f] : now[f]);
            if (x !== undefined) out[f] = x;
          });
          tx.set(refs[i], Object.assign(out, { updatedAt: Date.now(), updatedBy: me.email }));
        });
      });
    }).then(function(){
      editing = false; btn.disabled = false; btn.textContent = 'Saved'; setTimeout(function(){ btn.textContent = 'Save settings'; }, 1500);
      render();
    }).catch(function(e){
      console.error('[BOLD Join] saving the settings failed', e);
      err.textContent = 'Couldn’t save — try again.'; err.hidden = false; btn.disabled = false;
    });
  }

  main.addEventListener('change', function(e){
    var t = e.target;
    if (t.classList.contains('jr-tester-add') && t.value) { pilotDraft = pilotNow(); testersOf(pilotDraft, t.getAttribute('data-for')).push(t.value); render(); return; }
    if (t.classList.contains('jr-live')) { pilotDraft = pilotNow(); pilotDraft.live[t.getAttribute('data-key')] = t.checked; render(); }
  });
  main.addEventListener('click', function(e){
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.classList.contains('jr-save')) { saveSettings(t); return; }
    if (t.classList.contains('jr-pilot-save')) { savePilot(t); return; }
    if (t.classList.contains('jr-pilot-cancel')) { pilotDraft = null; pilotError = ''; render(); return; }
    if (t.classList.contains('jr-tester-remove')) { pilotDraft = pilotNow(); testersOf(pilotDraft, t.getAttribute('data-for')).splice(+t.getAttribute('data-i'), 1); render(); return; }
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
      roster = ps.docs.map(function(d){ return { email: String(d.data().email || '').toLowerCase(), name: d.data().name || '' }; })
        .filter(function(p){ return p.email && p.name; }).sort(function(a, b){ return a.name.localeCompare(b.name); });
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
      unsubs.push(db.collection('settings').doc('joinForm').onSnapshot(function(s){ form = s.exists ? s.data() : {}; render(); }, function(){}));
      unsubs.push(db.collection('groupRequests').orderBy('at', 'desc').limit(200).onSnapshot(function(snap){
        groupReqs = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); }); render();
      }, function(err){ console.error('[BOLD Join] loading group requests failed', err); }));
      unsubs.push(db.collection('settings').doc('groups').onSnapshot(function(s){ groups = s.exists ? s.data() : {}; render(); }, function(){}));
      unsubs.push(db.collection('settings').doc('pilot').onSnapshot(function(s){ pilot = s.exists ? s.data() : {}; render(); }, function(){ pilot = {}; }));
      loadActReqs();
    }).catch(function(err){ console.error('[BOLD Join] checking access failed', err); staff = false; render(); });
  });
})();
