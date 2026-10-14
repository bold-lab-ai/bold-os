(function(){
  // The masthead, gate and sidebar are bold.js's; this page lists every project's
  // recurring meeting (projectWorkspaces, see projectWorkspace in functions/index.js):
  // a list by weekday, with Join and Leave, or a week grid. Only meetings that are
  // in Google Calendar (an eventId): one chosen but not yet made isn't listed.
  if (!BOLD.getAuth()) return;

  var el = function(id){ return document.getElementById(id); };
  var esc = BOLD.escapeHtml;
  var db = null, me = null, list = [], busy = {}, msgs = {}, unsub = null, loaded = false;
  var VIEW_KEY = 'boldMeetings:view', view = 'list';
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){}

  function isMe(email){ return !!(me && me.email && String(email).toLowerCase() === me.email.toLowerCase()); }

  function projectUrl(w){
    return 'project.html#id=' + encodeURIComponent(w.cardId) + (w.boardId ? '&board=' + encodeURIComponent(w.boardId) : '');
  }

  function render(){
    if (!loaded) return;
    var withMeeting = list.filter(function(w){ return w.meeting && w.eventId; });
    if (!withMeeting.length) {
      el('meetMsg').textContent = 'No project has a meeting yet.';
      el('meetMsg').hidden = false; el('meetings').hidden = true;
      return;
    }
    el('meetings').innerHTML = view === 'week' ? weekHtml(withMeeting) : listHtml(withMeeting);
    el('meetings').hidden = false; el('meetMsg').hidden = true;
  }

  function listHtml(withMeeting){
    var html = '';
    MEETING_DAYS.forEach(function(d){
      var day = withMeeting.filter(function(w){ return w.meeting.day === d[0]; })
        .sort(function(a, b){ return a.meeting.time.localeCompare(b.meeting.time) || (a.title || '').localeCompare(b.title || ''); });
      if (!day.length) return;
      html += '<h2 class="meet-day">' + d[1] + 's</h2><ul class="proj-list">';
      day.forEach(function(w){
        var members = w.members || [];
        var mine = members.some(isMe), joined = (w.joined || []).some(isMe);
        var when = meetingText(w.meeting).replace(/^[^,]*, /, '');
        var meta = [esc(when), members.length + (members.length === 1 ? ' person' : ' people')];
        if (mine && w.meetUrl) meta.push('<a href="' + esc(w.meetUrl) + '" target="_blank" rel="noopener">Google Meet</a>');
        var label = !mine ? 'Join the project' : joined ? 'Leave' : 'On the project';
        var off = busy[w.cardId] || (mine && !joined);
        html += '<li><div class="proj-main"><a class="proj-title" href="' + projectUrl(w) + '">' + esc(w.title || 'Untitled') + '</a>' +
          '<span class="proj-meta">' + meta.join(' · ') + '</span></div>' +
          '<div class="join-wrap"><button type="button" class="join-btn" data-id="' + esc(w.cardId) + '" data-action="' + (mine ? 'leave' : 'join') + '"' +
            (off ? ' disabled' : '') + (mine && !joined ? ' title="Its submitter and authors stay on the project"' : '') + '>' + label + '</button>' +
          '<span class="join-msg" role="status">' + (msgs[w.cardId] || '') + '</span></div></li>';
      });
      html += '</ul>';
    });
    return html;
  }

  // The week as a grid: a column per day (Saturday and Sunday only when used), an
  // hour per row, each meeting a block from its start to its end; meetings that
  // overlap sit side by side. A block opens its project; yours are filled in.
  var HOUR = 48; // px
  function minutes(hm){ var t = hm.split(':').map(Number); return t[0] * 60 + t[1]; }
  function weekHtml(withMeeting){
    var days = MEETING_DAYS.filter(function(d, i){ return i < 5 || withMeeting.some(function(w){ return w.meeting.day === d[0]; }); });
    var from = Math.min.apply(null, withMeeting.map(function(w){ return Math.floor(minutes(w.meeting.time) / 60); }).concat([9]));
    var to = Math.max.apply(null, withMeeting.map(function(w){ return Math.ceil((minutes(w.meeting.time) + w.meeting.minutes) / 60); }).concat([18]));
    to = Math.min(to, 24);
    var hours = [];
    for (var h = from; h < to; h++) hours.push(h);
    var pad = function(n){ return (n < 10 ? '0' : '') + n; };
    var html = '<div class="week" style="--days:' + days.length + '">' +
      '<div class="week-head"><span></span>' + days.map(function(d){ return '<span>' + d[1].slice(0, 3) + '</span>'; }).join('') + '</div>' +
      '<div class="week-body" style="height:' + (hours.length * HOUR) + 'px">' +
      '<div class="week-hours">' + hours.map(function(h){ return '<span style="top:' + ((h - from) * HOUR) + 'px">' + pad(h) + ':00</span>'; }).join('') + '</div>';
    days.forEach(function(d){
      var day = withMeeting.filter(function(w){ return w.meeting.day === d[0]; })
        .map(function(w){ var s = minutes(w.meeting.time); return { w: w, s: s, e: s + w.meeting.minutes }; })
        .sort(function(a, b){ return a.s - b.s || a.e - b.e; });
      // Side by side: each meeting takes the first lane free at its start; a group of
      // overlapping meetings shares its width among the lanes it needed.
      var groups = [], cur = null;
      day.forEach(function(m){
        if (!cur || m.s >= cur.end) { cur = { end: m.e, items: [], lanes: [] }; groups.push(cur); }
        var lane = cur.lanes.findIndex(function(end){ return end <= m.s; });
        if (lane < 0) { lane = cur.lanes.length; cur.lanes.push(0); }
        cur.lanes[lane] = m.e; m.lane = lane; cur.items.push(m); cur.end = Math.max(cur.end, m.e);
      });
      html += '<div class="week-day">' + hours.map(function(h){ return '<span class="week-line" style="top:' + ((h - from) * HOUR) + 'px"></span>'; }).join('');
      groups.forEach(function(g){
        g.items.forEach(function(m){
          var w = m.w, mine = (w.members || []).some(isMe), n = g.lanes.length;
          html += '<a class="week-block' + (mine ? ' is-mine' : '') + '" href="' + projectUrl(w) + '" style="top:' + ((m.s - from * 60) / 60 * HOUR) + 'px;height:' + Math.max(18, (m.e - m.s) / 60 * HOUR - 2) + 'px;' +
            'left:calc(' + (m.lane * 100 / n) + '% + 2px);width:calc(' + (100 / n) + '% - 4px)" title="' + esc((w.title || 'Untitled') + ' \u00b7 ' + meetingText(w.meeting)) + '">' +
            '<span class="week-time">' + esc(w.meeting.time) + '</span> ' + esc(w.title || 'Untitled') + '</a>';
        });
      });
      html += '</div>';
    });
    html += '</div></div>' +
      '<p class="week-note"><span class="week-key"></span> Projects you\u2019re on</p>';
    return html;
  }

  function setView(v){
    view = v === 'week' ? 'week' : 'list';
    Array.prototype.forEach.call(document.querySelectorAll('.view-btn'), function(b){ b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === view)); });
    try { localStorage.setItem(VIEW_KEY, view); } catch (e){}
    render();
  }
  Array.prototype.forEach.call(document.querySelectorAll('.view-btn'), function(b){
    b.addEventListener('click', function(){ setView(b.getAttribute('data-view')); });
  });
  try { view = localStorage.getItem(VIEW_KEY) === 'week' ? 'week' : 'list'; setView(view); } catch (e){}



  el('meetings').addEventListener('click', function(e){
    var btn = e.target.closest('.join-btn');
    if (!btn || btn.disabled) return;
    var id = btn.getAttribute('data-id'), action = btn.getAttribute('data-action');
    var w = list.filter(function(x){ return x.cardId === id; })[0];
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

  BOLD.onUser(function(user){
    me = user;
    if (unsub) { unsub(); unsub = null; }
    if (!user || !db) return;
    unsub = db.collection('projectWorkspaces').onSnapshot(function(snap){
      list = snap.docs.map(function(d){ return Object.assign({ cardId: d.id }, d.data()); });
      loaded = true;
      render();
    }, function(err){
      console.error('[BOLD Lab] loading the meetings failed', err);
      el('meetMsg').textContent = 'Could not load the meetings.';
    });
  });
})();
