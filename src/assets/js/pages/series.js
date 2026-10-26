(function(){
  // A recurring event (eventSeries/{id}; functions/series.js): series.html?series=<id>,
  // or series.html?new to add any event: Once makes a plain event (events/{slug}, hidden until
  // released, as from any event's page); anything more often, a recurring one. It may have a recurring Google Calendar invite, at a
  // set day and time every 1–4 weeks, with its invitations (kind 'meeting'); without one,
  // each time (edition) is scheduled with its own dates (kind 'editions'). Read live from Firestore; every change goes through the
  // eventSeries callable, which keeps its Google Calendar event in line.
  // - Everyone who can view Events: when it is, who's invited, its organisers; Join or
  //   Leave one that's opt-in; its Meet link once invited.
  // - Its organisers, PIs and admins: Edit, Pause or Resume, Delete.
  // - PIs and admins: Release (the invitations go out) and Hide.
  // A new one starts hidden, until a PI or admin releases it.
  // A recurring event (kind 'editions': the Festival, Collaboration Week) instead lists its
  // editions (events with its `series`), says when the next is due, and its organisers
  // Schedule the next edition (eventSeries 'nextEdition': a hidden event, released as any).
  var esc = BOLD.escapeHtml;
  var body = document.getElementById('seriesBody');
  if (!body || !BOLD.getAuth()) return;
  var db = null;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var params = new URLSearchParams(location.search);
  var id = params.get('series') || '', isNew = params.has('new');
  var s = null, loaded = false, me = null, full = false, editing = null, busy = false, msg = '', roster = null, names = {};
  var editions = null, editionsUnsub = null, planning = null;   // planning: { start, end, error } for the next edition
  var E = window.BoldEvents;
  var OFTEN = [['w1', 'Every week'], ['w2', 'Every 2 weeks'], ['w3', 'Every 3 weeks'], ['w4', 'Every 4 weeks'],
    ['m1', 'Every month'], ['m2', 'Every 2 months'], ['m3', 'Every 3 months'], ['m4', 'Every 4 months'], ['m6', 'Every 6 months'], ['m12', 'Every year']];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function isEditions(x){ return !!x && x.kind === 'editions'; }
  function oftenKey(c){ return (c && c.unit === 'week' ? 'w' : 'm') + ((c && c.every) || 1); }
  function cadenceText(c){ var o = OFTEN.filter(function(x){ return x[0] === oftenKey(c); })[0]; return o ? o[1] : 'Every ' + c.every + ' ' + c.unit + 's'; }
  function addPeriod(iso, c){ return c.unit === 'week' ? addDays(iso, 7 * c.every) : addMonths(iso, c.every); }
  function addMonths(iso, n){
    var p = iso.split('-').map(Number), t = new Date(Date.UTC(p[0], p[1] - 1 + n, 1));
    var last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(Math.min(p[2], last));
    return t.toISOString().slice(0, 10);
  }
  function addDays(iso, n){ var t = new Date(iso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
  function daysBetween(a, b){ return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }
  // When the next edition is due (the last one's start plus the cadence), or '' if one is coming.
  function nextDue(){
    if (!editions || !editions.length || !s.cadence) return '';
    var today = new Date().toISOString().slice(0, 10);
    if (editions.some(function(e){ return (e.endDate || e.startDate) >= today; })) return '';
    return addPeriod(editions[editions.length - 1].startDate, s.cadence);
  }
  // On its series' own page (`page`, the Festival's…) if it has one.
  function editionUrl(e){ return s && s.page ? s.page + '?edition=' + encodeURIComponent(e.slug) : 'event.html?event=' + encodeURIComponent(e.slug); }
  var BACK = '<a class="back-link" href="events.html">&larr; All events</a>';
  var INVITE = [['group:exec', 'BOLD-exec'], ['group:staff', 'BOLD-staff and above'], ['group:internal', 'BOLD-internal and above'],
    ['group:associate', 'BOLD-associate and above'], ['group:everyone', 'Everyone in BOLD'], ['join', 'Whoever joins']];

  function call(data){ return firebase.app().functions('europe-west2').httpsCallable('eventSeries')(data); }
  function inviteKey(inv){ return inv && inv.mode === 'group' ? 'group:' + inv.group : 'join'; }
  function inviteText(inv){ return (INVITE.filter(function(o){ return o[0] === inviteKey(inv); })[0] || INVITE[INVITE.length - 1])[1]; }
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
    if (isNew) { body.innerHTML = BACK + '<h1>New event series</h1><p class="hero-note">' + esc(msg || 'Loading…') + '</p>'; return; }
    if (!loaded) return;
    if (!s) {
      document.title = 'Event series not found | BOLD Lab';
      body.innerHTML = BACK + '<h1>Event series not found</h1><p class="hero-note">It may have been deleted, or not be released yet.</p>';
      return;
    }
    document.title = s.title + ' | BOLD Lab';
    var off = function(ok, why){ return ok && !busy ? '' : ' disabled title="' + esc(ok ? '' : why) + '"'; };
    var NOT_ORG = 'Only its organisers, PIs and admins can do this';
    if (isEditions(s)) { body.innerHTML = BACK + editionsHtml(off, NOT_ORG); return; }
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
      '<div><span class="eyebrow">Recurring event' + (s.pausedAt ? ' · paused' : '') + '</span></div>' +
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
        '<button type="button" class="btn-text sr-act" data-action="' + (s.hidden ? 'release' : 'hide') + '"' + off(full, 'Only PIs and admins release and hide recurring events') + '>' + (s.hidden ? 'Release' : 'Hide') + '</button>' +
        '<button type="button" class="btn-text danger sr-act" data-action="delete"' + off(canChange(), NOT_ORG) + '>Delete</button>' +
      '</div>';
  }

  function editionsHtml(off, NOT_ORG){
    var today = new Date().toISOString().slice(0, 10);
    var row = function(e){
      return '<li><a class="proj-title" href="' + esc(editionUrl(e)) + '">' + esc(E.when(e.startDate, e.endDate)) + '</a>' +
        (e.place ? ' <span class="sr-muted">· ' + esc(e.place) + '</span>' : '') + (e.hidden ? ' <span class="sr-hidden">Hidden</span>' : '') + '</li>';
    };
    var coming = (editions || []).filter(function(e){ return (e.endDate || e.startDate) >= today; });
    var past = (editions || []).filter(function(e){ return (e.endDate || e.startDate) < today; }).reverse();
    var due = nextDue(), dueText = due ? MONTHS[+due.slice(5, 7) - 1] + ' ' + due.slice(0, 4) : '';
    var plan = '';
    if (planning) {
      plan = '<div class="event-form sr-plan"><p class="event-form-head">The next edition</p>' +
        '<div class="ev-row"><label>Starts<input type="date" class="sr-start" value="' + esc(planning.start) + '"></label>' +
        '<label>Ends<input type="date" class="sr-end" value="' + esc(planning.end) + '"></label></div>' +
        '<p class="event-form-hint">It starts hidden, with the place and description of the last one; you build its programme on its page, and a PI or admin releases it.</p>' +
        '<p class="ev-error"' + (planning.error ? '' : ' hidden') + '>' + esc(planning.error || '') + '</p>' +
        '<div class="event-form-actions"><button type="button" class="ev-save sr-plan-go"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Scheduling…' : 'Schedule it') + '</button>' +
        '<button type="button" class="sr-plan-cancel">Cancel</button></div></div>';
    }
    return (s.hidden ? '<p class="event-hidden-note">Hidden — only PIs, admins and its organisers see it, until a PI or admin releases it.</p>' : '') +
      '<div><span class="eyebrow">Recurring event</span></div>' +
      '<h1>' + esc(s.title) + '</h1>' +
      '<p class="hero-when">' + esc(cadenceText(s.cadence)) + (s.proposals ? ' · takes proposals' : '') +
        (s.page ? ' · <a href="' + esc(s.page) + '">its page</a>' : '') + '</p>' +
      paragraphs(s.description) +
      '<dl class="sr-facts"><div class="fact"><dt>Organisers</dt><dd>' + (s.organisers || []).map(function(e){ return esc(nameOf(e)); }).join(', ') + '</dd></div></dl>' +
      '<h2 class="sr-head">Coming up</h2>' +
      (editions === null ? '<p class="sr-muted">Loading…</p>' : coming.length ? '<ul class="sr-editions">' + coming.map(row).join('') + '</ul>'
        : '<p class="sr-muted">' + (due ? 'The next one is due around ' + esc(dueText) + ', and isn’t scheduled yet.' : 'Nothing scheduled yet.') + '</p>') +
      (planning ? plan : '<button type="button" class="btn-text sr-plan-open"' + off(canChange(), NOT_ORG) + '>+ Schedule the next edition</button>') +
      (past.length ? '<h2 class="sr-head">Past</h2><ul class="sr-editions">' + past.map(row).join('') + '</ul>' : '') +
      (msg ? '<p class="hero-note" role="status">' + esc(msg) + '</p>' : '') +
      '<div class="event-controls">' +
        '<button type="button" class="btn-text sr-edit"' + off(canChange(), NOT_ORG) + '>Edit</button>' +
        '<button type="button" class="btn-text sr-act" data-action="' + (s.hidden ? 'release' : 'hide') + '"' + off(full, 'Only PIs and admins release and hide recurring events') + '>' + (s.hidden ? 'Release' : 'Hide') + '</button>' +
        '<button type="button" class="btn-text danger sr-act" data-action="delete"' + off(canChange(), NOT_ORG) + '>Delete</button>' +
      '</div>';
  }
  function openPlanning(){
    var last = editions && editions[editions.length - 1];
    var start = nextDue() || (last ? addPeriod(last.startDate, s.cadence) : new Date().toISOString().slice(0, 10));
    var length = last ? daysBetween(last.startDate, last.endDate || last.startDate) : 0;
    planning = { start: start, end: addDays(start, length), error: '' };
    render();
  }
  function schedule(){
    planning.start = body.querySelector('.sr-start').value; planning.end = body.querySelector('.sr-end').value || planning.start;
    if (!planning.start || planning.end < planning.start) { planning.error = 'Give its first and last day, the last on or after the first.'; render(); return; }
    busy = true; planning.error = ''; render();
    call({ action: 'nextEdition', id: s.id, startDate: planning.start, endDate: planning.end }).then(function(r){
      location.href = 'event.html?event=' + encodeURIComponent(r.data.slug);
    }).catch(function(err){ busy = false; planning.error = (err && err.message) || 'Couldn’t schedule it — try again.'; render(); });
  }

  // The end of the form when it's a one-off event: no invite, proposals or organisers.
  function onceEnd(){
    return '<p class="ev-error"' + (editing.error ? '' : ' hidden') + '>' + esc(editing.error || '') + '</p>' +
      '<div class="event-form-actions"><button type="button" class="ev-save sr-save"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Adding…' : 'Add') + '</button>' +
        '<button type="button" class="sr-cancel"' + (busy ? ' disabled' : '') + '>Cancel</button></div></div>';
  }
  function formHtml(){
    var e = editing;
    var opts = (roster || []).filter(function(p){ return e.organisers.indexOf(p.email) < 0; })
      .map(function(p){ return '<option value="' + esc(p.email) + '">' + esc(p.name) + '</option>'; }).join('');
    // Once released, only PIs and admins change who Google invites: adding or removing the invite too.
    var lockInvite = !!(s && !s.hidden && !full), once = e.often === 'once', weekly = e.often.charAt(0) === 'w', invite = weekly && e.hasInvite, ed = !invite;
    var oftens = s ? OFTEN : [['once', 'Once']].concat(OFTEN);   // a recurring one stays recurring
    var head = '<h1>' + (s ? 'Edit ' + esc(s.title) : 'New event series') + '</h1>' +
      '<div class="event-form sr-form">' +
        '<label>Title<input type="text" class="sr-title" maxlength="120" value="' + esc(e.title) + '" placeholder="' + (once ? 'Festival' : 'Hamming Sessions') + '"></label>' +
        '<label>What it’s for<textarea class="sr-desc" rows="5" maxlength="5000">' + esc(e.description) + '</textarea></label>' +
        '<label>How often<select class="sr-often">' + oftens.map(function(o){ return '<option value="' + o[0] + '"' + (o[0] === e.often ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>';
    if (once) return head +
      '<div class="ev-row"><label>Starts<input type="date" class="sr-start1" value="' + esc(e.start || '') + '"></label>' +
      '<label>Ends<input type="date" class="sr-end1" value="' + esc(e.end || '') + '"></label></div>' +
      '<label>Place<input type="text" class="sr-place" maxlength="200" value="' + esc(e.place || '') + '"></label>' +
      '<p class="event-form-hint">' + (full ? 'It stays hidden — only PIs and admins see it — until you release it from its page.'
        : 'It stays hidden — only you, PIs and admins see it — until a PI or admin releases it.') + '</p>' + onceEnd();
    return head +
        '<label class="sr-check"' + (weekly && !lockInvite ? '' : ' title="' + (lockInvite ? 'Once it’s released, only PIs and admins change who is invited' : 'A recurring invite needs a set day every 1–4 weeks') + '"') + '>' +
          '<input type="checkbox" class="sr-has-invite"' + (invite ? ' checked' : '') + (weekly && !lockInvite ? '' : ' disabled') + '> A recurring Google Calendar invite, at a set day and time</label>' +
        (ed ? '<p class="event-form-hint">Each time is scheduled on its own, with its dates, place and programme.</p>' +
            '<label class="sr-check"><input type="checkbox" class="sr-proposals"' + (e.proposals ? ' checked' : '') + '> It takes proposals (workshops, pitches, talks)</label>'
          : '<label>When (London time)</label>' + meetingEntryHtml(e.meeting) +
            '<label>Who’s invited<select class="sr-invite"' + (lockInvite ? ' disabled title="Once it’s released, only PIs and admins change this"' : '') + '>' +
              INVITE.map(function(o){ return '<option value="' + o[0] + '"' + (o[0] === e.invite ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>') +
        '<label>Organisers: they change it, and are always invited</label>' +
        '<ul class="sr-orgs">' + e.organisers.map(function(m, i){
          return '<li><span>' + esc(nameOf(m)) + '</span>' + (e.organisers.length > 1 ? '<button type="button" class="btn-text danger sr-org-remove" data-i="' + i + '">Remove</button>' : '') + '</li>';
        }).join('') + '</ul>' +
        '<select class="sr-pick" aria-label="Add an organiser"><option value="">' + (roster ? 'Add an organiser…' : 'Loading…') + '</option>' + opts + '</select>' +
        (s ? '' : '<p class="event-form-hint">' + (ed ? 'It stays hidden until a PI or admin releases it; then you schedule its editions.' : 'It stays hidden, and nobody is invited, until a PI or admin releases it.') + '</p>') +
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
    if (q('.sr-often')) editing.often = q('.sr-often').value;
    if (q('.sr-has-invite') && !q('.sr-has-invite').disabled) editing.hasInvite = q('.sr-has-invite').checked;
    if (q('.sr-proposals')) editing.proposals = q('.sr-proposals').checked;
    if (q('.sr-start1')) { editing.start = q('.sr-start1').value; editing.end = q('.sr-end1').value; editing.place = q('.sr-place').value; }
    if (document.getElementById('pmDay')) {
      editing.meeting = { day: document.getElementById('pmDay').value, time: document.getElementById('pmTime').value,
        minutes: Number(document.getElementById('pmMinutes').value), every: Number(document.getElementById('pmEvery').value),
        until: document.getElementById('pmUntil').value, link: document.getElementById('pmLink').value.trim() };
    }
  }

  function startEditing(){
    editing = s ? { often: isEditions(s) ? oftenKey(s.cadence) : 'w' + ((s.meeting || {}).every || 1), hasInvite: !isEditions(s), title: s.title, description: s.description || '',
        meeting: s.meeting, invite: inviteKey(s.invite), proposals: !!s.proposals, organisers: (s.organisers || []).slice(), error: '' }
      : { often: 'once', start: '', end: '', place: '', hasInvite: false, title: '', description: '', meeting: null, invite: 'join', proposals: false, organisers: [me.email.toLowerCase()], error: '' };
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
    if (e.often === 'once') { saveOnce(e); return; }
    var weekly = e.often.charAt(0) === 'w', ed = !(weekly && e.hasInvite), every = Number(e.often.slice(1));
    var meeting = ed ? null : readMeetingEntry();
    if (meeting && !meeting.error) meeting.every = every;
    if (!e.title.trim()) { e.error = 'Give it a title.'; render(); return; }
    if (meeting && meeting.error) { e.error = meeting.error; render(); return; }
    var inv = e.invite.indexOf('group:') === 0 ? { mode: 'group', group: e.invite.slice(6) } : { mode: 'join' };
    var payload = { action: 'save', id: s ? s.id : undefined, kind: ed ? 'editions' : 'meeting', title: e.title.trim(), description: e.description.trim(), organisers: e.organisers };
    if (ed) { payload.cadence = { every: every, unit: weekly ? 'week' : 'month' }; payload.proposals = e.proposals; } else { payload.meeting = meeting; payload.invite = inv; }
    var send = function(){
      busy = true; e.error = ''; render();
      call(payload).then(function(r){
        busy = false; editing = null;
        var out = r.data && r.data.series;
        if (!s && out) { location.replace('series.html?series=' + encodeURIComponent(out.id)); return; }
        msg = 'Saved.'; render();
      }).catch(function(err){
        busy = false; e.error = (err && err.message) || 'Couldn’t save — try again.'; render();
      });
    };
    if (!s || s.hidden || (ed && isEditions(s))) { send(); return; }
    BOLD.confirmAction({ title: 'Save it?', go: 'Save', effects: [ed ? 'Cancel its Google Calendar invite: Google emails everyone invited the cancellation'
      : isEditions(s) ? 'Make its Google Calendar invite: Google emails everyone invited' : 'Change it on Google Calendar: Google emails everyone invited the change'] })
      .then(function(ok){ if (ok) send(); });
  }

  // A one-off event: events/{slug}, as the events page made them (hidden; firestore.rules).
  function saveOnce(e){
    var title = e.title.trim(), end = e.end || e.start;
    if (!title) { e.error = 'Give it a title.'; render(); return; }
    if (!e.start) { e.error = 'Set when it starts.'; render(); return; }
    if (end < e.start) { e.error = 'It has to end on or after the day it starts.'; render(); return; }
    var stem = title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'event';
    var slug = stem + '-' + Math.random().toString(16).slice(2, 8), now = Date.now();
    busy = true; e.error = ''; render();
    db.collection('events').doc(slug).set({ slug: slug, hidden: true, title: title, startDate: e.start, endDate: end, place: e.place.trim(),
      description: e.description.trim(), createdAt: now, createdBy: me.email, updatedAt: now, updatedBy: me.email }).then(function(){
      location.replace('event.html?event=' + encodeURIComponent(slug));
    }).catch(function(err){
      console.error('[BOLD Series] adding an event failed', err);
      busy = false; e.error = 'Couldn’t add the event — try again.'; render();
    });
  }

  var EFFECTS = {
    release: function(){ return isEditions(s) ? ['Show it to the lab on Events'] : ['Make it on Google Calendar and invite ' + (s.invite.mode === 'group' ? inviteText(s.invite) : 'its organisers, and whoever joins') + ': Google emails them the invitation', 'Show it to the lab on Events and the Calendar']; },
    hide: function(){ return isEditions(s) ? ['Hide it from the lab (its editions stay as they are)'] : ['Cancel it on Google Calendar: Google emails everyone invited the cancellation', 'Hide it from the lab']; },
    pause: function(){ return ['Take its upcoming dates off everyone’s Google Calendar until it’s resumed (the invitation and link stay)']; },
    resume: function(){ return ['Put its upcoming dates back on everyone’s Google Calendar']; },
    join: function(){ return ['Google Calendar sends you the invitation']; },
    leave: function(){ return ['Take you off its Google Calendar invitation']; },
    'delete': function(){ return [isEditions(s) ? 'Delete it for good (its editions stay, as events of their own)' : 'Delete it for good' + (s.hidden ? '' : ', and cancel it on Google Calendar: Google emails everyone invited the cancellation')]; },
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
    if (t.classList.contains('sr-org-remove')) { keep(); editing.organisers.splice(+t.getAttribute('data-i'), 1); render(); return; }
    if (t.classList.contains('sr-plan-open')) { openPlanning(); return; }
    if (t.classList.contains('sr-plan-cancel')) { planning = null; render(); return; }
    if (t.classList.contains('sr-plan-go')) { schedule(); }
  });
  body.addEventListener('change', function(ev){
    if (!editing) return;
    if (ev.target.classList.contains('sr-often') || ev.target.classList.contains('sr-has-invite')) { keep(); render(); return; }
    if (!ev.target.classList.contains('sr-pick') || !ev.target.value) return;
    keep(); editing.organisers.push(ev.target.value); render();
  });
  // Its editions: all of them for PIs, admins and its organisers, the released ones for the rest.
  function watchEditions(){
    if (editionsUnsub || !isEditions(s)) return;
    var q = db.collection('events').where('series', '==', s.id);
    if (!full && !isOrganiser()) q = q.where('hidden', '==', false);
    editionsUnsub = q.onSnapshot(function(snap){
      editions = snap.docs.map(function(d){ return d.data(); }).filter(function(e){ return e.startDate; })
        .sort(function(a, b){ return a.startDate < b.startDate ? -1 : 1; });
      if (!editing) render();
    }, function(err){ console.error('[BOLD Series] loading its editions failed', err); editions = []; render(); });
  }

  var unsubscribe = null;
  BOLD.onUser(function(user){
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    me = user ? { email: user.email || '' } : null;
    if (!user) return;
    firebase.app().functions('europe-west2').httpsCallable('getMyAccess')().then(function(r){
      full = !!(r.data && r.data.fullWrite);
      if (editionsUnsub) { editionsUnsub(); editionsUnsub = null; }
      if (s) watchEditions();
      render();
    }).catch(function(){});
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
      if (s) watchEditions();
      if (!editing) render();
    }, function(err){
      console.error('[BOLD Series] loading the event series failed', err);
      loaded = true; s = null; render();
    });
  });
})();
