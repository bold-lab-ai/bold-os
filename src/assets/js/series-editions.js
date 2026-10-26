// A series' own page (the Festival's, Collaboration week's: #eventBody[data-series]) shows
// one of its occurrences (an events/{slug} edition with that `series`): ?edition=<slug>,
// else the next one coming up, else the latest; data-event is the first, for before it
// loads. Runs before pages/event.js, which draws that edition (header, schedule, sessions).
// Above the header, #editionSwitch switches between them (1st, 2nd…, by month), with a
// link to the series' page on series.html for its organisers (schedule the next one).
// Anything marked data-edition="<slug>" shows only on that edition.
(function(){
  var body = document.getElementById('eventBody');
  if (!body || !body.getAttribute('data-series')) return;
  var esc = BOLD.escapeHtml;
  var series = body.getAttribute('data-series');
  var want = '';
  try { want = new URLSearchParams(location.search).get('edition') || ''; } catch (e){}
  if (/^[a-z0-9-]{1,80}$/.test(want)) body.setAttribute('data-event', want); else want = '';
  var slug = body.getAttribute('data-event');
  Array.prototype.forEach.call(document.querySelectorAll('[data-edition]'), function(el){ el.hidden = el.getAttribute('data-edition') !== slug; });

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function ordinal(n){ var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function href(e){ return location.pathname.replace(/^.*\//, '') + '?edition=' + encodeURIComponent(e.slug) + location.hash; }

  function draw(editions){
    var nav = document.getElementById('editionSwitch');
    if (!nav || editions.length < 1) return;
    nav.innerHTML = editions.map(function(e, i){
      var label = ordinal(i + 1) + ' · ' + MONTHS[+e.startDate.slice(5, 7) - 1] + ' ' + e.startDate.slice(0, 4);
      return '<a href="' + esc(href(e)) + '"' + (e.slug === slug ? ' class="is-current" aria-current="page"' : '') + '>' + esc(label) + (e.hidden ? ' · hidden' : '') + '</a>';
    }).join('') + '<a class="ed-manage" href="series.html?series=' + encodeURIComponent(series) + '">The series &rarr;</a>';
    nav.hidden = false;
  }

  BOLD.onUser(function(user){
    if (!user || !firebase.firestore) return;
    var db = firebase.firestore(BOLD.getApp());
    var col = db.collection('events').where('series', '==', series);
    // PIs, admins and its organisers see the hidden ones too; everyone else, the released.
    col.get().catch(function(){ return col.where('hidden', '==', false).get(); }).then(function(snap){
      var editions = snap.docs.map(function(d){ return d.data(); }).filter(function(e){ return e.slug && /^\d{4}-\d{2}-\d{2}$/.test(e.startDate || ''); })
        .sort(function(a, b){ return a.startDate < b.startDate ? -1 : 1; });
      if (!want) {
        var today = new Date().toISOString().slice(0, 10), released = editions.filter(function(e){ return !e.hidden; });
        var best = released.filter(function(e){ return (e.endDate || e.startDate) >= today; })[0] || released[released.length - 1];
        if (best && best.slug !== slug) { location.replace(href(best)); return; }
      }
      draw(editions);
    }).catch(function(err){ console.error('[BOLD Events] loading the series’ editions failed', err); });
  });
})();
