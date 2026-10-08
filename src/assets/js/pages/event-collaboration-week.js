// Tabs — independent of Firebase, so switching between Schedule and
// Proposals works even if Firebase fails to load. Neither panel is
// hidden in the raw HTML (progressive enhancement: no-JS visitors see
// both, stacked, rather than losing whichever tab isn't picked), so this
// runs on load to pick a starting tab and hide the other.
(function(){
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var panels = { schedule: document.getElementById('panelSchedule'), proposals: document.getElementById('panelProposals') };
  function activate(name, pushHash){
    buttons.forEach(function(b){
      var on = b.getAttribute('data-tab') === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Object.keys(panels).forEach(function(k){ panels[k].hidden = k !== name; });
    if (pushHash !== false) history.replaceState(null, '', '#' + name);
  }
  buttons.forEach(function(b){
    b.addEventListener('click', function(){ activate(b.getAttribute('data-tab')); });
  });
  var initial = (location.hash || '').slice(1);
  activate(panels[initial] ? initial : 'schedule', false);

  // During the week, the schedule opens on what's on now: today's slot that
  // is under way, or else the next one to start (breaks and meals included);
  // before the first and after the last, today's day. Waits for sign-in,
  // since the page stays hidden until then, and leaves the page alone if
  // the visitor has already scrolled.
  var now = new Date();
  var pad = function(n){ return (n < 10 ? '0' : '') + n; };
  var today = document.querySelector('.day-card[data-date="' + now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + '"]');
  if (!today || panels.schedule.hidden || !BOLD.getAuth()) return;

  // '13:45–15:00' → [825, 900] (minutes), or null.
  function span(text){
    var m = /(\d{1,2})[:.](\d{2})\s*[–—-]\s*(\d{1,2})[:.](\d{2})/.exec(text || '');
    return m ? [m[1] * 60 + Number(m[2]), m[3] * 60 + Number(m[4])] : null;
  }
  function target(){
    var mins = now.getHours() * 60 + now.getMinutes();
    var slots = Array.prototype.slice.call(today.querySelectorAll('.slot')).filter(function(sl){ return !sl.hidden; })
      .map(function(sl){ return { el: sl, t: span(sl.querySelector('.slot-time').textContent) }; })
      .filter(function(x){ return x.t; });
    var on = slots.filter(function(x){ return x.t[0] <= mins && mins < x.t[1]; });
    if (on.length) return on[on.length - 1].el;  // the latest-starting of overlapping ones
    var next = slots.filter(function(x){ return x.t[0] > mins; })
      .sort(function(a, b){ return a.t[0] - b.t[0]; })[0];
    return next && slots[0].t[0] < mins ? next.el : today;
  }

  var done = false;
  BOLD.onUser(function(user){
    if (!user || done) return;
    done = true;
    requestAnimationFrame(function(){
      if (window.scrollY < 40 && !panels.schedule.hidden) target().scrollIntoView({ block: 'start' });
    });
  });
})();

// Schedule — the cards are built from the programme
// (src/_data/collabWeekSessions.js, collabWeekResearchTalks.js); edits
// since live in Firestore and are laid over them here: a session's (title,
// leads, room) from collabWeekSessions, a morning talk's (title, type,
// speakers, affiliation) from collabWeekTalks.
//
// PIs/admins also change the programme here: × on a session card removes
// it (marked `removed`, shown to them faded, with ↺ to restore it and Delete
// to delete it and its talks from Firestore for good — deleteSession), and
// "+ Add a session" under a day adds one (collabWeekSessions with added: true — its page is
// event-collaboration-week-session.html?session=<slug>). Both are always
// shown, greyed out for everyone else (firestore.rules).
(function(){
  var esc = BOLD.escapeHtml;
  var panel = document.getElementById('panelSchedule');
  if (!panel || !BOLD.getAuth()) return;
  var db = null;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){ return; }
  var json = function(id){ return JSON.parse(document.getElementById(id).textContent) || []; };
  var TYPES = json('scheduleTypes');
  var LOCATIONS = json('scheduleLocations');
  var PROGRAMME = {};
  json('scheduleSessions').forEach(function(x){ PROGRAMME[x.slug] = x; });
  var SESSION_TYPES = ['workshop', 'keynote', 'oral', 'panel', 'welcome'];
  var SOLO = ['keynote', 'oral'];  // a session that is one talk
  var NOT_PI = 'Only PIs and admins can change the programme';

  var docs = {};            // collabWeekSessions, by slug
  var fullWrite = false;    // PI or admin (getMyAccess)
  var me = null;

  function locationOf(slug){ return LOCATIONS.filter(function(l){ return l.slug === slug; })[0] || {}; }
  function startOf(time){ var m = /(\d{1,2})[:.](\d{2})/.exec(time || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; }
  function sameTime(a, b){ return String(a).replace(/\s|[-–—]/g, '') === String(b).replace(/\s|[-–—]/g, ''); }

  function addedCardHtml(x){
    var loc = locationOf(x.locationSlug);
    return '<a class="session-card" data-added="1" href="event-collaboration-week-session.html?session=' + encodeURIComponent(x.slug) + '"' +
      ' data-session="' + esc(x.slug) + '" data-venue="' + esc(loc.name || '') + '">' +
      (TYPES[x.type] ? '<span class="type-badge type-' + esc(x.type) + '">' + esc(TYPES[x.type]) + '</span>' : '<span></span>') +
      '<span class="session-title">' + esc(x.title) + '</span>' +
      '<span class="session-who">' + esc((x.leads || []).map(function(l){ return l.name; }).join(', ')) + '</span>' +
      '<span class="session-where">' + esc(loc.name || '') + (x.room ? ' &middot; ' + esc(x.room) : '') + '</span></a>';
  }

  // Puts an added session into its day: beside another at the same time, or in a new slot in time order.
  function placeAdded(x){
    var day = panel.querySelector('.day-card[data-date="' + x.date + '"]');
    if (!day) return;
    var slots = Array.prototype.slice.call(day.querySelectorAll('.slot:not(.slot-logistics)'));
    var same = slots.filter(function(sl){ return sameTime(sl.querySelector('.slot-time').textContent, x.time); })[0];
    if (!same) {
      same = document.createElement('div');
      same.className = 'slot';
      same.setAttribute('data-added-slot', '1');
      same.innerHTML = '<div class="slot-time">' + esc(x.time) + '</div><div class="slot-sessions"></div>';
      var after = Array.prototype.slice.call(day.querySelectorAll('.slot')).filter(function(sl){
        return startOf(sl.querySelector('.slot-time').textContent) > startOf(x.time);
      })[0];
      day.insertBefore(same, after || day.querySelector('.day-add'));
    }
    same.querySelector('.slot-sessions').insertAdjacentHTML('beforeend', addedCardHtml(x));
  }

  function render(){
    Array.prototype.forEach.call(panel.querySelectorAll('.session-card[data-added]'), function(c){ c.remove(); });
    Array.prototype.forEach.call(panel.querySelectorAll('.slot[data-added-slot]'), function(sl){ sl.remove(); });
    Object.keys(docs).map(function(k){ return docs[k]; })
      .filter(function(x){ return x.added && x.date; })
      .sort(function(a, b){ return (a.createdAt || 0) - (b.createdAt || 0); })
      .forEach(placeAdded);

    Array.prototype.forEach.call(panel.querySelectorAll('.session-card[data-session]'), function(card){
      var slug = card.getAttribute('data-session'), x = docs[slug] || {};
      if (!card.hasAttribute('data-added')) {
        if (x.title && !card.hasAttribute('data-talk')) card.querySelector('.session-title').textContent = x.title;
        if (x.type && TYPES[x.type]) {
          var badge = card.querySelector('.type-badge');
          badge.className = 'type-badge type-' + x.type;
          badge.textContent = TYPES[x.type];
        }
        if (x.leads) card.querySelector('.session-who').textContent = x.leads.map(function(l){ return l.name; }).join(', ');
        if (x.room !== undefined) card.querySelector('.session-where').innerHTML =
          esc(card.getAttribute('data-venue')) + (x.room ? ' &middot; ' + esc(x.room) : '');
      }
      var removed = !!x.removed;
      card.hidden = removed && !fullWrite;
      card.classList.toggle('is-removed', removed);
      var ctl = card.querySelector('.card-x') || card.appendChild(document.createElement('span'));
      ctl.className = 'card-x' + (fullWrite ? '' : ' is-off');
      ctl.setAttribute('role', 'button');
      ctl.setAttribute('tabindex', '0');
      ctl.textContent = removed ? '↺' : '×';
      ctl.setAttribute('aria-label', removed ? 'Restore this session' : 'Remove this session');
      ctl.title = fullWrite ? (removed ? 'Put this session back on the schedule' : 'Remove this session from the schedule') : NOT_PI;
      var del = card.querySelector('.card-delete');
      if (removed && fullWrite && !del) {
        del = card.appendChild(document.createElement('span'));
        del.className = 'card-delete';
        del.setAttribute('role', 'button');
        del.setAttribute('tabindex', '0');
        del.textContent = 'Delete';
        del.title = 'Delete this session and its talks for good';
      } else if (del && !(removed && fullWrite)) del.remove();
    });

    // A slot with several visible sessions lays them out side by side; one with none is hidden.
    Array.prototype.forEach.call(panel.querySelectorAll('.slot:not(.slot-logistics)'), function(sl){
      var box = sl.querySelector('.slot-sessions');
      var shown = box.querySelectorAll('.session-card:not([hidden])').length;
      box.classList.toggle('is-parallel', shown > 1);
      sl.hidden = shown === 0;
    });

    Array.prototype.forEach.call(panel.querySelectorAll('.day-add'), function(btn){
      btn.disabled = !fullWrite;
      btn.title = fullWrite ? '' : NOT_PI;
    });
  }

  function onCardControl(ctl){
    if (!fullWrite) return;
    var slug = ctl.closest('.session-card').getAttribute('data-session');
    var x = docs[slug], ref = db.collection('collabWeekSessions').doc(slug);
    var title = ctl.closest('.session-card').querySelector('.session-title').textContent;
    var who = { updatedAt: Date.now(), updatedBy: me.email };
    var done;
    if (ctl.classList.contains('card-delete')) {
      if (!window.confirm('Delete “' + title + '” for good? Its talks, edits and leads are deleted too. This can’t be undone.')) return;
      ctl.textContent = 'Deleting…';
      done = firebase.app().functions('europe-west2').httpsCallable('deleteSession')({ slug: slug });
    } else if (x && x.removed) done = ref.update(Object.assign({ removed: false }, who));
    else if (x && x.added) {
      if (!window.confirm('Remove “' + title + '” from the schedule? You can put it back with ↺, or delete it for good.')) return;
      done = ref.update(Object.assign({ removed: true }, who));
    } else {
      if (!window.confirm('Remove “' + title + '” from the schedule? You can put it back with ↺, or delete it for good.')) return;
      // The first doc for a programme session also records its leads, as the session page does.
      var p = PROGRAMME[slug] || {};
      var seed = x ? {} : { slug: slug, leads: p.leads || [],
        leadEmails: (p.leads || []).map(function(l){ return String(l.email || '').toLowerCase(); }).filter(Boolean) };
      done = ref.set(Object.assign(seed, { removed: true }, who), { merge: true });
    }
    done.catch(function(err){
      console.error('[BOLD Collaboration Week] changing the schedule failed', err);
      window.alert((err && err.message) || 'Couldn’t change the schedule — try again.');
      render();
    });
  }

  panel.addEventListener('click', function(e){
    var ctl = e.target.closest('.card-x, .card-delete');
    if (ctl) { e.preventDefault(); e.stopPropagation(); onCardControl(ctl); return; }
    var add = e.target.closest('.day-add');
    if (add && !add.disabled) openAddForm(add.closest('.day-card'));
  });
  panel.addEventListener('keydown', function(e){
    var ctl = e.target.closest && e.target.closest('.card-x, .card-delete');
    if (ctl && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onCardControl(ctl); }
  });

  // --- adding a session --------------------------------------------------------

  function openAddForm(day){
    var open = panel.querySelector('.session-add-form');
    if (open) open.remove();
    var form = document.createElement('div');
    form.className = 'session-add-form';
    form.innerHTML =
      '<p class="session-add-head">New session on ' + esc(day.getAttribute('data-label')) + '</p>' +
      '<label>Title<input type="text" class="sa-title"></label>' +
      '<label>Type<select class="sa-type">' + SESSION_TYPES.map(function(t){ return '<option value="' + t + '">' + esc(TYPES[t] || t) + '</option>'; }).join('') + '</select></label>' +
      '<div class="session-add-row"><label>Starts<input type="time" class="sa-start" step="300"></label>' +
      '<label>Ends<input type="time" class="sa-end" step="300"></label></div>' +
      '<div class="session-add-row"><label>Venue<select class="sa-venue">' + LOCATIONS.map(function(l){ return '<option value="' + esc(l.slug) + '">' + esc(l.name) + '</option>'; }).join('') + '</select></label>' +
      '<label>Room<input type="text" class="sa-room" placeholder="optional"></label></div>' +
      '<p class="session-add-hint">Then open it to add the rest: leads, abstract and talks — or, for a keynote or an oral, its speaker and abstract.</p>' +
      '<p class="session-add-error" hidden></p>' +
      '<div class="session-add-actions"><button type="button" class="sa-save">Add session</button><button type="button" class="sa-cancel">Cancel</button></div>';
    day.insertBefore(form, day.querySelector('.day-add'));
    var q = function(c){ return form.querySelector(c); };
    q('.sa-title').focus();
    q('.sa-cancel').addEventListener('click', function(){ form.remove(); });
    q('.sa-save').addEventListener('click', function(){
      var title = q('.sa-title').value.trim(), start = q('.sa-start').value, end = q('.sa-end').value;
      var err = !title ? 'Give the session a title.' : !start || !end ? 'Set when it starts and ends.' : end <= start ? 'It has to end after it starts.' : '';
      var box = q('.session-add-error');
      if (err) { box.textContent = err; box.hidden = false; return; }
      var stem = title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'session';
      var slug = stem + '-' + Math.random().toString(16).slice(2, 8);
      var now = Date.now();
      q('.sa-save').disabled = true;
      var type = q('.sa-type').value;
      db.collection('collabWeekSessions').doc(slug).set({
        added: true, slug: slug, title: title, type: type,
        date: day.getAttribute('data-date'), day: day.getAttribute('data-label'), time: start + '–' + end,
        locationSlug: q('.sa-venue').value, room: q('.sa-room').value.trim(),
        leads: [], leadEmails: [], createdAt: now, createdBy: me.email, updatedAt: now, updatedBy: me.email
      }).then(function(){
        // A keynote or an oral is one talk: add it now, with the session's title.
        if (SOLO.indexOf(type) >= 0) return firebase.app().functions('europe-west2').httpsCallable('createTalk')({ sessionSlug: slug, title: title, type: 'research-talk' });
      }).then(function(){ form.remove(); }).catch(function(e){
        console.error('[BOLD Collaboration Week] adding a session failed', e);
        box.textContent = 'Couldn’t add the session — try again.'; box.hidden = false;
        q('.sa-save').disabled = false;
      });
    });
  }

  // --- data --------------------------------------------------------------------

  var unsubscribe = null, unsubscribeTalks = null;
  BOLD.onUser(function(user){
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (unsubscribeTalks) { unsubscribeTalks(); unsubscribeTalks = null; }
    me = user ? { email: user.email || '' } : null;
    fullWrite = false;
    if (!user) return;
    firebase.app().functions('europe-west2').httpsCallable('getMyAccess')().then(function(r){
      fullWrite = !!(r.data && r.data.fullWrite);
      render();
    }).catch(function(err){ console.error('[BOLD Collaboration Week] access check failed', err); });
    unsubscribeTalks = db.collection('collabWeekTalks').onSnapshot(function(snap){
      snap.forEach(function(doc){
        var t = doc.data();
        Array.prototype.forEach.call(document.querySelectorAll('.session-card[data-talk="' + doc.id + '"]'), function(card){
          if (t.title) card.querySelector('.session-title').textContent = t.title;
          if (t.type && TYPES[t.type] && !card.hasAttribute('data-session')) {  // a keynote's card shows the session's type
            var b = card.querySelector('.type-badge');
            b.className = 'type-badge type-' + t.type;
            b.textContent = TYPES[t.type];
          }
          if (t.speaker !== undefined || t.affiliation !== undefined) card.querySelector('.session-who').textContent =
            (t.speaker !== undefined ? t.speaker : card.getAttribute('data-speaker')) + (t.affiliation ? ' · ' + t.affiliation : '');
        });
      });
    }, function(err){ console.error('[BOLD Collaboration Week] loading talk edits failed', err); });
    unsubscribe = db.collection('collabWeekSessions').onSnapshot(function(snap){
      docs = {};
      snap.forEach(function(doc){ docs[doc.id] = doc.data(); });
      render();
    }, function(err){ console.error('[BOLD Collaboration Week] loading session edits failed', err); });
  });
})();

// Proposals list — read-only here; submitting lives on its own page
// (event-collaboration-week-propose.html) now.
(function(){
  var escapeHtml = BOLD.escapeHtml;

  var els = {
    signedOut: document.getElementById('proposalsSignedOut'),
    signedIn: document.getElementById('proposalsSignedIn'),
    signInBtn: document.getElementById('signInBtn'),
    list: document.getElementById('proposalsList')
  };

  // FIRESTORE_USE_EMULATOR must be false in anything committed — see
  // audit-board.html's own comment on this flag for why (a real production
  // incident the first time it shipped true). Project/config/auth: bold.js.
  var FIRESTORE_USE_EMULATOR = false;

  var db = null, auth = BOLD.getAuth();
  try {
    db = firebase.firestore(BOLD.getApp());
    if (FIRESTORE_USE_EMULATOR) db.useEmulator('localhost', 8080);
  } catch (e){ db = null; }

  if (!db || !auth){
    els.signedOut.innerHTML = '<p>Could not connect &mdash; reload, or check back shortly.</p>';
    return;
  }

  var currentUser = null;
  var NOT_PROPOSER = 'Only whoever proposed it can edit or delete a proposal';
  var unsubscribeProposals = null;

  function renderProposals(docs){
    if (!docs.length){
      els.list.innerHTML = '<p class="proposal-empty">Nothing proposed yet &mdash; be the first.</p>';
      return;
    }
    els.list.innerHTML = docs.map(function(p){
      return '<div class="proposal-card">' +
        '<div class="proposal-top">' +
          '<span class="proposal-title">' + escapeHtml(p.title || '(untitled)') + '</span>' +
          '<span class="proposal-type">' + escapeHtml(p.contributionType || '') + '</span>' +
        '</div>' +
        '<div class="proposal-meta">' +
          '<strong>' + escapeHtml(p.name || 'Someone') + '</strong>' +
          (p.duration ? ' &middot; ' + escapeHtml(p.duration) : '') +
          (p.timeLocation ? ' &middot; ' + escapeHtml(p.timeLocation) : '') +
        '</div>' +
        (p.chair ? '<div class="proposal-meta">Chair: ' + escapeHtml(p.chair) + '</div>' : '') +
        (p.abstract ? '<div class="proposal-note">' + escapeHtml(p.abstract) + '</div>' : '') +
        (p.overallDescription ? '<div class="proposal-note">' + escapeHtml(p.overallDescription) + '</div>' : '') +
        // Always shown; greyed out, with the reason on hover, unless it's your own.
        (currentUser && p.email === currentUser.email
          ? '<div class="proposal-actions">' +
              '<a href="event-collaboration-week-propose.html?edit=' + encodeURIComponent(p.id) + '">Edit</a>' +
              '<button type="button" class="btn-text danger" data-delete-id="' + escapeHtml(p.id) + '">Delete</button>' +
            '</div>'
          : '<div class="proposal-actions">' +
              '<button type="button" class="btn-text" disabled title="' + NOT_PROPOSER + '">Edit</button>' +
              '<button type="button" class="btn-text danger" disabled title="' + NOT_PROPOSER + '">Delete</button>' +
            '</div>') +
      '</div>';
    }).join('');
  }

  function deleteProposal(id, btn){
    // Client-side gate is UX only — the Delete button is only enabled for
    // p.email === currentUser.email above, and firestore.rules enforces
    // the same (email() == resource.data.email || hasFullWrite()) as the
    // actual security boundary.
    if (!window.confirm('Delete this proposal? This can’t be undone.')) return;
    btn.disabled = true;
    db.collection('collabWeekProposals').doc(id).delete().catch(function(err){
      console.error('[BOLD Collaboration Week] delete proposal failed', err);
      window.alert('Could not delete the proposal — try again.');
      btn.disabled = false;
    });
  }

  function watchProposals(){
    if (unsubscribeProposals) return;
    unsubscribeProposals = db.collection('collabWeekProposals').orderBy('createdAt', 'desc').onSnapshot(function(snap){
      var docs = [];
      snap.forEach(function(doc){ var d = doc.data(); d.id = doc.id; docs.push(d); });
      renderProposals(docs);
    }, function(err){
      console.error('[BOLD Collaboration Week] proposals listener failed', err);
      els.list.innerHTML = '<p class="proposal-empty">Could not load proposals &mdash; reload, or check back shortly.</p>';
    });
  }

  function stopWatchingProposals(){
    if (unsubscribeProposals){ unsubscribeProposals(); unsubscribeProposals = null; }
  }

  function renderAuth(){
    if (currentUser){
      els.signedOut.hidden = true;
      els.signedIn.hidden = false;
      watchProposals();
    } else {
      els.signedOut.hidden = false;
      document.documentElement.classList.remove('auth-hint');
      els.signedIn.hidden = true;
      stopWatchingProposals();
    }
  }

  els.signInBtn.addEventListener('click', BOLD.signIn);
  els.list.addEventListener('click', function(e){
    var btn = e.target.closest('[data-delete-id]');
    if (!btn) return;
    deleteProposal(btn.getAttribute('data-delete-id'), btn);
  });
  // Signed in last visit: skip the "sign in" panel while Firebase Auth
  // resolves. BOLD.onUser below stays authoritative and swaps it
  // back if the session has expired.
  try {
    if (localStorage.getItem('boldAuthHint')){
      els.signedOut.hidden = true;
      els.signedIn.hidden = false;
      els.list.innerHTML = '<p class="proposal-empty">Loading&hellip;</p>';
    }
  } catch (e){}
  BOLD.onUser(function(user){
    currentUser = user ? { email: user.email, name: user.displayName } : null;
    renderAuth();
  });
})();
