(function(){
  // The masthead, gate and sidebar are bold.js's; this page lists every project's
  // recurring meeting (projectWorkspaces, see projectWorkspace in functions/index.js)
  // by weekday, with Join and Leave.
  if (!BOLD.getAuth()) return;

  var el = function(id){ return document.getElementById(id); };
  var esc = BOLD.escapeHtml;
  var db = null, me = null, list = [], busy = {}, msgs = {}, unsub = null;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){}

  function isMe(email){ return !!(me && me.email && String(email).toLowerCase() === me.email.toLowerCase()); }

  function projectUrl(w){
    return 'project.html#id=' + encodeURIComponent(w.cardId) + (w.boardId ? '&board=' + encodeURIComponent(w.boardId) : '');
  }

  function render(){
    var withMeeting = list.filter(function(w){ return w.meeting; });
    if (!withMeeting.length) {
      el('meetMsg').textContent = 'No project has a meeting yet.';
      el('meetMsg').hidden = false; el('meetings').hidden = true;
      return;
    }
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
    el('meetings').innerHTML = html;
    el('meetings').hidden = false; el('meetMsg').hidden = true;
  }

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
      render();
    }, function(err){
      console.error('[BOLD Lab] loading the meetings failed', err);
      el('meetMsg').textContent = 'Could not load the meetings.';
    });
  });
})();
