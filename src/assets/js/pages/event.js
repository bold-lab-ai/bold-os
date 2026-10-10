// An event's header — title, dates, place, description — from events/{slug}
// (see events-common.js): the whole of an event added from the events page
// (event.html?event=<slug>), or the top of an event with its own page
// (#eventBody's data-event, e.g. Collaboration Week). PIs/admins edit it in place,
// release or hide it, or delete it for good; those buttons are always shown,
// greyed out for everyone else. A hidden event can't be read by anyone else
// (firestore.rules), so for them it's "not found" — as is one that was
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
  var BACK = '<a class="back-link" href="events.html">&larr; All events</a>';

  function paragraphs(s){
    return String(s || '').split(/\n\s*\n/).map(function(p){ return p.trim(); }).filter(Boolean)
      .map(function(p){ return '<p class="hero-note">' + esc(p).replace(/\n/g, '<br>') + '</p>'; }).join('');
  }

  function controls(){
    var off = fullWrite ? '' : ' disabled title="' + E.NOT_PI + '"';
    return '<div class="event-controls"><button type="button" class="btn-text ev-edit"' + off + '>Edit</button>' +
      '<button type="button" class="btn-text ev-visibility"' + off + '>' + (x.hidden ? 'Release' : 'Hide') + '</button>' +
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
      (x.hidden ? '<p class="event-hidden-note">Hidden — only PIs and admins can see this event until it’s released.</p>' : '') +
      '<div><span class="eyebrow">' + (past ? 'Past' : 'Upcoming') + '</span></div>' +
      '<h1>' + esc(x.title) + '</h1>' +
      '<p class="hero-when">' + esc(E.when(x.startDate, x.endDate)) + (x.place ? ' &middot; ' + esc(x.place) : '') + '</p>' +
      paragraphs(x.description) +
      controls();
    body.querySelector('.ev-edit').addEventListener('click', function(){ if (fullWrite) { editing = true; render(); } });
    body.querySelector('.ev-visibility').addEventListener('click', function(){
      if (!fullWrite) return;
      if (!x.hidden && !window.confirm('Hide “' + x.title + '”? Only PIs and admins will see it until it’s released again.')) return;
      ref.update({ hidden: !x.hidden, updatedAt: Date.now(), updatedBy: me.email }).catch(function(err){
        console.error('[BOLD Events] changing the event’s visibility failed', err);
        window.alert('Couldn’t change that — try again.');
      });
    });
    body.querySelector('.ev-delete').addEventListener('click', function(){
      if (!fullWrite || !window.confirm('Delete “' + x.title + '” for good? This can’t be undone.')) return;
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
    unsubscribe = ref.onSnapshot(function(doc){
      x = doc.exists ? doc.data() : null;
      loaded = true;
      if (!editing) render();
      drawSchedule();
    }, function(err){
      console.error('[BOLD Events] loading the event failed', err);
      loaded = true; x = null; render();
    });
  });
})();
