// A Collaboration Week talk's page. Every talk works the same way, whether
// it comes from the programme (src/_data, inlined as #talkData, the static
// first paint) or was added from its session's page (no programme entry;
// shown by the one page event-collaboration-week-talk.html?talk=<slug>).
// Firestore's collabWeekTalks/{slug} holds an added talk whole, and a
// programme talk's edits since.
//
// A presenter, a lead of the session or a PI/admin gets "Edit talk": title,
// type, speakers, duration, affiliation, presentation, notes, abstract, bio.
// The speakers are people (collab-week-speakers.js) — their emails are who
// counts as a presenter — and only leads and PIs/admins change them, or
// remove the talk from its session (a programme talk can be restored).
// Saving goes through the editTalk function, which also says what the
// signed-in person may do. The talk's time isn't edited: it follows from
// its session's order and durations (collab-week-talk-times.js).
(function(){
  // A keynote's or an oral's one talk is shown by its session's page.
  var own = JSON.parse(document.getElementById('talkData').textContent);
  if (own && (own.sessionType === 'keynote' || own.sessionType === 'oral') && (own.sessionTalks || []).length === 1) {
    location.replace('event-collaboration-week-session-' + own.sessionSlug + '.html');
    return;
  }
  if (!BOLD.getAuth()) return;

  var esc = BOLD.escapeHtml;
  var el = function(id){ return document.getElementById(id); };
  var bodyEl = el('talkBody');
  var base = JSON.parse(el('talkData').textContent);
  var added = !base;        // an added talk: base comes from its Firestore doc
  var slug = added ? (new URLSearchParams(location.search).get('talk') || '') : base.slug;
  var missing = false;      // an added talk that doesn't exist (any more)
  var venue = JSON.parse(el('talkLocation').textContent) || {};
  var TYPES = JSON.parse(el('talkTypes').textContent) || {};

  var db = null;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){}
  function editTalk(data){ return firebase.app().functions('europe-west2').httpsCallable('editTalk')(data); }

  var NOT_EDITOR = 'Only the talk’s presenters, the session’s leads, PIs and admins can edit it';
  var NOT_REMOVER = 'Only the session’s leads, PIs and admins can remove a talk';
  var TALK_TYPES = ['research-talk', 'pitch'];  // as in functions/index.js

  // The form, in order; the Speakers picker goes after the type.
  var FIELDS = [
    { key: 'title', label: 'Title', input: 'text' },
    { key: 'type', label: 'Type', input: 'select', options: TALK_TYPES },
    { key: 'duration', label: 'Duration (minutes)', input: 'number', placeholder: 'e.g. 10', hint: 'Its time follows from its place in the session’s talk order.' },
    { key: 'affiliation', label: 'Affiliation', input: 'text' },
    { key: 'presentationUrl', label: 'Presentation', input: 'text', placeholder: 'https://…', hint: 'Slides, a shared doc or a recording.' },
    { key: 'notes', label: 'Notes', input: 'text' },
    { key: 'abstract', label: 'Abstract', input: 'area', rows: 10 },
    { key: 'bio', label: 'About the speaker', input: 'area', rows: 6 }
  ];

  var saved = null, canEdit = false, canSetPresenters = false, editing = false, busy = false, error = '';
  var people = [];          // the `people` roster, for the speakers picker
  var speakerRows = [];     // the speakers while the form is open
  var timed = null;         // the talk's time, once worked out

  // An added talk's session, venue and back link, from its Firestore doc.
  function useAddedDoc(doc){
    var sessions = JSON.parse(el('talkSessions').textContent) || [];
    var locations = JSON.parse(el('talkLocations').textContent) || [];
    var s = sessions.filter(function(x){ return x.slug === doc.sessionSlug; })[0] || {};
    venue = locations.filter(function(l){ return l.slug === s.locationSlug; })[0] || {};
    base = { slug: slug, sessionSlug: doc.sessionSlug, sessionTitle: s.title || '', day: s.day || '',
      sessionTime: s.time || '', sessionTalks: s.talks || [] };
    var back = el('talkBack');
    if (back && s.slug) { back.href = 'event-collaboration-week-session-' + s.slug + '.html'; back.textContent = '← Back to ' + (s.title || 'the session'); }
    document.title = (doc.title || 'Talk') + ' | BOLD Collaboration Week';
    // A session added from the schedule page isn't in the programme: its details are in Firestore.
    if (!s.slug && doc.sessionSlug) db.collection('collabWeekSessions').doc(doc.sessionSlug).get().then(function(snap){
      var x = snap.data();
      if (!x) return;
      venue = locations.filter(function(l){ return l.slug === x.locationSlug; })[0] || {};
      Object.assign(base, { sessionTitle: x.title || '', day: x.day || '', sessionTime: x.time || '' });
      if (back) { back.href = 'event-collaboration-week-session.html?session=' + encodeURIComponent(doc.sessionSlug); back.textContent = '← Back to ' + (x.title || 'the session'); }
      loadTime();
      if (!editing) render();
    }).catch(function(err){ console.error('[BOLD Collaboration Week] loading the session failed', err); });
  }

  // A programme session has its own page; one added from the schedule shares one.
  function sessionHref(sessionSlug){
    var sessions = JSON.parse((el('talkSessions') || {}).textContent || 'null');
    var inProgramme = !added || (sessions || []).some(function(x){ return x.slug === sessionSlug; });
    return inProgramme ? 'event-collaboration-week-session-' + sessionSlug + '.html'
      : 'event-collaboration-week-session.html?session=' + encodeURIComponent(sessionSlug);
  }

  var peoplePromise = null;
  function loadPeople(){
    if (!peoplePromise) peoplePromise = db.collection('people').get().then(function(snap){
      people = snap.docs.map(function(d){ return d.data(); }).filter(function(p){ return p.email; })
        .sort(function(a, b){ return (a.name || '').localeCompare(b.name || ''); });
    }).catch(function(err){ console.error('[BOLD Collaboration Week] loading the roster failed', err); });
    return peoplePromise;
  }

  function talk(){
    var t = Object.assign({}, base, saved || {});
    t.time = timed !== null ? timed : added ? '' : t.time;
    return t;
  }

  // The speakers to start the form with: as saved; or, for a programme talk
  // not edited yet, its speaker names (matched to the roster by name) plus
  // anyone already given access as a presenter.
  function startSpeakerRows(){
    var t = talk();
    if (t.speakers) { speakerRows = CollabWeekSpeakers.rowsFrom(t.speakers, people); return; }
    var fold = function(s){ return String(s || '').trim().toLowerCase(); };
    var list = String(t.speaker || '').split(/,|&|\band\b/).map(function(n){ return n.trim(); }).filter(Boolean).map(function(name){
      var p = people.filter(function(x){ return fold(x.name) === fold(name); })[0];
      return { name: p ? p.name : name, email: p ? p.email : '' };
    });
    (t.presenterEmails || []).forEach(function(e){
      if (list.some(function(x){ return x.email === e; })) return;
      var p = people.filter(function(x){ return x.email === e; })[0];
      list.push({ name: p ? p.name : e, email: e });
    });
    speakerRows = CollabWeekSpeakers.rowsFrom(list, people);
  }

  function viewHtml(){
    if (missing) return '<p class="detail-muted">This talk doesn’t exist — it may have been removed from its session.</p>';
    if (!base) return '<p class="detail-muted">Loading…</p>';
    var t = talk();
    var removeOff = !t.sessionSlug ? 'Talks on the main schedule can’t be removed here' : canSetPresenters ? '' : NOT_REMOVER;
    var html = (TYPES[t.type] ? '<span class="type-badge type-' + esc(t.type) + '">' + esc(TYPES[t.type]) + '</span>' : '') +
      '<div class="detail-head"><h2>' + esc(t.title) + '</h2><div class="detail-actions">' +
      (t.removed
        ? '<button class="btn" type="button" id="talkRestore"' + (canSetPresenters ? '' : ' disabled title="' + esc(NOT_REMOVER) + '"') + '>Restore talk</button>'
        : '<button class="btn" type="button" id="talkRemove"' + (removeOff ? ' disabled title="' + esc(removeOff) + '"' : '') + '>Remove talk</button>') +
      '<button class="btn" type="button" id="editOpen"' + (canEdit ? '' : ' disabled title="' + esc(NOT_EDITOR) + '"') + '>Edit talk</button>' +
      '</div></div>';
    if (t.removed) html += '<p class="detail-msg">This talk was removed from its session, so it isn’t on the programme.</p>';
    html += '<dl class="detail-grid">';
    if (t.speaker) html += '<dt>Speaker</dt><dd>' + esc(t.speaker) + (t.affiliation ? ' <span class="detail-muted">(' + esc(t.affiliation) + ')</span>' : '') + '</dd>';
    if (t.sessionSlug) html += '<dt>Session</dt><dd><a href="' + esc(sessionHref(t.sessionSlug)) + '">' + esc(t.sessionTitle) + '</a></dd>';
    if (t.day) html += '<dt>When</dt><dd>' + esc(t.day) + (t.time ? ', ' + esc(t.time) : '') + '</dd>';
    if (venue.name) html += '<dt>Where</dt><dd>' + esc(venue.name) +
      (venue.mapsUrl ? ' &middot; <a href="' + esc(venue.mapsUrl) + '" target="_blank" rel="noopener">Open in Google Maps</a>' : '') +
      (venue.address ? '<span class="meta">' + esc(venue.address) + '</span>' : '') + '</dd>';
    if (t.duration) html += '<dt>Duration</dt><dd>' + esc(t.duration) + '</dd>';
    if (t.notes) html += '<dt>Notes</dt><dd>' + esc(t.notes) + '</dd>';
    if (t.presentationUrl) html += '<dt>Presentation</dt><dd class="talk-pres"><a href="' + esc(t.presentationUrl) + '" target="_blank" rel="noopener">' + esc(t.presentationUrl) + '</a></dd>';
    html += '</dl><div class="detail-field"><p class="detail-field-label">Abstract</p>' +
      (t.abstract ? '<p class="talk-text">' + esc(t.abstract) + '</p>' : '<p class="detail-muted">Abstract not yet available.</p>') + '</div>' +
      '<div class="detail-field"><p class="detail-field-label">About the speaker</p>' +
      (t.bio ? '<p class="talk-text">' + esc(t.bio) + '</p>' : '<p class="detail-muted">Not yet available.</p>') + '</div>';
    return html;
  }

  function speakersHtml(){
    return '<div class="edit-field"><span class="edit-label">Speakers</span>' + (canSetPresenters
      ? '<div id="talkSpeakers"></div>'
      : '<p class="edit-static">' + esc(talk().speaker || '—') + '</p><p class="edit-hint">Only the session’s leads, PIs and admins can change the speakers.</p>') + '</div>';
  }

  function formHtml(){
    var t = talk();
    var html = '<div class="detail-head"><h2>Edit talk</h2></div>' +
      '<p class="detail-subtitle">' + esc(t.day || '') + (t.time ? ', ' + esc(t.time) : '') + '</p><div class="edit-form">';
    FIELDS.forEach(function(f){
      var id = 'f_' + f.key, v = t[f.key] || '';
      if (f.input === 'number') v = CollabWeekTalkTimes.minutesOf(v) || '';
      html += '<div class="edit-field"><label for="' + id + '">' + esc(f.label) + '</label>' +
        (f.input === 'select'
          ? '<select id="' + id + '">' + (v ? '' : '<option value="">Choose…</option>') + f.options.map(function(o){
              return '<option value="' + esc(o) + '"' + (o === v ? ' selected' : '') + '>' + esc(TYPES[o] || o) + '</option>';
            }).join('') + '</select>'
          : f.input === 'area'
          ? '<textarea id="' + id + '" rows="' + f.rows + '">' + esc(v) + '</textarea>'
          : '<input type="' + f.input + '" id="' + id + '" value="' + esc(v) + '"' + (f.input === 'number' ? ' min="1" step="1"' : '') + ' placeholder="' + esc(f.placeholder || '') + '">') +
        (f.hint ? '<p class="edit-hint">' + esc(f.hint) + '</p>' : '') + '</div>';
      if (f.key === 'type') html += speakersHtml();
    });
    return html + '</div><div class="field-error" id="editError"' + (error ? '' : ' hidden') + '>' + esc(error) + '</div>' +
      '<div class="edit-actions"><button class="btn btn-primary" type="button" id="editSave"' + (busy ? ' disabled' : '') + '>Save</button>' +
      '<button class="btn" type="button" id="editCancel"' + (busy ? ' disabled' : '') + '>Cancel</button></div>';
  }

  function render(){
    bodyEl.innerHTML = editing ? formHtml() : viewHtml();
    if (!editing) {
      var open = el('editOpen');
      if (open) open.addEventListener('click', openForm);
      var rm = el('talkRemove');
      if (rm) rm.addEventListener('click', function(){ setRemoved(true); });
      var rs = el('talkRestore');
      if (rs) rs.addEventListener('click', function(){ setRemoved(false); });
      return;
    }
    if (canSetPresenters) CollabWeekSpeakers.mount(el('talkSpeakers'), speakerRows, people);
    el('editSave').addEventListener('click', save);
    el('editCancel').addEventListener('click', function(){ editing = false; error = ''; render(); });
  }

  function openForm(){
    loadPeople().then(function(){ startSpeakerRows(); editing = true; error = ''; render(); });
  }

  // Removes the talk from its session (an added one for good), or restores a programme talk.
  function setRemoved(remove){
    var msg = !remove ? null : added ? 'Remove this talk from its session? This can’t be undone.'
      : 'Remove this talk from its session? A lead or PI can restore it from this page.';
    if (msg && !window.confirm(msg)) return;
    var btn = el(remove ? 'talkRemove' : 'talkRestore');
    btn.disabled = true;
    editTalk(remove ? { slug: slug, remove: true } : { slug: slug, restore: true }).then(function(){
      if (remove) { location.href = sessionHref(base.sessionSlug); return; }
      saved = Object.assign({}, saved || {}, { removed: false });
      render();
    }).catch(function(err){
      window.alert((err && err.message) || 'Couldn’t do that — try again.');
      btn.disabled = false;
    });
  }

  function readFields(){
    var edits = {};
    FIELDS.forEach(function(f){ edits[f.key] = el('f_' + f.key).value.trim(); });
    if (!edits.type) delete edits.type;  // a programme talk with no type yet, left unchosen
    edits.duration = Number(edits.duration) > 0 ? Math.round(Number(edits.duration)) + ' min' : '';
    return edits;
  }

  function save(){
    if (busy) return;
    var edits = readFields();
    var spk = canSetPresenters ? CollabWeekSpeakers.toSave(speakerRows) : null;
    if (!edits.title) error = 'The title can’t be empty.';
    else if (spk && spk.error) error = spk.error;
    else if (edits.presentationUrl && !/^https?:\/\/\S+$/.test(edits.presentationUrl)) error = 'The presentation isn’t a link — paste the full https://… address.';
    else error = '';
    if (error) { keepTyped(edits); return; }
    // An unparseable programme duration ("10–20 min") left alone stays as it was.
    if (!edits.duration && !CollabWeekTalkTimes.minutesOf(talk().duration)) delete edits.duration;
    busy = true; keepTyped(edits);
    var payload = Object.assign({}, edits);
    if (spk) payload.speakers = spk.speakers;
    editTalk({ slug: slug, edits: payload }).then(function(r){
      saved = Object.assign({}, saved || {}, r.data.saved);
      busy = false; editing = false; render();
      loadTime();
    }).catch(function(err){
      busy = false; error = (err && err.message) || 'Couldn’t save — try again.'; keepTyped(edits);
    });
  }

  // Re-render the form (to show busy/error) without losing what was typed.
  function keepTyped(edits){
    render();
    FIELDS.forEach(function(f){
      el('f_' + f.key).value = f.input === 'number' ? (CollabWeekTalkTimes.minutesOf(edits[f.key]) || '') : (edits[f.key] || '');
    });
  }

  // This talk's time, worked out with the rest of its session's talks: their
  // edits, the ones added on the site and the session's talkOrder
  // (collab-week-talk-times.js, as on the session page).
  function loadTime(){
    if (!base || !base.sessionSlug) return;
    Promise.all([
      db.collection('collabWeekSessions').doc(base.sessionSlug).get(),
      db.collection('collabWeekTalks').where('sessionSlug', '==', base.sessionSlug).get()
    ]).then(function(res){
      var order = res[0].exists ? res[0].data().talkOrder : null;
      var docs = res[1].docs.map(function(d){ return d.data(); });
      var mine = CollabWeekTalkTimes.schedule(base.sessionTalks, docs, order, base.sessionTime)
        .filter(function(t){ return t.slug === slug; })[0];
      timed = mine ? mine.time : '';
      if (!editing) render();
    }).catch(function(err){ console.error('[BOLD Collaboration Week] working out the talk’s time failed', err); });
  }

  BOLD.onUser(function(user){
    canEdit = false; canSetPresenters = false; editing = false;
    if (!user || !db) { render(); return; }
    db.collection('collabWeekTalks').doc(slug).get().then(function(snap){
      saved = snap.exists ? snap.data() : null;
      if (added) {
        missing = !saved || !saved.added;
        if (!missing) { useAddedDoc(saved); loadTime(); }
      }
      if (!editing) render();
    }).catch(function(err){ console.error('[BOLD Collaboration Week] loading the talk failed', err); });
    if (!added) loadTime();
    editTalk({ slug: slug }).then(function(r){
      canEdit = !!r.data.canEdit;
      canSetPresenters = !!r.data.canSetPresenters;
      if (!editing) render();
    }).catch(function(err){ console.error('[BOLD Collaboration Week] editTalk access check failed', err); });
  });
})();
