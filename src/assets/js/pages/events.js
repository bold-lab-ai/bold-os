// Events page, laid out as People is: a search, then groups with their counts —
// Recurring (eventSeries; series.html), Coming up and Past (events/{slug}; see
// events-common.js). An event with its own page (`page`, e.g. Collaboration Week) links
// there; the rest to event.html?event=<slug>, a recurring one to series.html?series=<id>.
// A hidden one (still being planned) shows only to PIs/admins and whoever added or
// organises it, marked Hidden, until a PI or admin releases it.
// "+ Add an event" (series.html?new: once, or recurring) is for Events' Edit level
// (BOLDiquette › Who can see what): always shown, greyed out for everyone else.
(function(){
  var esc = BOLD.escapeHtml;
  var E = window.BoldEvents;
  var root = document.getElementById('eventList');
  var search = document.getElementById('evSearch');
  var seriesAdds = Array.prototype.slice.call(document.querySelectorAll('.series-add'));
  if (!root || !BOLD.getAuth()) return;
  var db = null;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }

  var events = null, series = [], fullWrite = false, me = null;

  function canAdd(){ return fullWrite || BOLD.can('events', 'edit'); }
  function cadenceText(c){
    c = c || { every: 1, unit: 'month' };
    return c.unit === 'month' && c.every === 12 ? 'Every year' : 'Every ' + (c.every > 1 ? c.every + ' ' + c.unit + 's' : c.unit);
  }
  function badge(text){ return ' <span class="badge">' + esc(text) + '</span>'; }
  function row(href, title, meta, badges){
    return '<li><a class="proj-title" href="' + esc(href) + '">' + esc(title) + '</a>' + badges +
      '<span class="proj-meta">' + meta + '</span></li>';
  }
  function eventRow(x){
    return row(x.page || 'event.html?event=' + encodeURIComponent(x.slug), x.title,
      esc(E.when(x.startDate, x.endDate)) + (x.place ? ' · ' + esc(x.place) : ''), x.hidden ? badge('Hidden') : '');
  }
  function seriesRow(x){
    return row('series.html?series=' + encodeURIComponent(x.id), x.title,
      esc(x.kind === 'editions' ? cadenceText(x.cadence) : meetingText(x.meeting) + ' · London time'),
      (x.hidden ? badge('Hidden') : '') + (x.pausedAt ? badge('Paused') : ''));
  }
  function group(label, rows){
    return rows.length ? '<div class="proj-group"><h3>' + esc(label) + '<span class="proj-count">' + rows.length + '</span></h3><ul class="proj-list">' + rows.join('') + '</ul></div>' : '';
  }

  function render(){
    var can = canAdd(), why = can ? '' : BOLD.cannotReason('events', 'edit');
    seriesAdds.forEach(function(a){ a.classList.toggle('is-off', !can); a.title = why; a.setAttribute('aria-disabled', String(!can)); });
    if (events === null) return;
    var q = search.value.trim().toLowerCase();
    var hit = function(x){ return !q || [x.title, x.place, x.description].join(' ').toLowerCase().indexOf(q) !== -1; };
    var evs = events.filter(hit), ss = series.filter(hit);
    var coming = evs.filter(function(x){ return !E.isPast(x); }).sort(function(a, b){ return a.startDate < b.startDate ? -1 : 1; });
    var past = evs.filter(function(x){ return E.isPast(x); }).sort(function(a, b){ return a.startDate < b.startDate ? 1 : -1; });
    var html = group('Recurring', ss.map(seriesRow)) + group('Coming up', coming.map(eventRow)) + group('Past', past.map(eventRow));
    root.innerHTML = html || '<p class="proj-msg">' + (q ? 'Nothing matches.' : 'No events yet.') + '</p>';
  }
  search.addEventListener('input', render);
  BOLD.onAccess(function(){ render(); });

  seriesAdds.forEach(function(a){ a.addEventListener('click', function(e){ if (!canAdd()) e.preventDefault(); }); });

  // Several queries as one list, by key: the rules let everyone else query only the released
  // ones, and the ones they added or organise.
  function watchAll(queries, key, done){
    var got = queries.map(function(){ return []; });
    var unsubs = queries.map(function(query, i){
      return query.onSnapshot(function(snap){
        got[i] = snap.docs.map(function(d){ return d.data(); });
        var seen = {};
        done([].concat.apply([], got).filter(function(x){ if (!x[key] || seen[x[key]]) return false; seen[x[key]] = 1; return true; }));
      }, function(err){ console.error('[BOLD Events] loading failed', err); done(null); });
    });
    return function(){ unsubs.forEach(function(u){ u(); }); };
  }

  var unsubs = [], signIns = 0;
  BOLD.onUser(function(user){
    var mine = ++signIns;
    unsubs.forEach(function(u){ u(); }); unsubs = [];
    me = user ? { email: user.email || '' } : null;
    fullWrite = false; events = null; series = [];
    render();
    if (!user) return;
    E.access(function(ok){
      if (mine !== signIns) return;
      fullWrite = ok;
      var ev = db.collection('events'), se = db.collection('eventSeries');
      unsubs.push(watchAll(ok ? [ev] : [ev.where('hidden', '==', false), ev.where('createdBy', '==', me.email)], 'slug', function(list){
        events = (list || []).filter(function(x){ return x.startDate; }); render();
      }));
      unsubs.push(watchAll(ok ? [se] : [se.where('hidden', '==', false), se.where('organisers', 'array-contains', me.email.toLowerCase())], 'id', function(list){
        series = (list || []).sort(function(a, b){ return a.title.localeCompare(b.title); }); render();
      }));
    });
  });
})();
