// A session's page, for any event: session.html?session=<slug>, all of it
// from Firestore — the session from collabWeekSessions/{slug}, its talks from
// collabWeekTalks (sessionSlug), and from its event (events/{eventSlug}) its
// day and time (the time slot that holds it, event-schedule.js) and its venue.
// Everyone sees the same page; a lead (their own session) or a PI/admin (any)
// also gets one "Edit session" button that swaps it for a form. Only a
// PI/admin can change who the leads are (firestore.rules). Day, time and venue
// belong to the whole schedule, and each talk has its own page
// (talk.html?talk=<slug>), so neither is edited here.
//
// A keynote or an oral is a session that is one talk: its page shows that
// talk (speaker, abstract, bio, presentation) instead of a talk list, and
// its form edits the talk (editTalk — so its speakers can edit it too)
// alongside the session's type, room and leads. Its time is the session's,
// so it has no duration.
(function(){
  if (!BOLD.getAuth()) return;

  var esc = BOLD.escapeHtml;
  var el = function(id){ return document.getElementById(id); };
  var bodyEl = el('sessionBody');
  var base = { slug: new URLSearchParams(location.search).get('session') || '', title: '', leads: [] };
  var missing = false;      // a session that doesn't exist (any more)
  var venue = {};           // its venue, from its event's venues
  var event = null;         // its event (events/{eventSlug})
  var TYPES = JSON.parse(el('sessionTypes').textContent) || {};

  function badge(type){ return TYPES[type] ? '<span class="type-badge type-' + esc(type) + '">' + esc(TYPES[type]) + '</span>' : ''; }

  var NOT_EDITOR = 'Only the session’s leads, PIs and admins can edit it';
  var db = null, ref = null;
  try {
    db = firebase.firestore(BOLD.getApp());
    ref = base.slug ? db.collection('collabWeekSessions').doc(base.slug) : null;
  } catch (e){}
  if (!ref) missing = true;

  var me = null;            // { email } once signed in
  var saved = null;         // the Firestore doc's data, or null if it doesn't exist (yet)
  var fullWrite = false;    // PI or admin (getMyAccess)
  var editing = false;      // the form is open
  var people = [];          // the `people` roster, for the leads picker
  var leadRows = [];        // in-progress rows while the form is open
  var orderRows = [];       // talk keys, in the order being edited
  var talkEdits = {};       // talk slug → the talk (collabWeekTalks)
  var adding = false, addBusy = false, addError = '';  // the "Add a talk" form
  var addSpeakerRows = [];  // its speakers (collab-week-speakers.js)
  var talkAccess = { canEdit: false, canSetPresenters: false };  // a keynote's/oral's talk (editTalk)
  var soloSpeakerRows = []; // its speakers while the form is open
  // Opened as session.html?session=<slug>#edit (the pencil on the schedule):
  // the form opens once the talks are in and the Edit button turns on.
  var wantEdit = location.hash === '#edit', talksLoaded = false;

  // Its slot's day and time win over any stored on the session (see usePlace).
  function session(){
    var s = Object.assign({}, base, saved || {});
    if (placed) { s.day = placed.day; s.time = placed.time; }
    return s;
  }

  // Every address a lead could sign in with: their own, plus any other roster
  // account under the same name (some people are in Slack twice).
  function emailsOf(leads){
    var out = [];
    (leads || []).forEach(function(l){
      var name = (l.name || '').trim().toLowerCase();
      if (l.email) out.push(l.email.toLowerCase());
      people.forEach(function(p){
        if (name && (p.name || '').trim().toLowerCase() === name && p.email) out.push(p.email.toLowerCase());
      });
    });
    return out.filter(function(e, i){ return out.indexOf(e) === i; });
  }

  function isLead(){
    if (!me || !me.email) return false;
    var emails = saved && saved.leadEmails ? saved.leadEmails : emailsOf(session().leads);
    return emails.indexOf(me.email.toLowerCase()) >= 0;
  }

  function canEdit(){ return !!me && !!saved && (fullWrite || isLead()); }

  function isEmpty(v){ return v == null || v === '' || (Array.isArray(v) && !v.length); }

  // --- the editable fields, in form order ------------------------------------

  // Lists are edited as one entry per line; `|` separates the parts of an entry.
  var FIELDS = [
    { key: 'title', label: 'Title', input: 'text', required: true },
    { key: 'subtitle', label: 'Subtitle', input: 'text' },
    { key: 'room', label: 'Room', input: 'text', placeholder: 'e.g. Seminar Room 2' },
    { key: 'contact', label: 'Contact', input: 'text', placeholder: 'e.g. name@example.com' },
    { key: 'overallDescription', label: 'Abstract', input: 'area' },
    { key: 'problems', label: 'Problems', input: 'area' },
    { key: 'background', label: 'Background', input: 'area' },
    { key: 'keyQuestions', label: 'Key questions', input: 'area', list: true, hint: 'One question per line.' },
    { key: 'aim', label: 'Aim', input: 'area' },
    { key: 'links', label: 'Links', input: 'area', list: true, hint: 'One per line: Label | https://…' },
    { key: 'agenda', label: 'Schedule', input: 'area', list: true, hint: 'One per line: time | activity' }
  ];

  // What the edit form changes, for every kind of session: title, type
  // (PIs/admins), room, leads (PIs/admins), abstract, and the schedule —
  // worked out from the talks when the session has any (the Talk order list
  // below), written by hand (agenda) when it doesn't.
  var EDIT_KEYS = ['title', 'room', 'overallDescription', 'agenda'];
  var SESSION_TYPES = ['workshop', 'keynote', 'oral', 'panel', 'welcome'];
  var SOLO_TYPES = ['keynote', 'oral'];  // a session that is one talk

  // A keynote's or an oral's one talk (with its edits), or null.
  function soloTalk(){
    if (SOLO_TYPES.indexOf(session().type) < 0) return null;
    var talks = allTalks();
    return talks.length === 1 ? talks[0] : null;
  }
  function hasTalks(){ return allTalks().length > 0; }
  function editFields(){
    return FIELDS.filter(function(f){ return EDIT_KEYS.indexOf(f.key) >= 0 && (f.key !== 'agenda' || !hasTalks()); });
  }

  function toText(key, v){
    if (!v) return '';
    if (key === 'keyQuestions') return v.join('\n');
    if (key === 'links') return v.map(function(l){ return l.label + ' | ' + l.url; }).join('\n');
    if (key === 'agenda') return v.map(function(a){
      var what = a.activity + (a.speaker ? ' — ' + a.speaker : '') + (a.duration ? ' (' + a.duration + ')' : '');
      return (a.time ? a.time + ' | ' : '') + what;
    }).join('\n');
    return v;
  }

  // → { value } or { error }
  function fromText(f, text){
    var t = text.trim();
    if (!f.list) {
      if (!t && f.required) return { error: f.label + ' can’t be empty.' };
      return { value: t };
    }
    var lines = t ? t.split('\n').map(function(s){ return s.trim(); }).filter(Boolean) : [];
    if (f.key === 'keyQuestions') return { value: lines };
    if (f.key === 'links') {
      var links = [], bad = null;
      lines.forEach(function(line){
        var i = line.lastIndexOf('|');
        var label = i >= 0 ? line.slice(0, i).trim() : '';
        var url = (i >= 0 ? line.slice(i + 1) : line).trim();
        if (!/^https?:\/\/\S+$/.test(url)) bad = bad || line;
        links.push({ label: label || url, url: url });
      });
      return bad ? { error: 'Links: not a link — “' + bad + '”. Use Label | https://…' } : { value: links };
    }
    return { value: lines.map(function(line){   // agenda
      var i = line.indexOf('|');
      return i >= 0 ? { time: line.slice(0, i).trim(), activity: line.slice(i + 1).trim() } : { time: '', activity: line };
    }) };
  }

  // --- talk order ------------------------------------------------------------
  // A session's talks are its collabWeekTalks docs (talkEdits), less any
  // removed. `talkOrder` orders them (the rest after, oldest first); their
  // times follow from the order and durations (collab-week-talk-times.js).

  var talkKey = CollabWeekTalkTimes.key;

  function orderedTalks(order){
    var docs = Object.keys(talkEdits).map(function(k){ return talkEdits[k]; });
    return CollabWeekTalkTimes.schedule([], docs, order, session().time);
  }

  function allTalks(){ return orderedTalks(null); }

  function orderHtml(){
    var byKey = {};
    allTalks().forEach(function(t){ byKey[talkKey(t)] = t; });
    return orderRows.map(function(k, i){
      var t = byKey[k];
      return '<li><span class="e">' + esc(t.title) + (t.speaker ? ' <span class="who">— ' + esc(t.speaker) + '</span>' : '') + '</span>' +
        '<button type="button" class="btn-text" data-move="' + i + '" data-dir="-1"' + (i ? '' : ' disabled') + ' aria-label="Move up">↑</button>' +
        '<button type="button" class="btn-text" data-move="' + i + '" data-dir="1"' + (i < orderRows.length - 1 ? '' : ' disabled') + ' aria-label="Move down">↓</button></li>';
    }).join('');
  }

  // Only the list is redrawn, so the rest of the form keeps what's been typed.
  function wireOrder(){
    var list = el('talkOrder');
    if (!list) return;
    list.innerHTML = orderHtml();
    list.querySelectorAll('[data-move]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var i = Number(btn.getAttribute('data-move')), j = i + Number(btn.getAttribute('data-dir'));
        var k = orderRows[i]; orderRows[i] = orderRows[j]; orderRows[j] = k;
        wireOrder();
        var again = list.querySelector('[data-move="' + j + '"][data-dir="' + btn.getAttribute('data-dir') + '"]');
        (again && !again.disabled ? again : list.querySelector('[data-move="' + j + '"]:not(:disabled)')).focus();
      });
    });
  }

  // --- the page everyone sees -------------------------------------------------

  function row(label, valueHtml){ return '<dt>' + label + '</dt><dd>' + valueHtml + '</dd>'; }

  function leadsHtml(leads){
    return (leads || []).map(function(l){
      return '<span class="lead"' + (l.email ? ' title="' + esc(l.email) + '"' : '') + '>' + esc(l.name) + '</span>';
    }).join(', ');
  }

  function section(label, html){
    return '<div class="detail-field"><p class="detail-field-label">' + label + '</p>' + html + '</div>';
  }

  // Always shown; greyed out, with the reason on hover, for anyone who can't edit.
  function editButton(){
    var solo = soloTalk();
    var off = canEdit() || (solo && talkAccess.canEdit) ? '' : solo ? 'Only its speakers, the session’s leads, PIs and admins can edit it' : NOT_EDITOR;
    var addOff = me && (fullWrite || isLead()) ? '' : 'Only the session’s leads, PIs and admins can add a talk';
    if (solo) return '<div class="detail-actions"><button class="btn" type="button" id="editOpen"' + (off ? ' disabled title="' + esc(off) + '"' : '') + '>Edit</button></div>';
    return '<div class="detail-actions">' +
      '<button class="btn" type="button" id="addTalkOpen"' + (addOff ? ' disabled title="' + esc(addOff) + '"' : '') + '>Add a talk</button>' +
      '<button class="btn" type="button" id="editOpen"' + (off ? ' disabled title="' + esc(off) + '"' : '') + '>Edit session</button></div>';
  }

  // --- adding a talk ----------------------------------------------------------

  var TALK_TYPES = ['research-talk', 'pitch'];  // as in functions/index.js
  var ADD_FIELDS = [
    { key: 'title', label: 'Title' },
    { key: 'type', label: 'Type', type: 'select' },
    { key: 'duration', label: 'Duration (minutes)', type: 'number', placeholder: 'e.g. 10' }
  ];

  function addFormHtml(){
    return '<div class="edit-form add-talk">' + ADD_FIELDS.map(function(f){
      // The type most of the session's talks have, or the session's own kind.
      var counts = {};
      allTalks().forEach(function(t){ if (t.type) counts[t.type] = (counts[t.type] || 0) + 1; });
      var dflt = Object.keys(counts).sort(function(a, b){ return counts[b] - counts[a]; })[0] ||
        'research-talk';
      return '<div class="edit-field"><label for="a_' + f.key + '">' + f.label + '</label>' +
        (f.type === 'select'
          ? '<select id="a_' + f.key + '">' + TALK_TYPES.map(function(o){
              return '<option value="' + o + '"' + (o === dflt ? ' selected' : '') + '>' + esc(TYPES[o] || o) + '</option>';
            }).join('') + '</select>'
          : '<input type="' + (f.type || 'text') + '" id="a_' + f.key + '"' + (f.type === 'number' ? ' min="1" step="1"' : '') + ' placeholder="' + esc(f.placeholder || '') + '">') + '</div>' +
        (f.key === 'title' ? '<div class="edit-field"><span class="edit-label">Speakers</span><div id="addSpeakers"></div></div>' : '');
    }).join('') +
      '<p class="edit-hint">Its time follows from its place in the talk order and the durations. Then open the talk to add its abstract and presentation.</p>' +
      '<div class="field-error" id="addError"' + (addError ? '' : ' hidden') + '>' + esc(addError) + '</div>' +
      '<div class="edit-actions"><button class="btn btn-primary" type="button" id="addSave"' + (addBusy ? ' disabled' : '') + '>Add talk</button>' +
      '<button class="btn" type="button" id="addCancel"' + (addBusy ? ' disabled' : '') + '>Cancel</button></div></div>';
  }

  // Re-render without losing what's been typed into the add form.
  function renderKeepingAdd(){
    var typed = {};
    ADD_FIELDS.forEach(function(f){ var i = el('a_' + f.key); if (i) typed[f.key] = i.value; });
    render();
    ADD_FIELDS.forEach(function(f){ var i = el('a_' + f.key); if (i && typed[f.key] != null) i.value = typed[f.key]; });
  }

  function saveAdd(){
    if (addBusy) return;
    var data = { sessionSlug: base.slug };
    ADD_FIELDS.forEach(function(f){ data[f.key] = el('a_' + f.key).value.trim(); });
    data.duration = Number(data.duration) > 0 ? Math.round(Number(data.duration)) + ' min' : '';
    var spk = CollabWeekSpeakers.toSave(addSpeakerRows);
    if (!data.title) addError = 'The title can’t be empty.';
    else if (spk.error) addError = spk.error;
    if (!data.title || spk.error) { renderKeepingAdd(); return; }
    data.speakers = spk.speakers;
    addBusy = true; addError = ''; renderKeepingAdd();
    callable('createTalk')(data).then(function(){
      addBusy = false; adding = false;
      return loadTalkEdits();
    }).catch(function(err){
      addBusy = false; addError = (err && err.message) || 'Couldn’t add the talk — try again.'; renderKeepingAdd();
    });
  }

  // Its day and time are those of its event's time slot that holds it
  // (event-schedule.js), once loaded.
  var placed = null, unsubscribePlace = null, placeFor = null;

  // From its doc and its event's: venue, page title, back link, day and time.
  function useDoc(doc){
    var venues = (event && event.venues) || [];
    var v = venues.filter(function(l){ return l.slug === doc.locationSlug; })[0];
    venue = v ? Object.assign({ mapsUrl: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(v.name + ', ' + (v.address || '')) }, v) : {};
    document.title = (doc.title || 'Session') + (event && event.title ? ' | ' + event.title : '');
    var back = el('sessionBack');
    if (back && event) {
      back.href = event.page || 'event.html?event=' + encodeURIComponent(doc.eventSlug);
      back.textContent = '← Back to ' + event.title;
    }
  }

  // Follows its event (events/{eventSlug}): its time slot, venues and title.
  function watchEvent(eventSlug){
    if (!eventSlug || placeFor === eventSlug) return;
    if (unsubscribePlace) unsubscribePlace();
    placeFor = eventSlug;
    unsubscribePlace = db.collection('events').doc(eventSlug).onSnapshot(function(snap){
      event = snap.data() || null;
      placed = event ? EventSchedule.findSession(event.days, base.slug) : null;
      if (saved) useDoc(saved);
      if (!editing) (adding ? renderKeepingAdd : render)();
    }, function(err){ console.error('[BOLD Events] loading the session’s event failed', err); });
  }

  function whereHtml(s){
    return esc(venue.name || '') + (s.room ? ' &mdash; ' + esc(s.room) : '') +
      (venue.mapsUrl ? ' &middot; <a href="' + esc(venue.mapsUrl) + '" target="_blank" rel="noopener">Open in Google Maps</a>' : '') +
      (venue.address ? '<span class="meta">' + esc(venue.address) + '</span>' : '');
  }

  // A keynote or an oral: the session shown as its one talk.
  function soloViewHtml(s, t){
    var html = badge(s.type) + '<div class="detail-head"><h2>' + esc(t.title) + '</h2>' + editButton() + '</div>';
    if (s.removed) html += '<p class="detail-msg">This session was removed from the schedule. A PI or admin can put it back with ↺ on the schedule page.</p>';
    html += '<dl class="detail-grid">';
    if (t.speaker) html += row('Speaker', esc(t.speaker) + (t.affiliation ? ' <span class="detail-muted">(' + esc(t.affiliation) + ')</span>' : ''));
    html += row('When', esc(when(s))) + row('Where', whereHtml(s));
    if (!isEmpty(s.leads)) html += row(s.leads.length > 1 ? 'Leads' : 'Lead', leadsHtml(s.leads));
    if (t.presentationUrl) html += row('Presentation', '<a href="' + esc(t.presentationUrl) + '" target="_blank" rel="noopener">' + esc(t.presentationUrl) + '</a>');
    if (t.notes) html += row('Notes', esc(t.notes));
    return html + '</dl>' +
      section('Abstract', t.abstract ? '<p class="talk-text">' + esc(t.abstract) + '</p>' : '<p class="detail-muted">Abstract not yet available.</p>') +
      section('About the speaker', t.bio ? '<p class="talk-text">' + esc(t.bio) + '</p>' : '<p class="detail-muted">Not yet available.</p>');
  }

  function when(s){ return s.day ? s.day + (s.time ? ', ' + s.time : '') : 'Not on the schedule'; }

  function viewHtml(){
    if (missing) return '<p class="detail-muted">This session doesn’t exist — it may have been deleted.</p>';
    if (!saved) return '<p class="detail-muted">Loading…</p>';
    var s = session();
    var solo = soloTalk();
    if (solo) return soloViewHtml(s, solo);
    var html = badge(s.type) + '<div class="detail-head"><h2>' + esc(s.title) + '</h2>' +
      editButton() + '</div>';
    if (adding) html += addFormHtml();
    if (s.subtitle) html += '<p class="detail-subtitle">' + esc(s.subtitle) + '</p>';
    if (s.removed) html += '<p class="detail-msg">This session was removed from the schedule. A PI or admin can put it back with ↺ on the schedule page.</p>';

    html += '<dl class="detail-grid">' + row('When', esc(when(s))) + row('Where', whereHtml(s));
    if (!isEmpty(s.leads)) html += row(s.leads.length > 1 ? 'Leads' : 'Lead', leadsHtml(s.leads));
    if (s.contact) html += row('Contact', esc(s.contact));
    html += '</dl>';

    FIELDS.forEach(function(f){
      var v = s[f.key];
      if (isEmpty(v)) return;
      if (f.key === 'keyQuestions') html += section(f.label, '<ul>' + v.map(function(q){ return '<li>' + esc(q) + '</li>'; }).join('') + '</ul>');
      else if (['overallDescription', 'problems', 'background', 'aim'].indexOf(f.key) >= 0) html += section(f.label, '<p>' + esc(v) + '</p>');
    });

    if (!isEmpty(s.links)) html += '<ul class="detail-links">' + s.links.map(function(l){
      return '<li><a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.label) + '</a></li>';
    }).join('') + '</ul>';

    if (allTalks().length) html += section('Talks', '<ul class="session-talks">' + orderedTalks(s.talkOrder).map(function(t){
      var href = t.slug ? 'talk.html?talk=' + encodeURIComponent(t.slug) : '';
      var title = href ? '<a href="' + esc(href) + '">' + esc(t.title) + '</a>' : esc(t.title);
      return '<li><span class="t">' + esc(t.time || t.duration || '') + '</span><span class="e">' + title +
        (t.speaker ? ' <span class="who">— ' + esc(t.speaker) + '</span>' : '') +
        (t.presentationUrl ? ' · <a class="talk-pres" href="' + esc(t.presentationUrl) + '" target="_blank" rel="noopener">Presentation</a>' : '') +
        (t.notes ? '<span class="meta">' + esc(t.notes) + '</span>' : '') + '</span>' +
        (t.type ? '<span class="talk-type">' + badge(t.type) + '</span>' : '') + '</li>';
    }).join('') + '</ul>');

    if (!isEmpty(s.agenda)) html += section('Schedule', '<ul class="session-agenda">' + s.agenda.map(function(a){
      return '<li><span class="t">' + esc(a.time || '') + '</span><span class="e">' + esc(a.activity) +
        (a.speaker ? ' — ' + esc(a.speaker) : '') + (a.duration ? ' (' + esc(a.duration) + ')' : '') + '</span></li>';
    }).join('') + '</ul>');

    if (s.notes) html += '<p class="detail-msg">' + esc(s.notes) + '</p>';
    return html;
  }

  // --- the edit form ----------------------------------------------------------

  function typeFieldHtml(s){
    return '<div class="edit-field"><label for="f_type">Type</label>' + (fullWrite
      ? '<select id="f_type">' + SESSION_TYPES.map(function(o){
          return '<option value="' + o + '"' + (o === s.type ? ' selected' : '') + '>' + esc(TYPES[o] || o) + '</option>';
        }).join('') + '</select><p class="edit-hint">A keynote or an oral is one talk.</p>'
      : '<p class="edit-static">' + esc(TYPES[s.type] || '—') + '</p><p class="edit-hint">Only PIs and admins can change the type.</p>') + '</div>';
  }

  // Its day and time: its time slot's. PIs/admins move it here (to the slot at
  // that time, or a new one — EventSchedule.moveSession); the rest see it.
  function whenFieldHtml(s){
    if (!fullWrite || !event) return '<div class="edit-field"><span class="edit-label">When</span><p class="edit-static">' + esc(when(s)) +
      '</p><p class="edit-hint">Only PIs and admins can change when it is.</p></div>';
    var days = EventSchedule.sorted(event.days);
    var cur = placed || {};
    return '<div class="edit-field"><span class="edit-label">When</span><div class="when-row">' +
      '<label>Day<select id="f_date">' + (cur.date ? '' : '<option value="">Choose a day…</option>') + days.map(function(d){
        return '<option value="' + esc(d.date) + '"' + (d.date === cur.date ? ' selected' : '') + '>' + esc(EventSchedule.dayLabel(d.date)) + '</option>';
      }).join('') + '</select></label>' +
      '<label>Starts<input type="time" id="f_start" step="300" value="' + esc(cur.start || '') + '"></label>' +
      '<label>Ends<input type="time" id="f_end" step="300" value="' + esc(cur.end || '') + '"></label></div>' +
      '<p class="edit-hint">It joins any sessions already at that time, side by side; otherwise it gets a time slot of its own.</p></div>';
  }

  // → null (unchanged), { date, start, end }, or { error }.
  function whenMove(){
    var d = el('f_date');
    if (!d) return null;
    var date = d.value, start = el('f_start').value, end = el('f_end').value, cur = placed || {};
    if (date === (cur.date || '') && start === (cur.start || '') && end === (cur.end || '')) return null;
    if (!date) return { error: 'Choose its day.' };
    if (!start || !end) return { error: 'Set when it starts and ends.' };
    if (end <= start) return { error: 'It has to end after it starts.' };
    return { date: date, start: start, end: end };
  }
  function doMove(move){
    return move ? EventSchedule.moveSession(db.collection('events').doc(saved.eventSlug), base.slug, move.date, move.start, move.end, me.email) : Promise.resolve();
  }

  function leadsFieldHtml(s){
    return '<div class="edit-field"><span class="edit-label">Leads</span>' + (fullWrite
      ? '<div id="leadRows"></div><p class="edit-hint">The leads can edit this session and its talks.</p>'
      : '<p class="edit-static">' + (leadsHtml(s.leads) || '—') + '</p><p class="edit-hint">Only PIs and admins can change the leads.</p>') + '</div>';
  }

  var SOLO_FIELDS = [
    { key: 'affiliation', label: 'Affiliation' },
    { key: 'presentationUrl', label: 'Presentation', placeholder: 'https://…', hint: 'Slides, a shared doc or a recording.' },
    { key: 'notes', label: 'Notes' },
    { key: 'abstract', label: 'Abstract', area: 10 },
    { key: 'bio', label: 'About the speaker', area: 6 }
  ];

  // A keynote's or an oral's form: its talk's fields, and the session's type, room and leads.
  function soloFormHtml(s, t){
    var html = '<div class="detail-head"><h2>Edit ' + esc((TYPES[s.type] || 'session').toLowerCase()) + '</h2></div>' +
      '<p class="detail-subtitle">' + esc(when(s) + (venue.name ? ' · ' + venue.name : '')) +
      ' — day, time and venue are set with the schedule.</p><div class="edit-form">' +
      '<div class="edit-field"><label for="f_title">Title</label><input type="text" id="f_title" value="' + esc(t.title) + '"></div>' +
      typeFieldHtml(s) + whenFieldHtml(s) +
      '<div class="edit-field"><span class="edit-label">Speakers</span>' + (talkAccess.canSetPresenters
        ? '<div id="soloSpeakers"></div>'
        : '<p class="edit-static">' + esc(t.speaker || '—') + '</p><p class="edit-hint">Only the session’s leads, PIs and admins can change the speakers.</p>') + '</div>';
    if (canEdit()) html += '<div class="edit-field"><label for="f_room">Room</label><input type="text" id="f_room" value="' + esc(s.room || '') + '" placeholder="e.g. Seminar Room 2"></div>' + leadsFieldHtml(s);
    SOLO_FIELDS.forEach(function(f){
      var v = t[f.key] || '';
      html += '<div class="edit-field"><label for="t_' + f.key + '">' + esc(f.label) + '</label>' +
        (f.area ? '<textarea id="t_' + f.key + '" rows="' + f.area + '">' + esc(v) + '</textarea>'
          : '<input type="text" id="t_' + f.key + '" value="' + esc(v) + '" placeholder="' + esc(f.placeholder || '') + '">') +
        (f.hint ? '<p class="edit-hint">' + esc(f.hint) + '</p>' : '') + '</div>';
    });
    return html + '</div><div class="field-error" id="editError" hidden></div>' +
      '<div class="edit-actions"><button class="btn btn-primary" type="button" id="editSave">Save</button>' +
      '<button class="btn" type="button" id="editCancel">Cancel</button></div>';
  }

  function formHtml(){
    var s = session();
    var solo = soloTalk();
    if (solo) return soloFormHtml(s, solo);
    var html = '<div class="detail-head"><h2>Edit session</h2></div>' +
      '<p class="detail-subtitle">' + esc(when(s) + (venue.name ? ' · ' + venue.name : '')) +
      ' — day, time and venue are set with the schedule.</p><div class="edit-form">';
    editFields().forEach(function(f){
      var id = 'f_' + f.key, v = toText(f.key, s[f.key]);
      html += '<div class="edit-field"><label for="' + id + '">' + esc(f.label) + '</label>' +
        (f.input === 'text'
          ? '<input type="text" id="' + id + '" value="' + esc(v) + '" placeholder="' + esc(f.placeholder || '') + '">'
          : '<textarea id="' + id + '" rows="' + (f.list ? 5 : 6) + '">' + esc(v) + '</textarea>') +
        (f.hint ? '<p class="edit-hint">' + esc(f.hint) + '</p>' : '') + '</div>';
      if (f.key === 'title') html += typeFieldHtml(s) + whenFieldHtml(s);
      if (f.key === 'room') html += leadsFieldHtml(s);
    });
    if (hasTalks()) html += '<div class="edit-field"><span class="edit-label">Schedule</span>' +
      '<ul class="session-talks talk-order" id="talkOrder"></ul>' +
      '<p class="edit-hint">Worked out from the talks: back to back from the session’s start, in this order, by each talk’s duration. Add a talk with “Add a talk”; change one’s duration on its own page.</p></div>';
    return html + '</div><div class="field-error" id="editError" hidden></div>' +
      '<div class="edit-actions"><button class="btn btn-primary" type="button" id="editSave">Save</button>' +
      '<button class="btn" type="button" id="editCancel">Cancel</button></div>';
  }

  function leadRowsHtml(){
    return leadRows.map(function(r, i){
      var control = r.free
        ? '<input type="text" class="lead-name" data-i="' + i + '" value="' + esc(r.name) + '" placeholder="Name (not on Slack)">' +
          '<button type="button" class="btn-text lead-roster" data-i="' + i + '">Pick from list</button>'
        : '<select class="lead-select" data-i="' + i + '"><option value="">Choose a person…</option>' +
          people.map(function(p){
            return '<option value="' + esc(p.email) + '"' + (p.email === r.email ? ' selected' : '') + '>' + esc(p.name) + '</option>';
          }).join('') + '<option value="__free__">Someone not on Slack…</option></select>';
      return '<div class="lead-row">' + control +
        '<button type="button" class="btn-text danger lead-remove" data-i="' + i + '">Remove</button></div>';
    }).join('') + '<button type="button" class="btn-text" id="leadAdd">+ Add a lead</button>';
  }

  function wireLeadRows(){
    var wrap = el('leadRows');
    if (!wrap) return;
    wrap.innerHTML = leadRowsHtml();
    wrap.querySelectorAll('.lead-select').forEach(function(sel){
      sel.addEventListener('change', function(){
        var i = Number(sel.getAttribute('data-i'));
        if (sel.value === '__free__') leadRows[i] = { name: '', email: '', free: true };
        else {
          var p = people.filter(function(x){ return x.email === sel.value; })[0];
          leadRows[i] = { name: p ? p.name : '', email: sel.value, free: false };
        }
        wireLeadRows();
      });
    });
    wrap.querySelectorAll('.lead-name').forEach(function(inp){
      inp.addEventListener('input', function(){ leadRows[Number(inp.getAttribute('data-i'))].name = inp.value; });
    });
    wrap.querySelectorAll('.lead-roster').forEach(function(btn){
      btn.addEventListener('click', function(){ leadRows[Number(btn.getAttribute('data-i'))] = { name: '', email: '', free: false }; wireLeadRows(); });
    });
    wrap.querySelectorAll('.lead-remove').forEach(function(btn){
      btn.addEventListener('click', function(){ leadRows.splice(Number(btn.getAttribute('data-i')), 1); wireLeadRows(); });
    });
    el('leadAdd').addEventListener('click', function(){ leadRows.push({ name: '', email: '', free: false }); wireLeadRows(); });
  }

  var peoplePromise = null;
  function loadPeople(){
    if (!peoplePromise) peoplePromise = db.collection('people').get().then(function(snap){
      people = snap.docs.map(function(d){ return d.data(); })
        .sort(function(a, b){ return (a.name || '').localeCompare(b.name || ''); });
    }).catch(function(err){ console.error('[BOLD Events] loading the roster failed', err); });
    return peoplePromise;
  }

  function openForm(){
    var solo = soloTalk();
    var ready = fullWrite || (solo && talkAccess.canSetPresenters) ? loadPeople() : Promise.resolve();
    ready.then(function(){
      leadRows = (session().leads || []).map(function(l){ return { name: l.name, email: l.email || '', free: !l.email }; });
      if (solo) soloSpeakerRows = CollabWeekSpeakers.rowsFrom(solo.speakers || speakersFromNames(solo), people);
      orderRows = orderedTalks(session().talkOrder).map(talkKey);
      editing = true;
      render();
      el('f_title').focus();
    });
  }

  // The type, if a PI/admin changed it → patch; or the reason it can't be.
  function typePatch(patch, s){
    var type = fullWrite && el('f_type') ? el('f_type').value : s.type;
    if (type === s.type) return '';
    if (SOLO_TYPES.indexOf(type) >= 0 && allTalks().length !== 1)
      return 'A ' + TYPES[type].toLowerCase() + ' is one talk, and this session has ' + allTalks().length + '. Add or remove talks first.';
    patch.type = type;
    return '';
  }

  function leadsPatch(patch, s){
    if (!fullWrite) return;
    var leads = leadRows
      .map(function(r){ return r.free ? { name: (r.name || '').trim() } : { name: r.name, email: r.email }; })
      .filter(function(l){ return l.name; });
    if (JSON.stringify(leads) !== JSON.stringify(s.leads || [])) { patch.leads = leads; patch.leadEmails = emailsOf(leads); }
  }

  // A programme talk's speaker names as speaker rows, matched to the roster by name.
  function speakersFromNames(t){
    var fold = function(x){ return String(x || '').trim().toLowerCase(); };
    return String(t.speaker || '').split(/,|&|\band\b/).map(function(n){ return n.trim(); }).filter(Boolean).map(function(name){
      var p = people.filter(function(x){ return fold(x.name) === fold(name); })[0];
      return { name: p ? p.name : name, email: p ? p.email : '' };
    });
  }

  // A keynote's or an oral's save: the talk through editTalk, then the session's type/room/leads.
  function saveSolo(){
    var btn = el('editSave');
    var fail = function(msg){ var e = el('editError'); e.textContent = msg; e.hidden = false; btn.disabled = false; };
    var s = session(), t = soloTalk();
    var edits = { title: el('f_title').value.trim() };
    SOLO_FIELDS.forEach(function(f){ edits[f.key] = el('t_' + f.key).value.trim(); });
    if (!edits.title) return fail('The title can’t be empty.');
    if (edits.presentationUrl && !/^https?:\/\/\S+$/.test(edits.presentationUrl)) return fail('The presentation isn’t a link — paste the full https://… address.');
    if (talkAccess.canSetPresenters) {
      var spk = CollabWeekSpeakers.toSave(soloSpeakerRows);
      if (spk.error) return fail(spk.error);
      edits.speakers = spk.speakers;
    }
    var patch = {};
    if (canEdit()) {
      var room = el('f_room') ? el('f_room').value.trim() : s.room || '';
      if (room !== (s.room || '')) patch.room = room;
      if (edits.title !== s.title) patch.title = edits.title;  // the session's own title follows its talk's
      var typeError = typePatch(patch, s);
      if (typeError) return fail(typeError);
      leadsPatch(patch, s);
    }
    var move = whenMove();
    if (move && move.error) return fail(move.error);
    btn.disabled = true;
    var talkSave = talkAccess.canEdit ? callable('editTalk')({ slug: t.slug, edits: edits }) : Promise.resolve();
    talkSave.then(function(){
      if (!Object.keys(patch).length) return;
      var write = Object.assign(patch, { updatedAt: Date.now(), updatedBy: me.email });
      return ref.set(write, { merge: true }).then(function(){ saved = Object.assign({}, saved || {}, write); });
    }).then(function(){ return doMove(move); }).then(function(){
      editing = false;
      return loadTalkEdits();
    }).catch(function(err){
      console.error('[BOLD Events] saving the session failed', err);
      fail((err && err.message) || 'Could not save — try again.');
    });
  }

  // Only the fields that changed are written.
  function saveForm(){
    var btn = el('editSave');
    var fail = function(msg){ var e = el('editError'); e.textContent = msg; e.hidden = false; };
    if (!canEdit() || !ref) return fail(NOT_EDITOR + '.');
    var s = session(), patch = {};
    var fields = editFields();
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i], parsed = fromText(f, el('f_' + f.key).value);
      if (parsed.error) return fail(parsed.error);
      if (JSON.stringify(parsed.value) !== JSON.stringify(fromText(f, toText(f.key, s[f.key])).value)) patch[f.key] = parsed.value;
    }
    var currentOrder = orderedTalks(s.talkOrder).map(talkKey);
    if (orderRows.length && JSON.stringify(orderRows) !== JSON.stringify(currentOrder)) patch.talkOrder = orderRows.slice();
    var typeError = typePatch(patch, s);
    if (typeError) return fail(typeError);
    leadsPatch(patch, s);
    var move = whenMove();
    if (move && move.error) return fail(move.error);
    if (!Object.keys(patch).length && !move) { editing = false; render(); return; }
    btn.disabled = true;
    var write = Object.keys(patch).length ? Object.assign(patch, { updatedAt: Date.now(), updatedBy: me.email }) : null;
    (write ? ref.set(write, { merge: true }) : Promise.resolve()).then(function(){
      if (write) saved = Object.assign({}, saved || {}, write);
      return doMove(move);
    }).then(function(){
      editing = false;
      render();
    }).catch(function(err){
      console.error('[BOLD Events] saving the session failed', err);
      btn.disabled = false;
      fail(err && err.code === 'permission-denied' ? NOT_EDITOR + '.' : (err && err.message) || 'Could not save — try again.');
    });
  }

  function render(){
    bodyEl.innerHTML = editing ? formHtml() : viewHtml();
    if (!editing) {
      var open = el('editOpen');
      if (open) open.addEventListener('click', function(){ adding = false; openForm(); });
      if (wantEdit && talksLoaded && open && !open.disabled) {
        wantEdit = false;
        history.replaceState(null, '', location.pathname + location.search);
        openForm();
        return;
      }
      var add = el('addTalkOpen');
      if (add) add.addEventListener('click', function(){
        loadPeople().then(function(){
          adding = true; addError = ''; addSpeakerRows = CollabWeekSpeakers.rowsFrom([], people);
          render(); el('a_title').focus();
        });
      });
      if (adding) {
        CollabWeekSpeakers.mount(el('addSpeakers'), addSpeakerRows, people);
        el('addSave').addEventListener('click', saveAdd);
        el('addCancel').addEventListener('click', function(){ adding = false; addError = ''; render(); });
      }
      return;
    }
    wireLeadRows();
    if (soloTalk()) {
      if (el('soloSpeakers')) CollabWeekSpeakers.mount(el('soloSpeakers'), soloSpeakerRows, people);
      el('editSave').addEventListener('click', saveSolo);
      el('editCancel').addEventListener('click', function(){ editing = false; render(); });
      return;
    }
    wireOrder();
    el('editSave').addEventListener('click', saveForm);
    el('editCancel').addEventListener('click', function(){ editing = false; render(); });
  }

  // --- data -----------------------------------------------------------------

  function loadAccess(){
    try {
      firebase.app().functions('europe-west2').httpsCallable('getMyAccess')().then(function(r){
        var v = !!(r.data && r.data.fullWrite);
        if (v !== fullWrite) { fullWrite = v; if (!editing) (adding ? renderKeepingAdd : render)(); }
      }).catch(function(err){ console.error('[BOLD Events] access check failed', err); });
    } catch (e){}
  }

  // --- hackathon: join the GitHub team ----------------------------------------
  // Its own box under the session, so the snapshot re-renders above don't wipe
  // what's being typed. Asking only records a request (joinHackathonTeam); a
  // PI/admin approves here, which is when it goes to GitHub (functions/index.js).

  var joinEl = null, join = { mine: null, canApprove: false, all: [] };
  // A session with hackathonJoin gets the box, once its doc says so.
  function useJoin(doc){
    if (joinEl || !doc || !doc.hackathonJoin) return;
    joinEl = document.createElement('div');
    joinEl.className = 'detail-field join-box';
    bodyEl.parentNode.appendChild(joinEl);
    renderJoin();
    loadJoin();
  }

  function callable(name){ return firebase.app().functions('europe-west2').httpsCallable(name); }

  var JOIN_STATUS = {
    requested: 'waiting for approval',
    pending: 'invited — accept the email from GitHub, or at github.com/orgs/bold-lab-ai/invitation',
    active: 'in the team',
    failed: 'not added',
  };
  function statusText(r){ return JOIN_STATUS[r.status] + (r.status === 'failed' && r.error ? ': ' + r.error : ''); }

  function requestsHtml(){
    if (!join.canApprove) return '';
    var waiting = join.all.filter(function(r){ return r.status === 'requested'; }).length;
    var html = '<div class="join-admin"><div class="join-admin-head"><p class="detail-field-label">Requests (' + join.all.length + ')</p>' +
      (waiting ? '<button class="btn" type="button" id="joinApproveAll">Approve all (' + waiting + ')</button>' : '') + '</div>';
    if (!join.all.length) return html + '<p class="detail-muted">No requests yet.</p></div>';
    html += '<ul class="join-list">' + join.all.map(function(r){
      var act = r.status === 'requested' || r.status === 'failed'
        ? '<button class="btn-text" type="button" data-approve="' + esc(r.email) + '">' + (r.status === 'failed' ? 'Retry' : 'Approve') + '</button>' : '';
      return '<li><span class="e">' + esc(r.name || r.email) + ' <span class="who">' + esc(r.email) + '</span>' +
        '<span class="meta">GitHub: ' + esc(r.github) + ' · ' + esc(statusText(r)) + '</span></span>' + act + '</li>';
    }).join('') + '</ul>';
    return html + '<p class="edit-hint" id="joinAdminMsg" role="status"></p></div>';
  }

  function renderJoin(){
    if (!joinEl) return;
    var html = '<p class="detail-field-label">Hackathon</p>' +
      '<p>To push your team’s branch, ask to join the <code>hackathon</code> team of ' +
      '<a href="https://github.com/bold-lab-ai/bold-os/tree/hackathon" target="_blank" rel="noopener">bold-os</a> on GitHub. ' +
      'Setup: <a href="https://github.com/bold-lab-ai/bold-os/blob/hackathon/AGENTS.md" target="_blank" rel="noopener">AGENTS.md</a>.</p>';
    if (!me) { joinEl.innerHTML = html + '<p class="detail-muted">Sign in to join.</p>'; return; }
    if (join.mine) html += '<p class="join-mine">Your request (GitHub: ' + esc(join.mine.github) + '): ' + esc(statusText(join.mine)) + '.</p>';
    if (!join.mine || join.mine.status === 'requested' || join.mine.status === 'failed') {
      html += '<div class="join-row"><input type="text" id="joinUser" placeholder="GitHub username" autocomplete="off" spellcheck="false"' +
        (join.mine ? ' value="' + esc(join.mine.github) + '"' : '') + '>' +
        '<button class="btn" type="button" id="joinBtn">' + (join.mine ? 'Update' : 'Ask to join') + '</button></div>' +
        '<p class="edit-hint" id="joinMsg" role="status"></p>';
    }
    joinEl.innerHTML = html + requestsHtml();
    wireJoin();
  }

  function wireJoin(){
    var input = el('joinUser'), btn = el('joinBtn'), msg = el('joinMsg');
    function ask(){
      var username = input.value.trim();
      if (!username) { input.focus(); return; }
      btn.disabled = true; msg.textContent = 'Sending…';
      callable('joinHackathonTeam')({ username: username }).then(function(){ return loadJoin(); }).catch(function(err){
        console.error('[BOLD Events] hackathon join request failed', err);
        btn.disabled = false;
        msg.textContent = (err && err.message) || 'Could not send — try again.';
      });
    }
    if (btn) { btn.addEventListener('click', ask); input.addEventListener('keydown', function(e){ if (e.key === 'Enter') ask(); }); }

    function approve(emails, button){
      var adminMsg = el('joinAdminMsg');
      button.disabled = true;
      if (adminMsg) adminMsg.textContent = 'Adding on GitHub…';
      callable('approveHackathonJoins')(emails ? { emails: emails } : {}).then(function(){ return loadJoin(); }).catch(function(err){
        console.error('[BOLD Events] approving hackathon joins failed', err);
        button.disabled = false;
        if (adminMsg) adminMsg.textContent = (err && err.message) || 'Could not approve — try again.';
      });
    }
    var all = el('joinApproveAll');
    if (all) all.addEventListener('click', function(){ approve(null, all); });
    Array.prototype.slice.call(joinEl.querySelectorAll('[data-approve]')).forEach(function(b){
      b.addEventListener('click', function(){ approve([b.getAttribute('data-approve')], b); });
    });
  }

  function loadJoin(){
    if (!joinEl || !me) return Promise.resolve();
    return callable('hackathonJoinRequests')().then(function(r){
      join = { mine: r.data.mine, canApprove: !!r.data.canApprove, all: r.data.all || [] };
      renderJoin();
    }).catch(function(err){ console.error('[BOLD Events] loading hackathon requests failed', err); });
  }

  render();
  renderJoin();
  var unsubscribe = null;
  // This session's talks (collabWeekTalks naming it).
  function loadTalkEdits(){
    return db.collection('collabWeekTalks').where('sessionSlug', '==', base.slug).get().then(function(snap){
      talkEdits = {};
      snap.docs.forEach(function(d){ talkEdits[d.id] = d.data(); });
      talksLoaded = true;
      loadTalkAccess();
      if (!editing) (adding ? renderKeepingAdd : render)();
    }).catch(function(err){ console.error('[BOLD Events] loading talk edits failed', err); });
  }

  // For a keynote/oral: whether the signed-in person may edit its talk.
  function loadTalkAccess(){
    var solo = soloTalk();
    if (!solo || !me) return;
    callable('editTalk')({ slug: solo.slug }).then(function(r){
      talkAccess = { canEdit: !!r.data.canEdit, canSetPresenters: !!r.data.canSetPresenters };
      if (!editing) (adding ? renderKeepingAdd : render)();
    }).catch(function(err){ console.error('[BOLD Events] editTalk access check failed', err); });
  }

  BOLD.onUser(function(user){
    adding = false;
    talkAccess = { canEdit: false, canSetPresenters: false };
    me = user ? { email: user.email || '' } : null;
    fullWrite = false;
    editing = false;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (unsubscribePlace) { unsubscribePlace(); unsubscribePlace = null; placeFor = null; }
    join = { mine: null, canApprove: false, all: [] };
    renderJoin();
    loadJoin();
    if (!user || !ref) { render(); return; }
    loadAccess();
    talkEdits = {};
    loadTalkEdits();
    unsubscribe = ref.onSnapshot(function(snap){
      saved = snap.exists && !snap.data().deletedAt ? snap.data() : null;
      missing = !saved;
      if (saved) { useDoc(saved); useJoin(saved); watchEvent(saved.eventSlug); }
      loadTalkAccess();  // its type may have just become a keynote's or an oral's
      if (!editing) (adding ? renderKeepingAdd : render)();
    }, function(err){
      console.error('[BOLD Events] loading the session failed', err);
    });
  });
})();
