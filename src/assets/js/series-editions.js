// An event series is its page: its own (the Festival's, Collaboration week's:
// #eventBody[data-series]) or event.html for one without, showing one occurrence (an
// events/{slug} with that `series`) at a time. On its own page that's ?edition=<slug>,
// else the next coming up, else the latest (data-event is the first, for before it loads);
// this runs before pages/event.js, which draws it. On event.html it's ?event=<slug>, and
// pages/event.js mounts this once it knows the event's series (SeriesEditions.mount).
// #editionSwitch, above the header: the occurrences (1st, 2nd…, by month), then for its
// organisers, PIs and admins (eventSeries, functions/series.js) a "+" to add one by hand
// (its dates; a hidden occurrence, released as any event), and Release while the series
// is hidden.
// Anything marked data-edition="<slug>" shows only on that occurrence.
window.SeriesEditions = (function(){
  var esc = BOLD.escapeHtml;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function ordinal(n){ var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function addMonths(iso, n){
    var p = iso.split('-').map(Number), t = new Date(Date.UTC(p[0], p[1] - 1 + n, 1));
    var last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(Math.min(p[2], last));
    return t.toISOString().slice(0, 10);
  }
  function addDays(iso, n){ var t = new Date(iso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
  function addPeriod(iso, c){ return c && c.unit === 'week' ? addDays(iso, 7 * c.every) : addMonths(iso, (c && c.every) || 1); }
  var mounted = false;

  // id: the series; slug: the occurrence shown; own: on the series' own page (?edition=) or event.html (?event=).
  function mount(id, slug, own){
    var nav = document.getElementById('editionSwitch');
    if (mounted || !nav) return;
    mounted = true;
    var db = firebase.firestore(BOLD.getApp()), me = null, s = null, editions = [], planning = null, busy = false;
    var page = location.pathname.replace(/^.*\//, '') || 'event.html';
    function href(e){ return own ? page + '?edition=' + encodeURIComponent(e.slug) : 'event.html?event=' + encodeURIComponent(e.slug); }
    function canChange(){ return !!(s && me && (BOLD.isFullWrite() || (s.organisers || []).indexOf(me.email.toLowerCase()) >= 0)); }
    function call(data){ return firebase.app().functions('europe-west2').httpsCallable('eventSeries')(data); }

    function draw(){
      var links = editions.map(function(e, i){
        var label = ordinal(i + 1) + ' · ' + MONTHS[+e.startDate.slice(5, 7) - 1] + ' ' + e.startDate.slice(0, 4);
        return '<a href="' + esc(href(e)) + '"' + (e.slug === slug ? ' class="is-current" aria-current="page"' : '') + '>' + esc(label) + (e.hidden ? ' · hidden' : '') + '</a>';
      }).join('') + (canChange() && !planning ? '<button type="button" class="ed-plan" title="Add an occurrence" aria-label="Add an occurrence">+</button>' : '');
      var tools = canChange() && s.hidden ? '<span class="ed-tools"><span class="ed-hidden">Series hidden</span>' +
          '<button type="button" class="btn-text ed-release">Release</button></span>' : '';
      var form = planning ? '<div class="event-form ed-form"><p class="event-form-head">A new occurrence of ' + esc(s.title) + '</p>' +
          '<div class="ev-row"><label>Starts<input type="date" class="ed-start" value="' + esc(planning.start) + '"></label>' +
          '<label>Ends<input type="date" class="ed-end" value="' + esc(planning.end) + '"></label></div>' +
          BoldEvents.inviteSelectHtml('ed-invite', planning.inviteGroup) +
          '<p class="event-form-hint">It starts hidden, with the place and description of the last one; you build its programme here, then release it: Google Calendar then invites the group chosen.</p>' +
          '<p class="ev-error"' + (planning.error ? '' : ' hidden') + '>' + esc(planning.error || '') + '</p>' +
          '<div class="event-form-actions"><button type="button" class="ev-save ed-go"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Adding…' : 'Add it') + '</button>' +
          '<button type="button" class="ed-cancel">Cancel</button></div></div>' : '';
      nav.innerHTML = '<div class="ed-row">' + links + tools + '</div>' + form;
      nav.hidden = !editions.length && !canChange();
    }

    function openPlanning(){
      var last = editions[editions.length - 1];
      var start = last ? addPeriod(last.startDate, s.cadence) : new Date().toISOString().slice(0, 10);
      var today = new Date().toISOString().slice(0, 10);
      if (start < today) start = today;
      var length = last ? Math.round((Date.parse(last.endDate || last.startDate) - Date.parse(last.startDate)) / 86400000) : 0;
      planning = { start: start, end: addDays(start, length), inviteGroup: s.inviteGroup || 'none', error: '' };
      draw();
    }
    nav.addEventListener('click', function(ev){
      var t = ev.target.closest('button');
      if (!t || t.disabled) return;
      if (t.classList.contains('ed-plan')) { openPlanning(); return; }
      if (t.classList.contains('ed-cancel')) { planning = null; draw(); return; }
      if (t.classList.contains('ed-release')) {
        BOLD.confirmAction({ title: 'Release ' + s.title + '?', go: 'Release', effects: ['Show the series to the lab on Events'], always: true }).then(function(ok){
          if (ok) call({ action: 'release', id: id }).then(function(){ s.hidden = false; draw(); }).catch(function(err){ window.alert((err && err.message) || 'Couldn’t release it — try again.'); });
        });
        return;
      }
      if (t.classList.contains('ed-go')) {
        planning.start = nav.querySelector('.ed-start').value; planning.end = nav.querySelector('.ed-end').value || planning.start;
        planning.inviteGroup = nav.querySelector('.ed-invite').value;
        if (!planning.start || planning.end < planning.start) { planning.error = 'Give its first and last day, the last on or after the first.'; draw(); return; }
        busy = true; planning.error = ''; draw();
        call({ action: 'nextEdition', id: id, startDate: planning.start, endDate: planning.end, inviteGroup: planning.inviteGroup }).then(function(r){
          location.href = href({ slug: r.data.slug });
        }).catch(function(err){ busy = false; planning.error = (err && err.message) || 'Couldn’t schedule it — try again.'; draw(); });
      }
    });

    BOLD.onAccess(function(){ if (s) draw(); });
    BOLD.onUser(function(user){
      me = user;
      if (!user) return;
      db.collection('eventSeries').doc(id).get().then(function(d){ s = d.exists ? d.data() : null; draw(); }).catch(function(){});
      var col = db.collection('events').where('series', '==', id);
      // PIs, admins and its organisers see the hidden ones too; everyone else, the released.
      col.get().catch(function(){ return col.where('hidden', '==', false).get(); }).then(function(snap){
        editions = snap.docs.map(function(d){ return d.data(); }).filter(function(e){ return e.slug && /^\d{4}-\d{2}-\d{2}$/.test(e.startDate || ''); })
          .sort(function(a, b){ return a.startDate < b.startDate ? -1 : 1; });
        if (own && !chosen) {
          var today = new Date().toISOString().slice(0, 10), released = editions.filter(function(e){ return !e.hidden; });
          var best = released.filter(function(e){ return (e.endDate || e.startDate) >= today; })[0] || released[released.length - 1];
          if (best && best.slug !== slug) { location.replace(href(best) + location.hash); return; }
        }
        draw();
      }).catch(function(err){ console.error('[BOLD Events] loading the series’ occurrences failed', err); });
    });
  }

  // On a series' own page: choose the occurrence now, before pages/event.js reads data-event.
  var body = document.getElementById('eventBody'), chosen = '';
  if (body && body.getAttribute('data-series')) {
    try { chosen = new URLSearchParams(location.search).get('edition') || ''; } catch (e){}
    if (/^[a-z0-9-]{1,80}$/.test(chosen)) body.setAttribute('data-event', chosen); else chosen = '';
    var shown = body.getAttribute('data-event');
    Array.prototype.forEach.call(document.querySelectorAll('[data-edition]'), function(el){ el.hidden = el.getAttribute('data-edition') !== shown; });
    mount(body.getAttribute('data-series'), shown, true);
  }
  return { mount: mount };
})();
