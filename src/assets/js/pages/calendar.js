(function(){
  // The masthead, gate and sidebar are bold.js's; this page shows everything on
  // BOLD.OS with a date or a time:
  // - events: the released events/{slug} (events-common.js), by their dates;
  // - project meetings: projectWorkspaces (see projectWorkspace in functions/index.js)
  //   in Google Calendar (an eventId), of projects that aren't completed, with Join and Leave;
  // - supervision meetings: studies/{email} (see exports.studies) in Google Calendar.
  // A Week grid (a dated week, events across the top; the default) or a List
  // (upcoming events, then the meetings by weekday), filtered by kind; both choices kept in localStorage.
  if (!BOLD.getAuth()) return;

  var el = function(id){ return document.getElementById(id); };
  var esc = BOLD.escapeHtml;
  var E = window.BoldEvents;
  var db = null, me = null, busy = {}, msgs = {}, unsubs = [], slackIds = {};
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
  // { kind, id, title, href, meeting, mine, meetUrl, people, w (a project's workspace) }.
  function meetings(){
    var out = [];
    if (shown('project')) (data.project || []).forEach(function(w){
      if (!w.meeting || !w.eventId || w.group === 'completed') return;
      out.push({ kind: 'project', id: w.cardId, title: w.title || 'Untitled', href: projectUrl(w), meeting: w.meeting,
        mine: (w.members || []).some(isMe), meetUrl: w.meetUrl, people: (w.members || []).length, w: w });
    });
    if (shown('study')) (data.study || []).forEach(function(s){
      if (!s.meeting || !s.eventId) return;
      var mine = isMe(s.email) || (s.people || []).some(function(p){ return isMe(p.email); });
      var id = slackIds[s.email];
      out.push({ kind: 'study', id: s.email, meeting: s.meeting, mine: mine, meetUrl: s.meetUrl, people: (s.people || []).length + 1,
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
  }

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
    MEETING_DAYS.forEach(function(d){
      var day = ms.filter(function(m){ return m.meeting.day === d[0]; })
        .sort(function(a, b){ return a.meeting.time.localeCompare(b.meeting.time) || a.title.localeCompare(b.title); });
      if (!day.length) return;
      html += '<h2 class="meet-day">' + d[1] + 's</h2><ul class="proj-list">';
      day.forEach(function(m){
        var when = meetingText(m.meeting).replace(/^[^,]*, /, '');
        var meta = [esc(when), m.people + (m.people === 1 ? ' person' : ' people')];
        if (m.mine && m.meetUrl) meta.push('<a href="' + esc(m.meetUrl) + '" target="_blank" rel="noopener">Google Meet</a>');
        html += '<li><div class="proj-main">' + titleHtml(m, 'proj-title') +
          '<span class="proj-meta">' + meta.join(' · ') + '</span>' +
          '<div class="proj-badges">' + kindBadge(m.kind) + (m.w ? groupBadge(m.w) : '') + '</div></div>' +
          (m.kind === 'project' ? joinHtml(m.w) : '') + '</li>';
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
  // its page; yours are filled in. Meetings every N weeks show every week.
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
      var day = ms.filter(function(m){ return m.meeting.day === MEETING_DAYS[i][0]; })
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
          html += '<' + tag + ' class="week-block cal-' + m.kind + (m.mine ? ' is-mine' : '') + '"' + (m.href ? ' href="' + esc(m.href) + '"' : '') +
            ' style="top:' + ((b.s - from * 60) / 60 * HOUR) + 'px;height:' + Math.max(18, (b.e - b.s) / 60 * HOUR - 2) + 'px;' +
            'left:calc(' + (b.lane * 100 / n) + '% + 2px);width:calc(' + (100 / n) + '% - 4px)" title="' + esc(m.title + ' · ' + meetingText(m.meeting) + ' · ' + KIND_LABELS[m.kind]) + '">' +
            '<span class="week-time">' + esc(m.meeting.time) + '</span> ' + esc(m.title) + (m.w ? ' ' + groupBadge(m.w) : '') + '</' + tag + '>';
        });
      });
      html += '</div>';
    });
    html += '</div></div>' +
      '<p class="week-note"><span class="week-key"></span> Yours' +
      (shown('project') && shown('study') ? ' <span class="week-key is-outline cal-project"></span> Projects <span class="week-key is-outline cal-study"></span> Supervision' : '') + '</p>';
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
    var btn = e.target.closest('.join-btn');
    if (!btn || btn.disabled) return;
    var id = btn.getAttribute('data-id'), action = btn.getAttribute('data-action');
    var w = (data.project || []).filter(function(x){ return x.cardId === id; })[0];
    if (!w) return;
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
  });

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
  });
})();
