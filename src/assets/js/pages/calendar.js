(function(){
  // The masthead, gate and sidebar are bold.js's; this page shows everything on
  // BOLD.OS with a date or a time:
  // - events: the released events/{slug} (events-common.js), by their dates;
  // - project meetings: projectWorkspaces (see projectWorkspace in functions/index.js)
  //   in Google Calendar (an eventId), of projects that aren't completed, with Join and Leave;
  // - supervision meetings: studies/{email} (see exports.studies) in Google Calendar.
  // A Week grid (a dated week, events across the top; the default) or a List
  // (upcoming events, then the meetings by weekday), filtered by kind; both choices kept in localStorage.
  // Clicking a meeting opens a card to join it: a project's at once (projectWorkspace
  // join), a student's by asking them (studyRequest, approved on their Studies tab).
  // A paused meeting (pausedAt: cancelled in Google Calendar, the time kept) shows
  // greyed out; whoever is in it can Pause or Resume it from its card.
  if (!BOLD.getAuth()) return;

  var el = function(id){ return document.getElementById(id); };
  var esc = BOLD.escapeHtml;
  var E = window.BoldEvents;
  var db = null, me = null, busy = {}, msgs = {}, unsubs = [], slackIds = {};
  var asked = {}, pop = null; // asked: student email → my open request's id; pop: the open card { key, x, y }
  var data = { project: null, study: null, event: null };
  var VIEW_KEY = 'boldCalendar:view', KIND_KEY = 'boldCalendar:kind', view = 'week', kind = 'all';
  var weekOffset = 0;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){}

  var KIND_LABELS = { event: 'Event', project: 'Project', study: 'Supervision' };
  var GROUP_LABELS = { planned: 'Planned', ongoing: 'Ongoing' };
  function kindBadge(k){ return '<span class="type-badge cal-' + k + '">' + KIND_LABELS[k] + '</span>'; }
  // The Projects page's badge: Ongoing in the accent, Planned plain.
  function groupBadge(w){ return GROUP_LABELS[w.group] ? '<span class="badge' + (w.group === 'ongoing' ? ' badge-stage' : '') + '">' + GROUP_LABELS[w.group] + '</span>' : ''; }

  function isMe(email){ return !!(me && me.email && String(email).toLowerCase() === me.email.toLowerCase()); }
  function shown(k){ return kind === 'all' || kind === k; }

  // Every recurring meeting, projects' and students', as one shape:
  // { kind, id, title, href, meeting, mine, paused, meetUrl, people, w (a project's workspace) }.
  function meetings(all){
    var out = [];
    if (all || shown('project')) (data.project || []).forEach(function(w){
      if (!w.meeting || !(w.eventId || w.pausedAt) || w.group === 'completed') return;
      out.push({ kind: 'project', id: w.cardId, title: w.title || 'Untitled', href: projectUrl(w), meeting: w.meeting,
        mine: (w.members || []).some(isMe), paused: !!w.pausedAt, start: w.eventStart || '', meetUrl: w.meetUrl, people: (w.members || []).length, w: w });
    });
    if (all || shown('study')) (data.study || []).forEach(function(s){
      if (!s.meeting || !(s.eventId || s.pausedAt)) return;
      var mine = isMe(s.email) || (s.people || []).some(function(p){ return isMe(p.email); });
      var id = slackIds[s.email];
      out.push({ kind: 'study', id: s.email, meeting: s.meeting, mine: mine, paused: !!s.pausedAt, start: s.eventStart || '', meetUrl: s.meetUrl, people: (s.people || []).length + 1,
        first: String(s.name || s.email).split(' ')[0],
        title: (s.name || s.email) + ' · ' + (s.degree === 'Master student' ? 'Master' : 'PhD') + ' supervision',
        href: isMe(s.email) ? 'profile.html#studies' : id ? 'person.html?id=' + encodeURIComponent(id) : '' });
    });
    return out;
  }
  function events(){ return shown('event') ? (data.event || []) : []; }
  function eventUrl(x){ return x.page || 'event.html?event=' + encodeURIComponent(x.slug); }

  function projectUrl(w){
    return 'project.html#id=' + encodeURIComponent(w.cardId) + (w.boardId ? '&board=' + encodeURIComponent(w.boardId) : '');
  }
  function titleHtml(m, cls){
    return m.href ? '<a class="' + cls + '" href="' + esc(m.href) + '">' + esc(m.title) + '</a>' : '<span class="' + cls + '">' + esc(m.title) + '</span>';
  }

  function render(){
    if (data.project === null && data.study === null && data.event === null) return;
    var ms = meetings(), evs = events();
    if (view === 'list' && !ms.length && !evs.filter(function(x){ return !E.isPast(x); }).length) {
      el('meetMsg').textContent = 'Nothing coming up.';
      el('meetMsg').hidden = false; el('meetings').hidden = true;
      return;
    }
    el('meetings').innerHTML = view === 'week' ? weekHtml(ms, evs) : listHtml(ms, evs);
    el('meetings').hidden = false; el('meetMsg').hidden = true;
    renderPop();
  }

  // The card for one meeting, by the block or button that opened it.
  function keyOf(m){ return m.kind + ':' + m.id; }
  function pausedBadge(m){ return m.paused ? '<span class="badge">Paused</span>' : ''; }
  function renderPop(){
    var box = el('calPop');
    var m = pop && meetings(true).filter(function(x){ return keyOf(x) === pop.key; })[0];
    if (!m) { box.hidden = true; box.innerHTML = ''; return; }
    var meta = [esc(meetingText(m.meeting)), m.people + (m.people === 1 ? ' person' : ' people')];
    if (m.mine && m.meetUrl) meta.push('<a href="' + esc(m.meetUrl) + '" target="_blank" rel="noopener">Google Meet</a>');
    var html = '<button type="button" class="cal-pop-close" aria-label="Close">&times;</button>' +
      '<div class="proj-badges">' + kindBadge(m.kind) + (m.w ? groupBadge(m.w) : '') + pausedBadge(m) + '</div>' +
      titleHtml(m, 'proj-title') + '<span class="proj-meta">' + meta.join(' \u00b7 ') + '</span>';
    if (m.mine) html += '<p class="cal-pop-note">' + (m.paused ? 'Paused: its upcoming dates are off Google Calendar until it’s resumed.' : '') +
      ' <button type="button" class="btn-text cal-pause" data-action="' + (m.paused ? 'resume' : 'pause') + '"' + (busy[keyOf(m)] ? ' disabled' : '') + '>' + (m.paused ? 'Resume' : 'Pause the meeting') + '</button></p>';
    if (m.kind === 'project') html += '<div class="cal-pop-act">' + joinHtml(m.w) + '</div>';
    else if (isMe(m.id)) html += '<p class="cal-pop-note">Your supervision meeting. <a href="profile.html#studies">Edit it</a>.</p>';
    else if (m.mine) html += '<p class="cal-pop-note">You’re in this meeting.</p>';
    else if (asked[m.id]) html += '<p class="cal-pop-note">You asked to join. <button type="button" class="btn-text cal-withdraw"' + (busy[m.id] ? ' disabled' : '') + '>Withdraw</button></p>';
    else html += '<label class="cal-pop-label">Ask ' + esc(m.first) + ' to add you to the people involved in their studies: their meeting and Slack channel' +
        '<textarea class="cal-ask-note" rows="2" maxlength="1000" placeholder="A note (optional)"></textarea></label>' +
      '<div class="cal-pop-act"><button type="button" class="join-btn cal-ask"' + (busy[m.id] ? ' disabled' : '') + '>Ask to join</button></div>';
    if (msgs[keyOf(m)]) html += '<p class="join-msg cal-pop-msg" role="status">' + msgs[keyOf(m)] + '</p>';
    if (m.kind === 'study' && msgs[m.id]) html += '<p class="join-msg cal-pop-msg" role="status">' + msgs[m.id] + '</p>';
    var note = box.querySelector('.cal-ask-note'), typed = note ? note.value : '';
    box.innerHTML = html; box.hidden = false;
    if (typed && box.querySelector('.cal-ask-note')) box.querySelector('.cal-ask-note').value = typed;
    var w = box.offsetWidth, maxX = document.documentElement.clientWidth - w - 12;
    box.style.left = Math.max(12, Math.min(pop.x, maxX)) + 'px';
    box.style.top = pop.y + 'px';
  }
  function openPop(key, anchor){
    var r = anchor.getBoundingClientRect();
    pop = { key: key, x: r.left + window.scrollX, y: r.bottom + window.scrollY + 6 };
    renderPop();
  }
  function closePop(){ pop = null; renderPop(); }

  function listHtml(ms, evs){
    var html = '';
    var coming = evs.filter(function(x){ return !E.isPast(x); })
      .sort(function(a, b){ return a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0; });
    if (coming.length) {
      html += '<h2 class="meet-day">Events</h2><ul class="proj-list">';
      coming.forEach(function(x){
        html += '<li><div class="proj-main"><a class="proj-title" href="' + esc(eventUrl(x)) + '">' + esc(x.title) + '</a>' +
          '<span class="proj-meta">' + esc(E.when(x.startDate, x.endDate)) + (x.place ? ' · ' + esc(x.place) : '') + '</span>' +
          '<div class="proj-badges">' + kindBadge('event') + '</div></div></li>';
      });
      html += '</ul>';
    }
    var today = iso(new Date());
    MEETING_DAYS.forEach(function(d){
      // Ones whose end date has passed are over.
      var day = ms.filter(function(m){ return m.meeting.day === d[0] && !(m.meeting.until && m.meeting.until < today); })
        .sort(function(a, b){ return a.meeting.time.localeCompare(b.meeting.time) || a.title.localeCompare(b.title); });
      if (!day.length) return;
      html += '<h2 class="meet-day">' + d[1] + 's</h2><ul class="proj-list">';
      day.forEach(function(m){
        var when = meetingText(m.meeting).replace(/^[^,]*, /, '');
        var meta = [esc(when), m.people + (m.people === 1 ? ' person' : ' people')];
        if (m.mine && m.meetUrl) meta.push('<a href="' + esc(m.meetUrl) + '" target="_blank" rel="noopener">Google Meet</a>');
        html += '<li' + (m.paused ? ' class="is-paused"' : '') + '><div class="proj-main">' + titleHtml(m, 'proj-title') +
          '<span class="proj-meta">' + meta.join(' · ') + '</span>' +
          '<div class="proj-badges">' + kindBadge(m.kind) + (m.w ? groupBadge(m.w) : '') + pausedBadge(m) + '</div></div>' +
          (m.kind === 'project' ? joinHtml(m.w) : m.mine ? '' : '<div class="join-wrap"><button type="button" class="join-btn cal-open" data-key="' + esc(keyOf(m)) + '">' + (asked[m.id] ? 'Asked' : 'Ask to join') + '</button></div>') + '</li>';
      });
      html += '</ul>';
    });
    return html;
  }

  function joinHtml(w){
    var members = w.members || [];
    var mine = members.some(isMe), joined = (w.joined || []).some(isMe);
    var label = !mine ? 'Join the project' : joined ? 'Leave' : 'On the project';
    var off = busy[w.cardId] || (mine && !joined);
    return '<div class="join-wrap"><button type="button" class="join-btn" data-id="' + esc(w.cardId) + '" data-action="' + (mine ? 'leave' : 'join') + '"' +
        (off ? ' disabled' : '') + (mine && !joined ? ' title="Its submitter and authors stay on the project"' : '') + '>' + label + '</button>' +
      '<span class="join-msg" role="status">' + (msgs[w.cardId] || '') + '</span></div>';
  }

  // A dated week, Monday first: a column per day (Saturday and Sunday only when used),
  // the events of each day across the top, an hour per row below, each meeting a block
  // from its start to its end; meetings that overlap sit side by side. A block opens
  // its page; yours are filled in. A meeting every N weeks shows in the weeks N apart
  // from its first date (`eventStart`), and every week if that isn't known.
  var HOUR = 48; // px
  var DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var pad = function(n){ return (n < 10 ? '0' : '') + n; };
  function minutes(hm){ var t = hm.split(':').map(Number); return t[0] * 60 + t[1]; }
  function iso(d){ return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function monday(offset){
    var d = new Date(); d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - (d.getDay() + 6) % 7 + offset * 7);
    return d;
  }
  function inWeek(m, day){
    if (!m.start) return true;
    var weeks = Math.round((Date.parse(day) - Date.parse(m.start)) / (7 * 86400000));
    return day >= m.start && weeks % (m.meeting.every || 1) === 0;
  }
  function weekHtml(ms, evs){
    var start = monday(weekOffset), dates = [];
    for (var i = 0; i < 7; i++) { var d = new Date(start); d.setDate(start.getDate() + i); dates.push(d); }
    var onDay = function(i){ var t = iso(dates[i]); return evs.filter(function(x){ return x.startDate <= t && (x.endDate || x.startDate) >= t; }); };
    var cols = MEETING_DAYS.map(function(d, i){ return i; }).filter(function(i){
      return i < 5 || ms.some(function(m){ return m.meeting.day === MEETING_DAYS[i][0]; }) || onDay(i).length;
    });
    var from = Math.min.apply(null, ms.map(function(m){ return Math.floor(minutes(m.meeting.time) / 60); }).concat([9]));
    var to = Math.min(24, Math.max.apply(null, ms.map(function(m){ return Math.ceil((minutes(m.meeting.time) + m.meeting.minutes) / 60); }).concat([18])));
    var hours = [];
    for (var h = from; h < to; h++) hours.push(h);
    var today = iso(new Date());
    var last = dates[6];
    var range = start.getDate() + (start.getMonth() !== last.getMonth() ? ' ' + MONTHS[start.getMonth()] : '') +
      '–' + last.getDate() + ' ' + MONTHS[last.getMonth()] + ' ' + last.getFullYear();
    var html = '<div class="cal-nav"><button type="button" class="view-btn cal-step" data-step="-1" aria-label="Previous week">&larr;</button>' +
      '<button type="button" class="view-btn cal-step" data-step="0"' + (weekOffset ? '' : ' disabled') + '>This week</button>' +
      '<button type="button" class="view-btn cal-step" data-step="1" aria-label="Next week">&rarr;</button>' +
      '<span class="cal-range">' + esc(range) + '</span></div>' +
      '<div class="week" style="--days:' + cols.length + '">' +
      '<div class="week-head"><span></span>' + cols.map(function(i){
        return '<span' + (iso(dates[i]) === today ? ' class="is-today"' : '') + '>' + DAY_SHORT[i] + ' ' + dates[i].getDate() + '</span>';
      }).join('') + '</div>';
    if (cols.some(function(i){ return onDay(i).length; })) {
      html += '<div class="week-head week-allday"><span></span>' + cols.map(function(i){
        return '<span>' + onDay(i).map(function(x){
          return '<a class="cal-chip" href="' + esc(eventUrl(x)) + '" title="' + esc(x.title + ' · ' + E.when(x.startDate, x.endDate) + (x.place ? ' · ' + x.place : '')) + '">' + esc(x.title) + '</a>';
        }).join('') + '</span>';
      }).join('') + '</div>';
    }
    html += '<div class="week-body" style="height:' + (hours.length * HOUR) + 'px">' +
      '<div class="week-hours">' + hours.map(function(h){ return '<span style="top:' + ((h - from) * HOUR) + 'px">' + pad(h) + ':00</span>'; }).join('') + '</div>';
    cols.forEach(function(i){
      // Not before its first date or after its end date, and only in its weeks.
      var day = ms.filter(function(m){ return m.meeting.day === MEETING_DAYS[i][0] && !(m.meeting.until && m.meeting.until < iso(dates[i])) && inWeek(m, iso(dates[i])); })
        .map(function(m){ var s = minutes(m.meeting.time); return { m: m, s: s, e: s + m.meeting.minutes }; })
        .sort(function(a, b){ return a.s - b.s || a.e - b.e; });
      // Side by side: each meeting takes the first lane free at its start; a group of
      // overlapping meetings shares its width among the lanes it needed.
      var groups = [], cur = null;
      day.forEach(function(b){
        if (!cur || b.s >= cur.end) { cur = { end: b.e, items: [], lanes: [] }; groups.push(cur); }
        var lane = cur.lanes.findIndex(function(end){ return end <= b.s; });
        if (lane < 0) { lane = cur.lanes.length; cur.lanes.push(0); }
        cur.lanes[lane] = b.e; b.lane = lane; cur.items.push(b); cur.end = Math.max(cur.end, b.e);
      });
      html += '<div class="week-day">' + hours.map(function(h){ return '<span class="week-line" style="top:' + ((h - from) * HOUR) + 'px"></span>'; }).join('');
      groups.forEach(function(g){
        g.items.forEach(function(b){
          var m = b.m, n = g.lanes.length, tag = m.href ? 'a' : 'span';
          html += '<' + tag + ' class="week-block cal-' + m.kind + (m.mine ? ' is-mine' : '') + (m.paused ? ' is-paused' : '') + '" data-key="' + esc(keyOf(m)) + '"' + (m.href ? ' href="' + esc(m.href) + '"' : '') +
            ' style="top:' + ((b.s - from * 60) / 60 * HOUR) + 'px;height:' + Math.max(18, (b.e - b.s) / 60 * HOUR - 2) + 'px;' +
            'left:calc(' + (b.lane * 100 / n) + '% + 2px);width:calc(' + (100 / n) + '% - 4px)" title="' + esc(m.title + ' · ' + meetingText(m.meeting) + ' · ' + KIND_LABELS[m.kind] + (m.paused ? ' · Paused' : '')) + '">' +
            '<span class="week-time">' + esc(m.meeting.time) + '</span> ' + esc(m.title) + (m.w ? ' ' + groupBadge(m.w) : '') + '</' + tag + '>';
        });
      });
      html += '</div>';
    });
    html += '</div></div>' +
      '<p class="week-note"><span class="week-key"></span> Yours' +
      (shown('project') && shown('study') ? ' <span class="week-key is-outline cal-project"></span> Projects <span class="week-key is-outline cal-study"></span> Supervision' : '') +
      (ms.some(function(m){ return m.paused; }) ? ' <span class="week-key is-outline is-paused"></span> Paused' : '') + '</p>';
    return html;
  }

  function press(sel, attr, value){
    Array.prototype.forEach.call(document.querySelectorAll(sel), function(b){ b.setAttribute('aria-pressed', String(b.getAttribute(attr) === value)); });
  }
  function setView(v){
    view = v === 'list' ? 'list' : 'week';
    press('.view-btn[data-view]', 'data-view', view);
    try { localStorage.setItem(VIEW_KEY, view); } catch (e){}
    render();
  }
  function setKind(k){
    kind = KIND_LABELS[k] ? k : 'all';
    press('.kind-btn', 'data-kind', kind);
    try { localStorage.setItem(KIND_KEY, kind); } catch (e){}
    render();
  }
  Array.prototype.forEach.call(document.querySelectorAll('.view-btn[data-view]'), function(b){
    b.addEventListener('click', function(){ setView(b.getAttribute('data-view')); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.kind-btn'), function(b){
    b.addEventListener('click', function(){ setKind(b.getAttribute('data-kind')); });
  });
  try { view = localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'week'; kind = localStorage.getItem(KIND_KEY) || 'all'; } catch (e){}
  setView(view); setKind(kind);

  el('meetings').addEventListener('click', function(e){
    var step = e.target.closest('.cal-step');
    if (step) { var s = +step.getAttribute('data-step'); weekOffset = s ? weekOffset + s : 0; render(); return; }
    // A meeting's block (a plain click: a new tab still opens its page) or Ask to join.
    var opener = e.target.closest('.week-block, .cal-open');
    if (opener && !(e.metaKey || e.ctrlKey || e.shiftKey || e.button)) { e.preventDefault(); openPop(opener.getAttribute('data-key'), opener); return; }
    onJoin(e);
  });
  el('calPop').addEventListener('click', function(e){
    if (e.target.closest('.cal-pop-close')) { closePop(); return; }
    var m = pop && meetings(true).filter(function(x){ return keyOf(x) === pop.key; })[0];
    if (m && e.target.closest('.cal-ask, .cal-withdraw')) { askOrWithdraw(m, !!e.target.closest('.cal-ask')); return; }
    var pz = e.target.closest('.cal-pause');
    if (m && pz && !pz.disabled) { pauseOrResume(m, pz.getAttribute('data-action')); return; }
    onJoin(e);
  });
  document.addEventListener('click', function(e){
    // (a button the card redrew away is no longer in the page: not a click outside)
    if (pop && document.contains(e.target) && !e.target.closest('#calPop, .week-block, .cal-open')) closePop();
  });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape' && pop) closePop(); });

  // Pause or resume a meeting: projectWorkspace for a project, studies for a student's.
  function pauseOrResume(m, action){
    BOLD.confirmAction(action === 'pause'
      ? { title: 'Pause “' + m.title + '”?', go: 'Pause', effects: ['Take its upcoming dates off everyone’s Google Calendar until it’s resumed (the invitation and Meet link stay the same)'] }
      : { title: 'Resume “' + m.title + '”?', go: 'Resume', effects: ['Put its upcoming dates back on everyone’s Google Calendar'] })
      .then(function(ok){ if (ok) sendPause(m, action); });
  }
  function sendPause(m, action){
    var k = keyOf(m), fns = firebase.app().functions('europe-west2'), call;
    busy[k] = true; msgs[k] = ''; render();
    try {
      call = m.kind === 'project' ? fns.httpsCallable('projectWorkspace')({ action: action, id: m.id, board: m.w.boardId || null })
        : fns.httpsCallable('studies')({ action: action, student: m.id });
    } catch (err){ call = Promise.reject(err); }
    call.then(function(){
      busy[k] = false; msgs[k] = action === 'pause' ? 'Paused.' : 'Resumed: its dates are back in everyone’s Google Calendar.'; render();
    }).catch(function(err){
      console.error('[BOLD Lab] ' + action + ' failed', err);
      busy[k] = false; msgs[k] = esc((err && err.message) || 'That didn’t work — try again.'); render();
    });
  }

  function askOrWithdraw(m, ask){
    var note = el('calPop').querySelector('.cal-ask-note');
    var text = note ? note.value : '';
    if (!ask) return sendAsk(m, ask, text);
    BOLD.confirmAction({ title: 'Ask to join ' + m.first + '’s meeting?', go: 'Ask', effects: ['Send ' + m.first + ' a Slack message from BOLD.OS asking them to approve it'] })
      .then(function(ok){ if (ok) sendAsk(m, ask, text); });
  }
  function sendAsk(m, ask, text){
    busy[m.id] = true; msgs[m.id] = ''; render();
    var call;
    try { call = firebase.app().functions('europe-west2').httpsCallable('studyRequest')(ask ? { action: 'request', student: m.id, note: text } : { action: 'withdraw', id: asked[m.id] }); }
    catch (err){ call = Promise.reject(err); }
    call.then(function(r){
      busy[m.id] = false;
      if (ask) asked[m.id] = (r.data || {}).id || true; else delete asked[m.id];
      msgs[m.id] = ask ? 'Asked: ' + esc(m.first) + ' gets a Slack message to approve it.' : '';
      render();
    }).catch(function(err){
      console.error('[BOLD Lab] studyRequest failed', err);
      busy[m.id] = false;
      msgs[m.id] = esc((err && err.message) || 'That didn’t work — try again.');
      render();
    });
  }

  function onJoin(e){
    var btn = e.target.closest('.join-btn');
    if (!btn || btn.disabled) return;
    var id = btn.getAttribute('data-id'), action = btn.getAttribute('data-action');
    var w = (data.project || []).filter(function(x){ return x.cardId === id; })[0];
    if (!w) return;
    var join = action === 'join';
    BOLD.confirmAction({ title: (join ? 'Join “' : 'Leave “') + (w.title || 'this project') + '”?', go: join ? 'Join' : 'Leave', effects: join
      ? [w.slackChannel ? 'Invite you to ' + w.slackChannel + ' on Slack' : '', 'Add you to its meeting on Google Calendar (Google emails you the invitation)', 'Share its slides and notes on Google Drive with you'].filter(Boolean)
      : ['Take you off its meeting on Google Calendar', 'Stop sharing its slides and notes with you'] })
      .then(function(ok){ if (ok) sendJoin(id, action, w); });
  }
  function sendJoin(id, action, w){
    busy[id] = true; msgs[id] = ''; render();
    var call;
    try { call = firebase.app().functions('europe-west2').httpsCallable('projectWorkspace')({ action: action, id: id, board: w.boardId || null }); }
    catch (err){ call = Promise.reject(err); }
    call.then(function(r){
      var slack = (r.data || {}).slack;
      busy[id] = false;
      msgs[id] = action !== 'join' ? '' : slack && slack.error ? esc(slack.error)
        : 'Invited' + (slack && slack.url ? ' · <a href="' + esc(slack.url) + '" target="_blank" rel="noopener">Open in Slack</a>' : '');
      render();
    }).catch(function(err){
      console.error('[BOLD Lab] projectWorkspace ' + action + ' failed', err);
      busy[id] = false;
      msgs[id] = esc((err && err.message) || 'That didn’t work — try again.');
      render();
    });
  }

  function watch(key, query, map){
    unsubs.push(query.onSnapshot(function(snap){
      data[key] = snap.docs.map(map);
      render();
    }, function(err){
      console.error('[BOLD Lab] loading the calendar (' + key + ') failed', err);
      data[key] = data[key] || [];
      render();
    }));
  }

  BOLD.onUser(function(user){
    me = user;
    unsubs.forEach(function(u){ u(); }); unsubs = [];
    if (!user || !db) return;
    // A student's meeting opens their page: person.html?id=<their Slack id> (the people roster).
    db.collection('people').get().then(function(ps){
      ps.docs.forEach(function(d){ var e = String(d.data().email || '').toLowerCase(); if (e) slackIds[e] = d.id; });
      render();
    }).catch(function(){});
    watch('project', db.collection('projectWorkspaces'), function(d){ return Object.assign({ cardId: d.id }, d.data()); });
    watch('study', db.collection('studies'), function(d){ return Object.assign({ email: d.id }, d.data()); });
    // Everyone but PIs/admins may only query the released ones (firestore.rules); hidden ones stay off here for all.
    watch('event', db.collection('events').where('hidden', '==', false), function(d){ return d.data(); });
    // My open requests to join a student's meeting.
    unsubs.push(db.collection('studyRequests').where('email', '==', String(user.email || '').toLowerCase()).where('status', '==', 'open').onSnapshot(function(snap){
      asked = {};
      snap.docs.forEach(function(d){ asked[d.data().student] = d.id; });
      render();
    }, function(err){ console.error('[BOLD Lab] loading your requests failed', err); }));
  });
})();
