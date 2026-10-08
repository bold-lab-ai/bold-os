// A Collaboration Week session's talks, in order and with their times —
// shared by the session page (its talk list) and each talk's own page, so
// both agree.
//
// Order: the programme's talks (src/_data/collabWeekSessions.js), then the
// ones added on the site (oldest first), rearranged by the session's
// `talkOrder` (talk slugs, or titles for talks without a page).
//
// Times: talks run back to back from the session's start ("10 min" →
// 15:30–15:40, 15:40–15:50, …), up to the first talk without a duration;
// that one and the rest get no time. The exception is a session whose
// programme gives its own start times but not every duration: there the
// times stay with their slots and the talks move between them.
window.CollabWeekTalkTimes = (function(){
  function key(t){ return t.slug || t.title; }

  // '15:30–16:45' → 930 (minutes), or null.
  function startOf(sessionTime){
    var m = /(\d{1,2})[:.](\d{2})/.exec(sessionTime || '');
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  // '10 min' / '1 h' / '1.5 hours' / '90' → minutes, or null.
  function minutesOf(duration){
    var m = /^\s*(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minutes)?\s*$/i.exec(duration || '');
    if (!m) return null;
    var n = Number(m[1]) * (/^h/i.test(m[2] || '') ? 60 : 1);
    return n > 0 ? Math.round(n) : null;
  }

  function clock(mins){
    var h = Math.floor(mins / 60) % 24, m = mins % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  // programme: the session's talks from src/_data; added: its talks added on
  // the site; order: its talkOrder; sessionTime: e.g. '15:30–16:45'.
  // → every talk, in order, each with `time` set (or '' if it can't be known).
  function schedule(programme, added, order, sessionTime){
    programme = programme || [];
    var talks = programme.concat((added || []).slice().sort(function(a, b){ return (a.createdAt || 0) - (b.createdAt || 0); }));
    if (order && order.length) {
      var pos = function(t){ var i = order.indexOf(key(t)); return i < 0 ? order.length : i; };
      talks = talks.map(function(t, i){ return { t: t, i: i }; })
        .sort(function(a, b){ return (pos(a.t) - pos(b.t)) || (a.i - b.i); })
        .map(function(x){ return x.t; });
    }
    var mins = talks.map(function(t){ return minutesOf(t.duration); });
    if (programme.some(function(t){ return t.time; }) && !mins.every(Boolean)) {
      return talks.map(function(t, i){ return Object.assign({}, t, { time: i < programme.length ? programme[i].time || '' : '' }); });
    }
    var start = startOf(sessionTime);
    return talks.map(function(t, i){
      if (start == null || !mins[i]) { start = null; return Object.assign({}, t, { time: '' }); }
      var from = start;
      start += mins[i];
      return Object.assign({}, t, { time: clock(from) + '–' + clock(start) });
    });
  }

  return { key: key, schedule: schedule, minutesOf: minutesOf };
})();
