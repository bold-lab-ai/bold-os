// An event's header — title, dates, place, description — from events/{slug}
// (see events-common.js): the whole of an event added from the events page
// (event.html?event=<slug>), or the top of an event with its own page
// (#eventBody's data-event, e.g. Collaboration Week). PIs/admins, and whoever added
// it, edit it in place or delete it for good; PIs/admins release or hide it; those
// buttons are always shown, greyed out for everyone else. A hidden event can't be read
// by anyone else (firestore.rules), so for them it's "not found" — as is one that was
// deleted, and then the rest of its page (<main>) is hidden too.
(function(){
  var esc = BOLD.escapeHtml;
  var E = window.BoldEvents;
  var body = document.getElementById('eventBody');
  if (!body || !BOLD.getAuth()) return;
  var db = null;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var slug = body.getAttribute('data-event') || new URLSearchParams(location.search).get('event') || '';
  var ref = slug ? db.collection('events').doc(slug) : null;
  var rest = document.querySelector('main');
  // Its days, time slots and sessions (event-sessions.js), under the header.
  var schedEl = document.getElementById('eventSchedule');
  var types = JSON.parse((document.getElementById('eventTypes') || {}).textContent || '{}');
  var schedule = schedEl && ref ? EventSessions.mount(schedEl, slug, types) : null;
  function drawSchedule(){ if (schedule && x) schedule.update(x, fullWrite, me); }

  var x = null, loaded = false, editing = false, fullWrite = false, me = null;
  // The recurring event it's an edition of (eventSeries; series.html), if any.
  var series = null, seriesFor = '';
  function loadSeries(){
    var id = (x && x.series) || '';
    if (id === seriesFor) return;
    seriesFor = id; series = null;
    if (!id) return;
    db.collection('eventSeries').doc(id).get().then(function(d){
      if (seriesFor !== id) return;
      series = d.exists ? d.data() : null;
      // On event.html, an occurrence of a series without a page of its own: the series' switcher.
      if (series && !body.getAttribute('data-series') && window.SeriesEditions) SeriesEditions.mount(id, slug, false);
      showProposals(); if (!editing) render();
    }).catch(function(){});
  }
  // Its proposals, when its recurring event takes them.
  var propsEl = document.getElementById('eventProposals'), proposals = null;
  function showProposals(){
    if (!propsEl) return;
    var on = !!(series && series.proposals && x && !x.page);
    propsEl.hidden = !on;
    if (!on || proposals) return;
    document.getElementById('eventPropose').href = 'event-collaboration-week-propose.html?event=' + encodeURIComponent(slug);
    proposals = EventProposals.mount(document.getElementById('eventProposalsList'), slug);
    proposals.update(me);
  }
  function seriesLine(){
    if (!series || document.getElementById('editionSwitch')) return '';   // the switcher says it
    var cad = series.cadence || { every: 1, unit: 'month' };
    var c = cad.unit === 'month' && cad.every === 12 ? 'every year' : 'every ' + (cad.every > 1 ? cad.every + ' ' + cad.unit + 's' : cad.unit);
    return '<p class="event-series">An edition of <a href="series.html?series=' + encodeURIComponent(series.id) + '">' + esc(series.title) + '</a>, ' + c + ' · <a href="series.html?series=' + encodeURIComponent(series.id) + '">all editions</a></p>';
  }
  // The projects that presented at the event, and adding it to one (project-links.js).
  var links = window.BoldProjectLinks ? BoldProjectLinks.create({
    field: 'id', slug: slug,
    occasion: function(){ return x ? { kind: 'event', id: slug, label: x.title || slug } : null; },
    prefill: function(){ return x ? { title: x.title, date: x.startDate } : {}; },
    onChange: function(){ if (!editing) render(); }
  }) : null;
  var BACK = '<a class="back-link" href="events.html">&larr; All events</a>';

  function paragraphs(s){
    return String(s || '').split(/\n\s*\n/).map(function(p){ return p.trim(); }).filter(Boolean)
      .map(function(p){ return '<p class="hero-note">' + esc(p).replace(/\n/g, '<br>') + '</p>'; }).join('');
  }

  // Whoever added it edits and deletes it, if the table still lets them edit Events.
  function mine(){
    var organises = !!(series && me && (series.organisers || []).indexOf(me.email.toLowerCase()) >= 0);
    return !!(x && me && ((x.createdBy && x.createdBy === me.email) || organises) && BOLD.can('events', 'edit'));
  }
  function canChange(){ return fullWrite || mine(); }
  function controls(){
    var off = canChange() ? '' : ' disabled title="' + E.NOT_PI + '"';
    var offRelease = fullWrite ? '' : ' disabled title="' + E.NOT_PI_RELEASE + '"';
    return '<div class="event-controls"><button type="button" class="btn-text ev-edit"' + off + '>Edit</button>' +
      '<button type="button" class="btn-text ev-visibility"' + offRelease + '>' + (x.hidden ? 'Release' : 'Hide') + '</button>' +
      '<button type="button" class="btn-text danger ev-delete"' + off + '>Delete</button></div>';
  }

  function render(){
    if (!loaded) return;
    if (rest) rest.hidden = !x;
    if (!x) {
      document.title = 'Event not found | BOLD Lab';
      body.innerHTML = BACK + '<h1>Event not found</h1><p class="hero-note">It may have been deleted, or not be released yet.</p>';
      return;
    }
    document.title = x.title + ' | BOLD Lab';
    if (editing) {
      body.innerHTML = BACK + '<div class="event-form">' + E.formHtml(x) +
        '<div class="event-form-actions"><button type="button" class="ev-save">Save</button><button type="button" class="ev-cancel">Cancel</button></div></div>';
      var form = body.querySelector('.event-form');
      form.querySelector('.ev-cancel').addEventListener('click', function(){ editing = false; render(); });
      form.querySelector('.ev-save').addEventListener('click', function(){
        var r = E.read(form);
        if (r.error) { E.showError(form, r.error); return; }
        var save = form.querySelector('.ev-save');
        save.disabled = true;
        ref.update(Object.assign(r.fields, { updatedAt: Date.now(), updatedBy: me.email })).then(function(){
          editing = false; render();
        }).catch(function(err){
          console.error('[BOLD Events] saving the event failed', err);
          E.showError(form, 'Couldn’t save — try again.');
          save.disabled = false;
        });
      });
      return;
    }
    var past = E.isPast(x);
    body.innerHTML = BACK +
      (x.hidden ? '<p class="event-hidden-note">Hidden — only PIs and admins' + (mine() ? ', and you,' : '') + ' can see this event until a PI or admin releases it.</p>' : '') +
      '<div><span class="eyebrow">' + (past ? 'Past' : 'Upcoming') + '</span></div>' +
      '<h1>' + esc(x.title) + '</h1>' +
      '<p class="hero-when">' + esc(E.when(x.startDate, x.endDate)) + (x.place ? ' &middot; ' + esc(x.place) : '') + '</p>' +
      seriesLine() +
      paragraphs(x.description) +
      controls() + (links ? links.lineHtml() : '');
    body.querySelector('.ev-edit').addEventListener('click', function(){ if (canChange()) { editing = true; render(); } });
    body.querySelector('.ev-visibility').addEventListener('click', function(){
      if (!fullWrite) return;
      if (!x.hidden && !window.confirm('Hide “' + x.title + '”? Only PIs and admins will see it until it’s released again.')) return;
      ref.update({ hidden: !x.hidden, updatedAt: Date.now(), updatedBy: me.email }).catch(function(err){
        console.error('[BOLD Events] changing the event’s visibility failed', err);
        window.alert('Couldn’t change that — try again.');
      });
    });
    body.querySelector('.ev-delete').addEventListener('click', function(){
      if (!canChange() || !window.confirm('Delete “' + x.title + '” for good? This can’t be undone.')) return;
      ref.delete().then(function(){ location.href = 'events.html'; }).catch(function(err){
        console.error('[BOLD Events] deleting the event failed', err);
        window.alert('Couldn’t delete the event — try again.');
      });
    });
  }

  var unsubscribe = null;
  BOLD.onUser(function(user){
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    me = user ? { email: user.email || '' } : null;
    fullWrite = false;
    if (!user) { if (schedule) schedule.update(x, false, null); return; }
    if (!ref) { loaded = true; render(); return; }
    E.access(function(ok){ fullWrite = ok; render(); drawSchedule(); });
    BOLD.onAccess(function(){ if (!editing) render(); });
    if (links) links.load(user);
    unsubscribe = ref.onSnapshot(function(doc){
      x = doc.exists ? doc.data() : null;
      // An event with its own page (Collaboration Week, the Festival) reached at
      // event.html?event=<slug>, e.g. from the Network or a tag: go there.
      // An edition of a series with its own page: that page, on this edition.
      if (x && x.page && !body.getAttribute('data-event') && /^[a-z0-9-]+\.html(\?edition=[a-z0-9-]+)?$/.test(x.page)) {
        location.replace(x.page.split('?')[0] + '?edition=' + encodeURIComponent(slug) + location.hash); return;
      }
      loaded = true;
      loadSeries();
      if (!editing) render();
      drawSchedule();
    }, function(err){
      console.error('[BOLD Events] loading the event failed', err);
      loaded = true; x = null; render();
    });
  });
})();
