// An event's schedule with its sessions — event-schedule.js's days and time
// slots, with the slots of sessions filled in: a card per session
// (collabWeekSessions with this eventSlug), linking to its page
// (session.html?session=<slug>). A keynote's or an oral's card names its one
// talk's speaker (collabWeekTalks); the rest name the session's leads.
//
// The pencil on a card opens the session's page with its edit form open
// (session.html?session=<slug>#edit), for whoever may edit it: its leads, a
// keynote's or an oral's speakers, PIs and admins.
//
// PIs/admins also change the programme here: "+ Add a session" in a slot
// adds one; × on a card removes it (marked `removed`, shown to them faded,
// with ↺ to restore it and Delete to delete it and its talks for good —
// deleteSession, which also takes it out of its slot). All are always shown,
// greyed out for everyone else (firestore.rules).
//
// While the event is on, the schedule opens on what's on now: today's slot
// that is under way, or else the next one to start (breaks and meals
// included); before the first and after the last, today's day. Leaves the
// page alone if the visitor has already scrolled.
window.EventSessions = (function(){
  var esc = BOLD.escapeHtml;
  var SESSION_TYPES = ['workshop', 'keynote', 'oral', 'panel', 'welcome'];
  var SOLO = ['keynote', 'oral'];  // a session that is one talk
  var NOT_PI = 'Only PIs and admins can change the programme';
  var NOT_EDITOR = 'Only the session’s leads, PIs and admins can edit it';
  var PENCIL = EventSchedule.PENCIL;
  function callable(name){ return firebase.app().functions('europe-west2').httpsCallable(name); }

  // host: where the days go; eventSlug; types: badge labels (collabWeekTypes).
  // → { update(event, fullWrite, me) } — called with the event doc as it changes.
  function mount(host, eventSlug, types){
    var db = firebase.firestore(BOLD.getApp());
    var event = null, docs = {}, talksBySession = {}, fullWrite = false, me = null;
    var sessionsLoaded = false, talksLoaded = false, unsubscribers = [];

    function venueOf(slug){ return ((event && event.venues) || []).filter(function(l){ return l.slug === slug; })[0] || {}; }

    function cardHtml(slug){
      var s = docs[slug];
      if (!s) return '';
      var talks = (talksBySession[slug] || []).filter(function(t){ return !t.removed; });
      var t = SOLO.indexOf(s.type) >= 0 && talks.length === 1 ? talks[0] : null;
      var loc = venueOf(s.locationSlug);
      var removed = !!s.removed;
      var who = t ? (t.speaker || '') + (t.affiliation ? ' · ' + t.affiliation : '')
        : (s.leads || []).map(function(l){ return l.name; }).join(', ');
      var mine = me && me.email ? me.email.toLowerCase() : '';
      var canEdit = fullWrite || (!!mine && ((s.leadEmails || []).indexOf(mine) >= 0 || (t && (t.presenterEmails || []).indexOf(mine) >= 0)));
      return '<a class="session-card' + (removed ? ' is-removed' : '') + '" href="session.html?session=' + encodeURIComponent(slug) + '" data-session="' + esc(slug) + '"' + (removed && !fullWrite ? ' hidden' : '') + '>' +
        (types[s.type] ? '<span class="type-badge type-' + esc(s.type) + '">' + esc(types[s.type]) + '</span>' : '<span></span>') +
        '<span class="session-title">' + esc(t ? t.title : s.title) + '</span>' +
        '<span class="session-who">' + esc(who) + '</span>' +
        '<span class="session-where">' + esc(loc.name || '') + (s.room ? (loc.name ? ' &middot; ' : '') + esc(s.room) : '') + '</span>' +
        '<span class="card-edit' + (canEdit ? '' : ' is-off') + '" role="button" tabindex="0" aria-label="Edit this session"' +
          ' title="' + (canEdit ? 'Edit this session' : (t ? 'Only its speakers, the session’s leads, PIs and admins can edit it' : NOT_EDITOR)) + '">' + PENCIL + '</span>' +
        '<span class="card-x' + (fullWrite ? '' : ' is-off') + '" role="button" tabindex="0"' +
          ' aria-label="' + (removed ? 'Restore this session' : 'Remove this session') + '"' +
          ' title="' + (fullWrite ? (removed ? 'Put this session back on the schedule' : 'Remove this session from the schedule') : NOT_PI) + '">' + (removed ? '↺' : '×') + '</span>' +
        (removed && fullWrite ? '<span class="card-delete" role="button" tabindex="0" title="Delete this session and its talks for good">Delete</span>' : '') +
        '</a>';
    }

    function markRemoved(slug, removed){
      return db.collection('collabWeekSessions').doc(slug).update({ removed: removed, updatedAt: Date.now(), updatedBy: me.email });
    }

    // Deletes sessions for good (their talks too), one after another.
    function deleteSessions(slugs){
      return slugs.reduce(function(chain, slug){
        return chain.then(function(){
          return (!docs[slug] || docs[slug].removed ? Promise.resolve() : markRemoved(slug, true))
            .then(function(){ return docs[slug] ? callable('deleteSession')({ slug: slug }) : null; });
        });
      }, Promise.resolve());
    }

    function onCardControl(ctl){
      if (!fullWrite) return;
      var card = ctl.closest('.session-card');
      var slug = card.getAttribute('data-session');
      var title = card.querySelector('.session-title').textContent;
      var done;
      if (ctl.classList.contains('card-delete')) {
        if (!window.confirm('Delete “' + title + '” for good? Its talks, edits and leads are deleted too. This can’t be undone.')) return;
        ctl.textContent = 'Deleting…';
        done = callable('deleteSession')({ slug: slug });
      } else if (docs[slug].removed) done = markRemoved(slug, false);
      else {
        if (!window.confirm('Remove “' + title + '” from the schedule? You can put it back with ↺, or delete it for good.')) return;
        done = markRemoved(slug, true);
      }
      done.catch(function(err){
        console.error('[BOLD Events] changing the schedule failed', err);
        window.alert((err && err.message) || 'Couldn’t change the schedule — try again.');
        refresh();
      });
    }

    // The pencil: the session's page, with its edit form open.
    function onEdit(btn){
      if (btn.classList.contains('is-off')) return;
      location.href = 'session.html?session=' + encodeURIComponent(btn.closest('.session-card').getAttribute('data-session')) + '#edit';
    }

    host.addEventListener('click', function(e){
      var pen = e.target.closest('.card-edit');
      if (pen) { e.preventDefault(); e.stopPropagation(); onEdit(pen); return; }
      var ctl = e.target.closest('.card-x, .card-delete');
      if (ctl) { e.preventDefault(); e.stopPropagation(); onCardControl(ctl); }
    });
    host.addEventListener('keydown', function(e){
      var pen = e.target.closest && e.target.closest('.card-edit');
      if (pen && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onEdit(pen); return; }
      var ctl = e.target.closest && e.target.closest('.card-x, .card-delete');
      if (ctl && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onCardControl(ctl); }
    });

    // --- adding a session to a slot -------------------------------------------------

    function addSession(box, day, slot, close){
      var venues = (event && event.venues) || [];
      box.innerHTML = '<div class="session-add-form">' +
        '<p class="session-add-head">New session, ' + esc(EventSchedule.dayLabel(day.date)) + (slot.start ? ' ' + esc(EventSchedule.slotTime(slot)) : '') + '</p>' +
        '<label>Title<input type="text" class="sa-title"></label>' +
        '<label>Type<select class="sa-type">' + SESSION_TYPES.map(function(t){ return '<option value="' + t + '">' + esc(types[t] || t) + '</option>'; }).join('') + '</select></label>' +
        '<div class="session-add-row">' +
        (venues.length ? '<label>Venue<select class="sa-venue">' + venues.map(function(l){ return '<option value="' + esc(l.slug) + '">' + esc(l.name) + '</option>'; }).join('') + '</select></label>' : '') +
        '<label>Room<input type="text" class="sa-room" placeholder="optional"></label></div>' +
        '<p class="session-add-hint">Then open it to add the rest: leads, abstract and talks — or, for a keynote or an oral, its speaker and abstract.</p>' +
        '<p class="session-add-error" hidden></p>' +
        '<div class="session-add-actions"><button type="button" class="sa-save">Add session</button><button type="button" class="sa-cancel">Cancel</button></div></div>';
      var q = function(c){ return box.querySelector(c); };
      q('.sa-title').focus();
      q('.sa-cancel').addEventListener('click', function(){ close(); refresh(); });
      q('.sa-save').addEventListener('click', function(){
        var title = q('.sa-title').value.trim();
        var errBox = q('.session-add-error');
        if (!title) { errBox.textContent = 'Give the session a title.'; errBox.hidden = false; return; }
        var stem = title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'session';
        var slug = stem + '-' + Math.random().toString(16).slice(2, 8);
        var now = Date.now();
        var type = q('.sa-type').value;
        q('.sa-save').disabled = true;
        db.collection('collabWeekSessions').doc(slug).set({
          slug: slug, eventSlug: eventSlug, title: title, type: type,
          locationSlug: q('.sa-venue') ? q('.sa-venue').value : '', room: q('.sa-room').value.trim(),
          leads: [], leadEmails: [], createdAt: now, createdBy: me.email, updatedAt: now, updatedBy: me.email
        }).then(function(){
          return schedule.addToSlot(day.id, slot.id, slug);
        }).then(function(){
          // A keynote or an oral is one talk: add it now, with the session's title.
          if (SOLO.indexOf(type) >= 0) return callable('createTalk')({ sessionSlug: slug, title: title, type: 'research-talk' });
        }).then(function(){ close(); refresh(); }).catch(function(e){
          console.error('[BOLD Events] adding a session failed', e);
          errBox.textContent = 'Couldn’t add the session — try again.'; errBox.hidden = false;
          q('.sa-save').disabled = false;
        });
      });
    }

    // --- scrolling to what's on now -----------------------------------------------------

    var scrolled = false;
    function scrollToNow(){
      if (scrolled) return;
      scrolled = true;
      var now = new Date();
      var pad = function(n){ return (n < 10 ? '0' : '') + n; };
      var today = host.querySelector('.day-card[data-date="' + now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + '"]');
      if (!today || host.closest('[hidden]')) return;
      // '13:45–15:00' → [825, 900] (minutes), or null.
      var span = function(text){
        var m = /(\d{1,2})[:.](\d{2})\s*[–—-]\s*(\d{1,2})[:.](\d{2})/.exec(text || '');
        return m ? [m[1] * 60 + Number(m[2]), m[3] * 60 + Number(m[4])] : null;
      };
      var mins = now.getHours() * 60 + now.getMinutes();
      var slots = Array.prototype.slice.call(today.querySelectorAll('.slot')).filter(function(sl){ return !sl.hidden; })
        .map(function(sl){ var t = sl.querySelector('.slot-time').firstChild; return { el: sl, t: span(t && t.textContent) }; })
        .filter(function(x){ return x.t; });
      var on = slots.filter(function(x){ return x.t[0] <= mins && mins < x.t[1]; });
      var next = slots.filter(function(x){ return x.t[0] > mins; }).sort(function(a, b){ return a.t[0] - b.t[0]; })[0];
      var target = on.length ? on[on.length - 1].el : next && slots[0].t[0] < mins ? next.el : today;
      requestAnimationFrame(function(){
        if (window.scrollY < 40 && !host.closest('[hidden]')) target.scrollIntoView({ block: 'start' });
      });
    }

    var schedule = EventSchedule.mount(host, {
      ref: db.collection('events').doc(eventSlug),
      sessionCards: function(slot){ return (slot.sessions || []).map(cardHtml).join(''); },
      addSession: addSession,
      deleteSessions: deleteSessions,
      onRender: function(){ if (me && sessionsLoaded && talksLoaded) scrollToNow(); }
    });
    function refresh(){ if (event) schedule.update(event, fullWrite, me); }

    function watch(){
      unsubscribers.push(db.collection('collabWeekSessions').where('eventSlug', '==', eventSlug).onSnapshot(function(snap){
        docs = {};
        snap.forEach(function(doc){ docs[doc.id] = doc.data(); });
        sessionsLoaded = true;
        refresh();
      }, function(err){ console.error('[BOLD Events] loading the sessions failed', err); }));
      unsubscribers.push(db.collection('collabWeekTalks').onSnapshot(function(snap){
        talksBySession = {};
        snap.forEach(function(doc){
          var t = doc.data();
          if (t.sessionSlug) (talksBySession[t.sessionSlug] = talksBySession[t.sessionSlug] || []).push(t);
        });
        talksLoaded = true;
        refresh();
      }, function(err){ console.error('[BOLD Events] loading the talks failed', err); }));
    }

    return {
      update: function(ev, canWrite, user){
        var signedIn = !!user;
        if (!signedIn) { unsubscribers.forEach(function(u){ u(); }); unsubscribers = []; }
        else if (!unsubscribers.length) watch();
        event = ev; fullWrite = !!canWrite; me = user;
        refresh();
      }
    };
  }

  return { mount: mount };
})();
