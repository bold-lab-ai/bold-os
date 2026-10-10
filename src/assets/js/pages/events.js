// Events page — every event is an events/{slug} doc (see events-common.js),
// listed newest first by start date. An event with its own page (`page`,
// e.g. Collaboration Week) links there; the rest to event.html?event=<slug>. "+ Add an event" is always shown,
// greyed out for anyone but a PI/admin. A new event starts hidden — only
// PIs/admins see it, marked "Hidden" — until it's released from its page.
(function(){
  var esc = BOLD.escapeHtml;
  var E = window.BoldEvents;
  var list = document.getElementById('eventList');
  var addBtn = document.getElementById('eventAdd');
  var loading = document.getElementById('eventLoading');
  if (!list || !BOLD.getAuth()) return;
  var db = null;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }

  var events = [], fullWrite = false, me = null;

  function cardHtml(x){
    var past = E.isPast(x);
    var href = x.page || 'event.html?event=' + encodeURIComponent(x.slug);
    return '<a class="event-card' + (x.hidden ? ' is-hidden' : '') + '" href="' + esc(href) + '">' +
      '<div class="event-top"><span class="eyebrow eyebrow--' + (past ? 'past' : 'upcoming') + '">' + (past ? 'Past' : 'Upcoming') + '</span>' +
      (x.hidden ? '<span class="eyebrow eyebrow--hidden">Hidden</span>' : '') + '</div>' +
      '<h3>' + esc(x.title) + '</h3>' +
      '<p class="event-when">' + esc(E.when(x.startDate, x.endDate)) + (x.place ? ' &middot; ' + esc(x.place) : '') + '</p>' +
      (x.description ? '<p>' + esc(x.description.split(/\n\s*\n/)[0]) + '</p>' : '') +
      '<span class="event-cta">See details &rarr;</span></a>';
  }

  function render(){
    list.innerHTML = events.map(function(x){ return '<li>' + cardHtml(x) + '</li>'; }).join('');
    addBtn.disabled = !fullWrite;
    addBtn.title = fullWrite ? '' : E.NOT_PI;
  }

  function openForm(){
    if (document.querySelector('.event-form')) return;
    var form = document.createElement('div');
    form.className = 'event-form';
    form.innerHTML = '<p class="event-form-head">New event</p>' + E.formHtml({}) +
      '<p class="event-form-hint">It stays hidden — only PIs and admins see it — until you release it from its page.</p>' +
      '<div class="event-form-actions"><button type="button" class="ev-save">Add event</button><button type="button" class="ev-cancel">Cancel</button></div>';
    addBtn.parentNode.insertBefore(form, addBtn);
    addBtn.hidden = true;
    var close = function(){ form.remove(); addBtn.hidden = false; };
    form.querySelector('.ev-title').focus();
    form.querySelector('.ev-cancel').addEventListener('click', close);
    form.querySelector('.ev-save').addEventListener('click', function(){
      var r = E.read(form);
      if (r.error) { E.showError(form, r.error); return; }
      var stem = r.fields.title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'event';
      var slug = stem + '-' + Math.random().toString(16).slice(2, 8);
      var now = Date.now();
      var save = form.querySelector('.ev-save');
      save.disabled = true;
      db.collection('events').doc(slug).set(Object.assign({ slug: slug, hidden: true }, r.fields,
        { createdAt: now, createdBy: me.email, updatedAt: now, updatedBy: me.email })).then(close).catch(function(err){
        console.error('[BOLD Events] adding an event failed', err);
        E.showError(form, 'Couldn’t add the event — try again.');
        save.disabled = false;
      });
    });
  }
  addBtn.addEventListener('click', function(){ if (fullWrite) openForm(); });

  var unsubscribe = null, signIns = 0;
  BOLD.onUser(function(user){
    var mine = ++signIns;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    me = user ? { email: user.email || '' } : null;
    fullWrite = false;
    events = [];
    render();
    if (!user) return;
    // Everyone else may only query the released ones (firestore.rules).
    E.access(function(ok){
      if (mine !== signIns) return;
      fullWrite = ok;
      render();
      var query = ok ? db.collection('events') : db.collection('events').where('hidden', '==', false);
      unsubscribe = query.onSnapshot(function(snap){
        loading.hidden = true;
        events = snap.docs.map(function(d){ return d.data(); }).filter(function(x){ return x.slug && x.startDate; })
          .sort(function(a, b){ return a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : 0; });
        render();
      }, function(err){ console.error('[BOLD Events] loading events failed', err); });
    });
  });
})();
