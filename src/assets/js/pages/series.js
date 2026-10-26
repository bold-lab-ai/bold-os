(function(){
  // A recurring lab meeting (eventSeries/{id}; functions/series.js): series.html?series=<id>,
  // or series.html?new to add one. Read live from Firestore; every change goes through the
  // eventSeries callable, which keeps its Google Calendar event in line.
  // - Everyone who can view Events: when it is, who's invited, its organisers; Join or
  //   Leave one that's opt-in; its Meet link once invited.
  // - Its organisers, PIs and admins: Edit, Pause or Resume, Delete.
  // - PIs and admins: Release (the invitations go out) and Hide.
  // A new one starts hidden, until a PI or admin releases it.
  var esc = BOLD.escapeHtml;
  var body = document.getElementById('seriesBody');
  if (!body || !BOLD.getAuth()) return;
  var db = null;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var params = new URLSearchParams(location.search);
  var id = params.get('series') || '', isNew = params.has('new');
  var s = null, loaded = false, me = null, full = false, editing = null, busy = false, msg = '', roster = null, names = {};
  var BACK = '<a class="back-link" href="events.html">&larr; All events</a>';
  var INVITE = [['join', 'Whoever joins'], ['group:everyone', 'Everyone in BOLD'], ['group:associate', 'BOLD-associate and above'],
    ['group:internal', 'BOLD-internal and above'], ['group:staff', 'BOLD-staff and above'], ['group:exec', 'BOLD-exec']];

  function call(data){ return firebase.app().functions('europe-west2').httpsCallable('eventSeries')(data); }
  function inviteKey(inv){ return inv && inv.mode === 'group' ? 'group:' + inv.group : 'join'; }
  function inviteText(inv){ return (INVITE.filter(function(o){ return o[0] === inviteKey(inv); })[0] || INVITE[0])[1]; }
  function nameOf(e){ return names[e] || String(e).split('@')[0]; }
  function isOrganiser(){ return !!(s && me && (s.organisers || []).indexOf(me.email.toLowerCase()) >= 0); }
  function canChange(){ return full || isOrganiser(); }
  function invited(){ return !!(s && me && (s.guests || []).indexOf(me.email.toLowerCase()) >= 0); }
  function paragraphs(t){
    return String(t || '').split(/\n\s*\n/).map(function(p){ return p.trim(); }).filter(Boolean)
      .map(function(p){ return '<p class="hero-note">' + esc(p).replace(/\n/g, '<br>') + '</p>'; }).join('');
  }

  function render(){
    if (editing) { body.innerHTML = BACK + formHtml(); return; }
    if (isNew) { body.innerHTML = BACK + '<h1>New recurring meeting</h1><p class="hero-note">' + esc(msg || 'Loading…') + '</p>'; return; }
    if (!loaded) return;
    if (!s) {
      document.title = 'Meeting not found | BOLD Lab';
      body.innerHTML = BACK + '<h1>Meeting not found</h1><p class="hero-note">It may have been deleted, or not be released yet.</p>';
      return;
    }
    document.title = s.title + ' | BOLD Lab';
    var off = function(ok, why){ return ok && !busy ? '' : ' disabled title="' + esc(ok ? '' : why) + '"'; };
    var NOT_ORG = 'Only its organisers, PIs and admins can do this';
    var who = s.invite && s.invite.mode === 'group' ? inviteText(s.invite) + ' (invited)'
      : 'Whoever joins' + ((s.joined || []).length ? ' · ' + s.joined.length + ' so far' : '');
    var join = '';
    if (!s.hidden && s.invite && s.invite.mode === 'join') {
      var joined = me && (s.joined || []).indexOf(me.email.toLowerCase()) >= 0;
      join = '<div class="sr-join"><button type="button" class="join-btn sr-act" data-action="' + (joined ? 'leave' : 'join') + '"' + (busy ? ' disabled' : '') + '>' + (joined ? 'Leave' : 'Join') + '</button>' +
        (joined ? 'Google Calendar has sent you the invitation.' : 'Join to get the Google Calendar invitation.') + '</div>';
    }
    var link = invited() && s.meetUrl ? '<a href="' + esc(s.meetUrl) + '" target="_blank" rel="noopener">' + (s.meeting.link ? 'Own link' : 'Google Meet') + '</a>' : '';
    body.innerHTML = BACK +
      (s.hidden ? '<p class="event-hidden-note">Hidden — only PIs, admins and its organisers see it, and nobody is invited, until a PI or admin releases it.</p>' : '') +
      '<div><span class="eyebrow">Recurring meeting' + (s.pausedAt ? ' · paused' : '') + '</span></div>' +
      '<h1>' + esc(s.title) + '</h1>' +
      '<p class="hero-when">' + esc(meetingText(s.meeting)) + ' · London time' + (link ? ' · ' + link : '') + '</p>' +
      paragraphs(s.description) +
      '<dl class="sr-facts">' +
        '<div class="fact"><dt>Invited</dt><dd>' + esc(who) + '</dd></div>' +
        '<div class="fact"><dt>Organisers</dt><dd>' + (s.organisers || []).map(function(e){ return esc(nameOf(e)); }).join(', ') + '</dd></div>' +
      '</dl>' +
      (s.error ? '<span class="sr-error">' + esc(s.error) + (canChange() ? ' <button type="button" class="btn-text sr-act" data-action="retry"' + off(true) + '>Try again</button>' : '') + '</span>' : '') +
      join +
      (msg ? '<p class="hero-note" role="status">' + esc(msg) + '</p>' : '') +
      '<div class="event-controls">' +
        '<button type="button" class="btn-text sr-edit"' + off(canChange(), NOT_ORG) + '>Edit</button>' +
        '<button type="button" class="btn-text sr-act" data-action="' + (s.pausedAt ? 'resume' : 'pause') + '"' + off(canChange() && !s.hidden, s.hidden ? 'Not released yet' : NOT_ORG) + '>' + (s.pausedAt ? 'Resume' : 'Pause') + '</button>' +
        '<button type="button" class="btn-text sr-act" data-action="' + (s.hidden ? 'release' : 'hide') + '"' + off(full, 'Only PIs and admins release and hide recurring meetings') + '>' + (s.hidden ? 'Release' : 'Hide') + '</button>' +
        '<button type="button" class="btn-text danger sr-act" data-action="delete"' + off(canChange(), NOT_ORG) + '>Delete</button>' +
      '</div>';
  }

  function formHtml(){
    var e = editing;
    var opts = (roster || []).filter(function(p){ return e.organisers.indexOf(p.email) < 0; })
      .map(function(p){ return '<option value="' + esc(p.email) + '">' + esc(p.name) + '</option>'; }).join('');
    var lockInvite = !!(s && !s.hidden && !full);
    return '<h1>' + (s ? 'Edit ' + esc(s.title) : 'New recurring meeting') + '</h1>' +
      '<div class="event-form sr-form">' +
        '<label>Title<input type="text" class="sr-title" maxlength="120" value="' + esc(e.title) + '" placeholder="Hamming Sessions"></label>' +
        '<label>What it’s for<textarea class="sr-desc" rows="5" maxlength="5000">' + esc(e.description) + '</textarea></label>' +
        '<label>When (London time)</label>' + meetingEntryHtml(e.meeting) +
        '<label>Who’s invited<select class="sr-invite"' + (lockInvite ? ' disabled title="Once it’s released, only PIs and admins change this"' : '') + '>' +
          INVITE.map(function(o){ return '<option value="' + o[0] + '"' + (o[0] === e.invite ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
        '<label>Organisers: they change it, and are always invited</label>' +
        '<ul class="sr-orgs">' + e.organisers.map(function(m, i){
          return '<li><span>' + esc(nameOf(m)) + '</span>' + (e.organisers.length > 1 ? '<button type="button" class="btn-text danger sr-org-remove" data-i="' + i + '">Remove</button>' : '') + '</li>';
        }).join('') + '</ul>' +
        '<select class="sr-pick" aria-label="Add an organiser"><option value="">' + (roster ? 'Add an organiser…' : 'Loading…') + '</option>' + opts + '</select>' +
        (s ? '' : '<p class="event-form-hint">It stays hidden, and nobody is invited, until a PI or admin releases it.</p>') +
        '<p class="ev-error"' + (e.error ? '' : ' hidden') + '>' + esc(e.error || '') + '</p>' +
        '<div class="event-form-actions"><button type="button" class="ev-save sr-save"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Saving…' : s ? 'Save' : 'Add') + '</button>' +
          '<button type="button" class="sr-cancel"' + (busy ? ' disabled' : '') + '>Cancel</button></div>' +
      '</div>';
  }

  // What the form says now, kept across redraws.
  function keep(){
    if (!editing) return;
    var q = function(c){ return body.querySelector(c); };
    if (q('.sr-title')) editing.title = q('.sr-title').value;
    if (q('.sr-desc')) editing.description = q('.sr-desc').value;
    if (q('.sr-invite')) editing.invite = q('.sr-invite').value;
    if (document.getElementById('pmDay')) {
      editing.meeting = { day: document.getElementById('pmDay').value, time: document.getElementById('pmTime').value,
        minutes: Number(document.getElementById('pmMinutes').value), every: Number(document.getElementById('pmEvery').value),
        until: document.getElementById('pmUntil').value, link: document.getElementById('pmLink').value.trim() };
    }
  }

  function startEditing(){
    editing = s ? { title: s.title, description: s.description || '', meeting: s.meeting, invite: inviteKey(s.invite), organisers: (s.organisers || []).slice(), error: '' }
      : { title: '', description: '', meeting: null, invite: 'join', organisers: [me.email.toLowerCase()], error: '' };
    loadRoster(); render();
  }

  function loadRoster(){
    if (roster) return;
    db.collection('people').get().then(function(snap){
      roster = snap.docs.map(function(d){ var x = d.data(); return { name: x.name || x.email, email: String(x.email || '').toLowerCase() }; })
        .filter(function(p){ return p.email; }).sort(function(a, b){ return a.name.localeCompare(b.name); });
      roster.forEach(function(p){ names[p.email] = p.name; });
      keep(); render();
    }).catch(function(){ roster = []; keep(); render(); });
  }

  function save(){
    keep();
    var e = editing;
    var meeting = readMeetingEntry();
    if (!e.title.trim()) { e.error = 'Give it a title.'; render(); return; }
    if (meeting.error) { e.error = meeting.error; render(); return; }
    var inv = e.invite.indexOf('group:') === 0 ? { mode: 'group', group: e.invite.slice(6) } : { mode: 'join' };
    var send = function(){
      busy = true; e.error = ''; render();
      call({ action: 'save', id: s ? s.id : undefined, title: e.title.trim(), description: e.description.trim(), meeting: meeting, invite: inv, organisers: e.organisers }).then(function(r){
        busy = false; editing = null;
        var out = r.data && r.data.series;
        if (!s && out) { location.replace('series.html?series=' + encodeURIComponent(out.id)); return; }
        msg = 'Saved.'; render();
      }).catch(function(err){
        busy = false; e.error = (err && err.message) || 'Couldn’t save — try again.'; render();
      });
    };
    if (!s || s.hidden) { send(); return; }
    BOLD.confirmAction({ title: 'Save the meeting?', go: 'Save', effects: ['Change it on Google Calendar: Google emails everyone invited the change'] })
      .then(function(ok){ if (ok) send(); });
  }

  var EFFECTS = {
    release: function(){ return ['Make it on Google Calendar and invite ' + (s.invite.mode === 'group' ? inviteText(s.invite) : 'its organisers, and whoever joins') + ': Google emails them the invitation', 'Show it to the lab on Events and the Calendar']; },
    hide: function(){ return ['Cancel it on Google Calendar: Google emails everyone invited the cancellation', 'Hide it from the lab']; },
    pause: function(){ return ['Take its upcoming dates off everyone’s Google Calendar until it’s resumed (the invitation and link stay)']; },
    resume: function(){ return ['Put its upcoming dates back on everyone’s Google Calendar']; },
    join: function(){ return ['Google Calendar sends you the invitation']; },
    leave: function(){ return ['Take you off its Google Calendar invitation']; },
    'delete': function(){ return ['Delete it for good' + (s.hidden ? '' : ', and cancel it on Google Calendar: Google emails everyone invited the cancellation')]; },
  };
  var TITLES = { release: 'Release it?', hide: 'Hide it?', pause: 'Pause it?', resume: 'Resume it?', join: 'Join it?', leave: 'Leave it?', 'delete': 'Delete it?' };
  function act(action){
    var go = function(){
      busy = true; msg = ''; render();
      call({ action: action, id: s.id }).then(function(){
        busy = false;
        if (action === 'delete') { location.href = 'events.html'; return; }
        render();
      }).catch(function(err){ busy = false; msg = (err && err.message) || 'Couldn’t do that — try again.'; render(); });
    };
    if (action === 'retry') { go(); return; }
    BOLD.confirmAction({ title: TITLES[action], go: action === 'delete' ? 'Delete' : 'Go ahead', effects: EFFECTS[action]() })
      .then(function(ok){ if (ok) go(); });
  }

  body.addEventListener('click', function(ev){
    var t = ev.target.closest('button');
    if (!t || t.disabled) return;
    if (t.classList.contains('sr-edit')) { msg = ''; startEditing(); return; }
    if (t.classList.contains('sr-act')) { act(t.getAttribute('data-action')); return; }
    if (t.classList.contains('sr-save')) { save(); return; }
    if (t.classList.contains('sr-cancel')) { if (!s) { location.href = 'events.html'; return; } editing = null; render(); return; }
    if (t.classList.contains('sr-org-remove')) { keep(); editing.organisers.splice(+t.getAttribute('data-i'), 1); render(); }
  });
  body.addEventListener('change', function(ev){
    if (!editing || !ev.target.classList.contains('sr-pick') || !ev.target.value) return;
    keep(); editing.organisers.push(ev.target.value); render();
  });

  var unsubscribe = null;
  BOLD.onUser(function(user){
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    me = user ? { email: user.email || '' } : null;
    if (!user) return;
    firebase.app().functions('europe-west2').httpsCallable('getMyAccess')().then(function(r){ full = !!(r.data && r.data.fullWrite); render(); }).catch(function(){});
    loadRoster();
    if (isNew) {
      BOLD.onAccess(function(){
        if (editing || !isNew) return;
        if (BOLD.can('events', 'edit')) { isNew = false; startEditing(); }
        else { msg = BOLD.cannotReason('events', 'edit'); render(); }
      });
      return;
    }
    if (!id) { loaded = true; render(); return; }
    unsubscribe = db.collection('eventSeries').doc(id).onSnapshot(function(doc){
      s = doc.exists ? doc.data() : null;
      loaded = true;
      if (!editing) render();
    }, function(err){
      console.error('[BOLD Series] loading the meeting failed', err);
      loaded = true; s = null; render();
    });
  });
})();
