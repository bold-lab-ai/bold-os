// profile.html's Studies tab, for PhD and Master students (their members record's
// role; or anyone who already has studies): their working title, the people involved
// in their studies (supervisors first) and a recurring meeting with them, which the
// `studies` function (functions/index.js) saves to studies/{email} and puts in Google
// Calendar, with every one of them invited. The meeting's fields are project-fields.js's.
(function(){
  var esc = BOLD.escapeHtml;
  var box = document.getElementById('studiesBody'), tab = document.getElementById('studiesTab');
  if (!box || !BOLD.getAuth()) return;
  var db;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var STUDY_ROLES = ['PhD student', 'Master student'];
  // Their Slack channel with the people involved (functions/index.js SUPERVISION_PREFIX,
  // supervisionChannelFor, normalizeSupervisionChannel: kept in sync by hand).
  var SUPERVISION_PREFIX = 'supervision-';
  function channelFor(name){
    var slug = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80 - SUPERVISION_PREFIX.length).replace(/-+$/, '');
    return slug ? SUPERVISION_PREFIX + slug : '';
  }
  var channelCheck = { name: '', text: '' }, checkTimer = null;
  var me = null, member, studies, editing = null, roster = null, busy = false, msg = '', unsubs = [];
  // Open requests to join their meeting, from the Calendar (studyRequest in functions/index.js).
  var asks = [], deciding = {};

  function call(data){ return firebase.app().functions('europe-west2').httpsCallable('studies')(data); }
  function isStudent(){ return !!(member && STUDY_ROLES.indexOf(member.role) !== -1) || !!studies; }

  function render(){
    if (!me || member === undefined || studies === undefined) return;
    keep();
    tab.hidden = !isStudent();
    if (!isStudent()) { box.innerHTML = '<p class="proj-msg">For PhD and Master students: set your role in <a href="#details">Your details</a>.</p>'; return; }
    // Studies go through the Calendar (studies callable): below its level, say so rather than offer a form that can't save.
    if (!mayUse()) { box.innerHTML = '<p class="proj-msg">Your studies (supervisors, meeting and channel) are ' + esc(BOLD.cannotReason('calendar', 'view').replace(/^For /, 'for ')) +
      (BOLD.myGroup() === 'pan' ? ' Your group isn\u2019t set yet: ask a PI or admin, or ask for one in <a href="#details">Your details</a>.</p>' : ' To use them, ask for another group in <a href="#details">Your details</a>.</p>'); return; }
    box.innerHTML = (editing ? '' : asksHtml()) + (editing ? formHtml() : factsHtml());
  }
  function mayUse(){ return BOLD.isFullWrite() || BOLD.can('calendar', 'view'); }
  BOLD.onAccess(function(){ render(); });

  function asksHtml(){
    if (!asks.length) return '';
    return '<h3 class="st-asks-head">Asking to join your meeting</h3><ul class="st-asks">' + asks.map(function(a){
      var off = deciding[a.id] ? ' disabled' : '';
      return '<li><div><b>' + esc(a.name || a.email) + '</b> <span class="acct-handle">' + esc(a.email) + '</span>' +
        (a.note ? '<p class="st-ask-note">' + esc(a.note) + '</p>' : '') + (a.error ? '<span class="st-error">' + esc(a.error) + '</span>' : '') + '</div>' +
        '<div class="event-controls"><button type="button" class="btn-text st-decide" data-id="' + esc(a.id) + '" data-accept="1"' + off + '>Approve</button>' +
        '<button type="button" class="btn-text danger st-decide" data-id="' + esc(a.id) + '"' + off + '>Decline</button></div></li>';
    }).join('') + '</ul>';
  }

  function factsHtml(){
    var s = studies || {}, m = member || {};
    var row = function(k, v){ return '<div class="fact"><dt>' + k + '</dt><dd>' + v + '</dd></div>'; };
    var dates = m.startDate && m.endDate ? m.startDate + ' – ' + m.endDate : m.startDate ? 'From ' + m.startDate : m.endDate ? 'Until ' + m.endDate : '';
    var people = (s.people || []).map(function(p){ return esc(p.name) + (p.name !== p.email ? ' <span class="acct-handle">' + esc(p.email) + '</span>' : ''); }).join('<br>');
    var pause = s.meeting ? ' <button type="button" class="btn-text st-pause" data-action="' + (s.pausedAt ? 'resume' : 'pause') + '"' + (busy ? ' disabled' : '') + '>' + (s.pausedAt ? 'Resume' : 'Pause') + '</button>' : '';
    var meeting = s.meeting && s.pausedAt ? esc(meetingText(s.meeting)) + ' <span class="acct-handle">· paused</span>' + pause
      : s.meeting ? esc(meetingText(s.meeting)) + pause +
        (s.eventLink || s.meetUrl ? '<span class="st-links">' + [s.eventLink ? '<a href="' + esc(s.eventLink) + '" target="_blank" rel="noopener">Calendar</a>' : '',
          s.meetUrl ? '<a href="' + esc(s.meetUrl) + '" target="_blank" rel="noopener">' + (s.meeting.link ? 'Own link' : 'Meet') + '</a>' : ''].filter(Boolean).join(' · ') + '</span>' : '') +
        (s.error ? '<span class="st-error">' + esc(s.error) + ' <button type="button" class="btn-text st-retry"' + (busy ? ' disabled' : '') + '>Try again</button></span>' : '')
      : '';
    var channel = s.channel ? (s.channelUrl ? '<a href="' + esc(s.channelUrl) + '" target="_blank" rel="noopener">#' + esc(s.channel) + '</a>' : '#' + esc(s.channel)) +
        (s.channelError ? '<span class="st-error">' + esc(s.channelError) + (s.error ? '' : ' <button type="button" class="btn-text st-retry"' + (busy ? ' disabled' : '') + '>Try again</button>') + '</span>' : '')
      : '';
    return (studies ? '<dl class="facts">' +
        row('Degree', esc(s.degree || m.role || '')) + (dates ? row('Dates', esc(dates)) : '') +
        row('Working title', esc(s.title || '') || '—') +
        row('People involved', people || '—') + row('Meeting', meeting || 'None' + (s.error ? '<span class="st-error">' + esc(s.error) + ' <button type="button" class="btn-text st-retry"' + (busy ? ' disabled' : '') + '>Try again</button></span>' : '')) + row('Slack channel', channel || 'None') + '</dl>'
      : '<p class="proj-msg">Add who supervises your studies, and a recurring meeting with them if you like.</p>') +
      (msg ? '<p class="proj-msg">' + esc(msg) + '</p>' : '') +
      '<div class="event-controls"><button type="button" class="btn-text st-edit">' + (studies ? 'Edit your studies' : 'Add your studies') + '</button></div>';
  }

  function formHtml(){
    var e = editing;
    var options = (roster || []).filter(function(p){ return p.email !== me.email && !e.people.some(function(x){ return x.email === p.email; }); })
      .map(function(p){ return '<option value="' + esc(p.email) + '">' + esc(p.name) + '</option>'; }).join('');
    return '<div class="event-form join-form">' +
      '<label>Working title<input type="text" class="st-title" maxlength="200" value="' + esc(e.title) + '" placeholder="Your thesis or project, as it stands"></label>' +
      '<label>People involved in your studies, supervisors first: they’re added to the Slack channel and invited to the meeting, if any</label>' +
      (e.people.length ? '<ul class="st-people">' + e.people.map(function(p, i){
        return '<li>' + esc(p.name) + '<span class="st-email">' + esc(p.email) + '</span><button type="button" class="btn-text danger st-remove" data-i="' + i + '">Remove</button></li>';
      }).join('') + '</ul>' : '') +
      (e.adding ? '<div class="st-add"><input type="text" class="st-new-name" maxlength="120" placeholder="Name" aria-label="Name">' +
          '<input type="email" class="st-new-email" maxlength="200" placeholder="Email" aria-label="Email">' +
          '<button type="button" class="btn-text st-add-new">Add</button><button type="button" class="btn-text st-add-cancel">Cancel</button></div>'
        : '<div class="st-add"><select class="st-pick" aria-label="Add a person"><option value="">' + (roster ? 'Add a person…' : 'Loading…') + '</option>' + options +
          '<option value="__new__">+ Someone not on Slack…</option></select></div>') +
      '<label class="st-meeting-label st-meeting-toggle"><input type="checkbox" class="st-has-meeting"' + (e.meeting ? ' checked' : '') + '> A recurring meeting (London time): Google Calendar invites you and everyone above</label>' +
      (e.meeting ? meetingEntryHtml(e.meeting) : '') +
      // The channel is optional until it's made: none if they have one already, such as their project's.
      (e.channelFixed ? '' : '<label class="st-meeting-label st-meeting-toggle"><input type="checkbox" class="st-has-channel"' + (e.hasChannel ? ' checked' : '') + '> A Slack channel with you and everyone above (untick it if you have one already, such as your project’s)</label>' +
        (e.hasChannel ? '<label>Its name (private; ' + SUPERVISION_PREFIX + ' is added if missing)<input type="text" class="st-channel" maxlength="80" value="' + esc(e.channel) + '"></label>' +
        '<p class="field-hint st-channel-hint">' + esc(channelCheck.name === e.channel ? channelCheck.text : '') + '</p>' : '')) +
      '<p class="ev-error"' + (e.error ? '' : ' hidden') + '>' + esc(e.error || '') + '</p>' +
      '<div class="event-form-actions"><button type="button" class="ev-save st-save"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Saving…' : 'Save') + '</button>' +
        '<button type="button" class="st-cancel"' + (busy ? ' disabled' : '') + '>Cancel</button></div></div>';
  }

  // What the form says now, kept across redraws.
  function keep(){
    if (!editing) return;
    var t = box.querySelector('.st-title');
    if (t) editing.title = t.value;
    var c = box.querySelector('.st-channel');
    if (c) editing.channel = c.value.trim();
    if (document.getElementById('pmDay')) {
      editing.meeting = { day: document.getElementById('pmDay').value, time: document.getElementById('pmTime').value,
        minutes: Number(document.getElementById('pmMinutes').value), every: Number(document.getElementById('pmEvery').value),
        until: document.getElementById('pmUntil').value, link: document.getElementById('pmLink').value.trim() };
    }
  }

  function loadRoster(){
    if (roster) return;
    db.collection('people').get().then(function(s){
      roster = s.docs.map(function(d){ var x = d.data(); return { name: x.name || x.email, email: String(x.email || '').toLowerCase() }; })
        .filter(function(p){ return p.email; }).sort(function(a, b){ return a.name.localeCompare(b.name); });
      keep(); render();
    }).catch(function(err){ console.error('[BOLD Studies] loading the people failed', err); roster = []; keep(); render(); });
  }

  function save(){
    keep();
    var e = editing;
    if (!e.people.length) { e.error = 'Add who supervises your studies.'; render(); return; }
    var meeting = e.meeting ? readMeetingEntry() : null;
    if (meeting && meeting.error) { e.error = meeting.error; render(); return; }
    var names = e.people.map(function(p){ return p.name; }).join(', ');
    var effects = [
      meeting ? 'Set the meeting on Google Calendar, ' + meetingText(meeting) + ', ' + meetVia(meeting) + ': Google emails ' + names + ' the invitation or the change'
        : studies && studies.meeting ? 'Cancel the meeting on Google Calendar: Google emails ' + names + ' the cancellation' : '',
      e.channelFixed ? 'Add anyone new to its Slack channel' : !e.hasChannel ? '' : 'Make or use the Slack channel #' + (e.channel || '').replace(/^#/, '') + ' and add ' + names + ' to it'].filter(Boolean);
    // Nothing outside BOLD.OS (no meeting, no channel): nothing to confirm.
    (effects.length ? BOLD.confirmAction({ title: 'Save your studies?', go: 'Save', effects: effects }) : Promise.resolve(true))
      .then(function(ok){ if (ok) sendSave(e, meeting); });
  }
  function sendSave(e, meeting){
    busy = true; e.error = ''; render();
    call({ action: 'save', title: e.title.trim(), people: e.people, meeting: meeting, channel: e.channelFixed || !e.hasChannel ? '' : e.channel, noChannel: !e.channelFixed && !e.hasChannel }).then(function(r){
      busy = false; editing = null;
      var s = r.data || {};
      var said = [s.meeting ? 'Google Calendar sends everyone the invitation' : '', s.channel ? 'Slack adds them to #' + s.channel : ''].filter(Boolean).join(', and ');
      msg = !s.error && !s.channelError && said ? 'Saved. ' + said.charAt(0).toUpperCase() + said.slice(1) + '.' : 'Saved.';
      render();
    }).catch(function(err){
      console.error('[BOLD Studies] saving failed', err);
      busy = false; e.error = (err && err.message) || 'Couldn’t save — try again.'; render();
    });
  }

  box.addEventListener('click', function(ev){
    var t = ev.target.closest('button');
    if (!t || t.disabled) return;
    if (t.classList.contains('st-edit')) {
      var s = studies || {};
      msg = '';
      editing = { title: s.title || '', people: (s.people || []).slice(), meeting: s.meeting || null, adding: false, error: '',
        channelFixed: !!s.channelUrl, hasChannel: !studies || !!s.channel, channel: s.channel || channelFor((member && member.name) || me.name) };
      loadRoster(); render(); if (!editing.channelFixed && editing.hasChannel) checkChannel(); return;
    }
    if (t.classList.contains('st-decide')) {
      var id = t.getAttribute('data-id'), a = asks.filter(function(x){ return x.id === id; })[0], yes = !!t.getAttribute('data-accept');
      var who = (a && (a.name || a.requesterName)) || 'them';
      BOLD.confirmAction(yes ? { title: 'Approve ' + who + '?', go: 'Approve', effects: [(studies && studies.meeting ? 'Add ' + who + ' to your meeting on Google Calendar (Google emails them the invitation) and to your Slack channel' : 'Add ' + who + ' to your Slack channel'), 'Tell them on Slack'] }
        : { title: 'Decline?', go: 'Decline', effects: ['Tell ' + who + ' on Slack'] }).then(function(ok){ if (ok) decide(id, a, yes); });
      return;
    }
    if (t.classList.contains('st-pause')) {
      var act = t.getAttribute('data-action');
      BOLD.confirmAction(act === 'pause'
        ? { title: 'Pause your meeting?', go: 'Pause', effects: ['Take its upcoming dates off everyone’s Google Calendar until it’s resumed (the invitation and Meet link stay the same)'] }
        : { title: 'Resume your meeting?', go: 'Resume', effects: ['Put its upcoming dates back on everyone’s Google Calendar'] }).then(function(ok){ if (ok) pause(act); });
      return;
    }
    if (t.classList.contains('st-retry')) {
      busy = true; render();
      call({ action: 'retry' }).catch(function(err){ console.error('[BOLD Studies] retrying failed', err); })
        .then(function(){ busy = false; render(); });
      return;
    }
    rest(t);
  });
  function decide(id, a, yes){
    deciding[id] = true; if (a) a.error = ''; render();
    firebase.app().functions('europe-west2').httpsCallable('studyRequest')({ action: 'decide', id: id, accept: yes })
      .catch(function(err){ console.error('[BOLD Studies] deciding failed', err); if (a) a.error = (err && err.message) || 'That didn’t work — try again.'; })
      .then(function(){ deciding[id] = false; render(); });
  }
  function pause(act){
    busy = true; msg = ''; render();
    call({ action: act }).then(function(){ msg = act === 'pause' ? 'Paused.' : 'Resumed: its dates are back in everyone’s Google Calendar.'; })
      .catch(function(err){ console.error('[BOLD Studies] ' + act + ' failed', err); msg = (err && err.message) || 'That didn’t work — try again.'; })
      .then(function(){ busy = false; render(); });
  }
  function rest(t){
    if (!editing) return;
    keep();
    if (t.classList.contains('st-cancel')) { editing = null; render(); return; }
    if (t.classList.contains('st-save')) { save(); return; }
    if (t.classList.contains('st-remove')) { editing.people.splice(+t.getAttribute('data-i'), 1); render(); return; }
    if (t.classList.contains('st-add-cancel')) { editing.adding = false; render(); return; }
    if (t.classList.contains('st-add-new')) {
      var name = box.querySelector('.st-new-name').value.trim(), email = box.querySelector('.st-new-email').value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { editing.error = 'Give a valid email.'; render(); return; }
      if (email !== me.email && !editing.people.some(function(p){ return p.email === email; })) editing.people.push({ name: name || email, email: email });
      editing.adding = false; editing.error = ''; render();
    }
  }
  // Says what saving would do with the channel: make it, or use the one already there.
  function checkChannel(){
    if (!editing || editing.channelFixed || !editing.hasChannel) return;
    var name = editing.channel;
    var hint = function(text){ channelCheck = { name: name, text: text }; var h = box.querySelector('.st-channel-hint'); if (h && editing && editing.channel === name) h.textContent = text; };
    if (!name) { hint('Enter a channel name.'); return; }
    call({ action: 'channel', name: name }).then(function(r){
      var d = r.data || {};
      hint((d.prefixed ? 'It will be #' + d.name + '. ' : '') + (d.exists ? '#' + d.name + ' already exists: you and the people above will be added to it. Choose another name for a new one.' : '#' + d.name + ' will be created, with you and the people above.'));
    }).catch(function(err){ hint((err && err.message) || ''); });
  }
  box.addEventListener('input', function(ev){
    if (!editing || !ev.target.classList.contains('st-channel')) return;
    editing.channel = ev.target.value.trim();
    clearTimeout(checkTimer); checkTimer = setTimeout(checkChannel, 500);
  });

  box.addEventListener('change', function(ev){
    if (!editing) return;
    var t = ev.target;
    keep();
    // The meeting is optional: unticking keeps what was typed, to come back on ticking again.
    if (t.classList.contains('st-has-channel')) { editing.hasChannel = t.checked; render(); checkChannel(); return; }
    if (t.classList.contains('st-has-meeting')) {
      if (t.checked) editing.meeting = editing.lastMeeting || { day: 'MO', time: '', minutes: 60, every: 1 };
      else { editing.lastMeeting = editing.meeting; editing.meeting = null; }
      render();
    }
    if (t.classList.contains('st-pick')) {
      if (t.value === '__new__') editing.adding = true;
      else {
        var p = (roster || []).filter(function(x){ return x.email === t.value; })[0];
        if (p) editing.people.push({ name: p.name, email: p.email });
      }
      render();
    }
  });

  BOLD.onUser(function(user){
    unsubs.forEach(function(u){ u(); }); unsubs = [];
    me = user && user.email ? { email: user.email.toLowerCase(), name: user.displayName || '' } : null;
    member = undefined; studies = undefined; editing = null; msg = ''; asks = [];
    if (!me) { tab.hidden = true; return; }
    unsubs.push(db.collection('members').doc(me.email).onSnapshot(function(s){ member = s.exists ? s.data() : null; render(); },
      function(e){ console.error('[BOLD Studies] loading your details failed', e); member = null; render(); }));
    unsubs.push(db.collection('studies').doc(me.email).onSnapshot(function(s){ studies = s.exists ? s.data() : null; render(); },
      function(e){ console.error('[BOLD Studies] loading your studies failed', e); studies = null; render(); }));
    unsubs.push(db.collection('studyRequests').where('student', '==', me.email).where('status', '==', 'open').onSnapshot(function(s){
      asks = s.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); }).sort(function(a, b){ return a.at - b.at; });
      render();
    }, function(e){ if (e.code !== 'permission-denied') console.error('[BOLD Studies] loading the requests failed', e); }));   // below the Calendar's level: none to show
  });
})();
