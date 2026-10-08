// A Collaboration Week session's page. The programme in
// src/_data/collabWeekSessions.js is the default (inlined as #sessionData);
// Firestore's collabWeekSessions/{slug} holds what's been edited since, and
// the session's leads. Everyone sees the same page; a lead (their own
// session) or a PI/admin (any) also gets one "Edit session" button that
// swaps it for a form. Only a PI/admin can change who the leads are
// (firestore.rules). Day, time and venue belong to the whole schedule, and
// each talk has its own generated page, so neither is edited here.
(function(){
  if (!BOLD.getAuth()) return;

  var esc = BOLD.escapeHtml;
  var el = function(id){ return document.getElementById(id); };
  var bodyEl = el('sessionBody');
  var base = JSON.parse(el('sessionData').textContent);
  var venue = JSON.parse(el('sessionLocation').textContent) || {};
  var TYPES = JSON.parse(el('sessionTypes').textContent) || {};

  function badge(type){ return TYPES[type] ? '<span class="type-badge type-' + esc(type) + '">' + esc(TYPES[type]) + '</span>' : ''; }

  var NOT_EDITOR = 'Only the session’s leads, PIs and admins can edit it';
  var db = null, ref = null;
  try {
    db = firebase.firestore(BOLD.getApp());
    ref = db.collection('collabWeekSessions').doc(base.slug);
  } catch (e){}

  var me = null;            // { email } once signed in
  var saved = null;         // the Firestore doc's data, or null if it doesn't exist (yet)
  var fullWrite = false;    // PI or admin (getMyAccess)
  var editing = false;      // the form is open
  var people = [];          // the `people` roster, for the leads picker
  var leadRows = [];        // in-progress rows while the form is open
  var orderRows = [];       // talk keys, in the order being edited
  var talkEdits = {};       // talk slug → its edits (collabWeekTalks), e.g. title, presentationUrl; or the whole of an added talk
  var adding = false, addBusy = false, addError = '';  // the "Add a talk" form
  var addSpeakerRows = [];  // its speakers (collab-week-speakers.js)

  function session(){ return Object.assign({}, base, saved || {}); }

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
    var emails = saved && saved.leadEmails ? saved.leadEmails : emailsOf(base.leads);
    return emails.indexOf(me.email.toLowerCase()) >= 0;
  }

  // A lead can only update an existing doc (a PI/admin creates it), as in the rules.
  function canEdit(){ return !!me && (fullWrite || (isLead() && !!saved)); }

  function isEmpty(v){ return v == null || v === '' || (Array.isArray(v) && !v.length); }

  // --- the editable fields, in form order ------------------------------------

  // Lists are edited as one entry per line; `|` separates the parts of an entry.
  var FIELDS = [
    { key: 'title', label: 'Title', input: 'text', required: true },
    { key: 'subtitle', label: 'Subtitle', input: 'text' },
    { key: 'room', label: 'Room', input: 'text', placeholder: 'e.g. Seminar Room 2' },
    { key: 'contact', label: 'Contact', input: 'text', placeholder: 'e.g. name@example.com' },
    { key: 'overallDescription', label: 'Overall description', input: 'area' },
    { key: 'problems', label: 'Problems', input: 'area' },
    { key: 'background', label: 'Background', input: 'area' },
    { key: 'keyQuestions', label: 'Key questions', input: 'area', list: true, hint: 'One question per line.' },
    { key: 'aim', label: 'Aim', input: 'area' },
    { key: 'links', label: 'Links', input: 'area', list: true, hint: 'One per line: Label | https://…' },
    { key: 'agenda', label: 'Agenda', input: 'area', list: true, hint: 'One per line: time | activity' }
  ];

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
  // A session's talks come from the programme, with their edits, plus any
  // added from this page (createTalk), less any removed — all from its
  // collabWeekTalks docs (talkEdits). `talkOrder` reorders them; their times
  // follow from the order and durations (collab-week-talk-times.js).

  var talkKey = CollabWeekTalkTimes.key;

  function orderedTalks(order){
    var docs = Object.keys(talkEdits).map(function(k){ return talkEdits[k]; });
    return CollabWeekTalkTimes.schedule(base.talks, docs, order, base.time);
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
    var off = canEdit() ? '' : isLead() ? 'A PI or admin has to save this session once before its leads can edit it' : NOT_EDITOR;
    var addOff = me && (fullWrite || isLead()) ? '' : 'Only the session’s leads, PIs and admins can add a talk';
    return '<div class="detail-actions">' +
      '<button class="btn" type="button" id="addTalkOpen"' + (addOff ? ' disabled title="' + esc(addOff) + '"' : '') + '>Add a talk</button>' +
      '<button class="btn" type="button" id="editOpen"' + (off ? ' disabled title="' + esc(off) + '"' : '') + '>Edit session</button></div>';
  }

  // --- adding a talk ----------------------------------------------------------

  var TALK_TYPES = ['research-talk', 'pitch', 'keynote'];  // as in functions/index.js
  var ADD_FIELDS = [
    { key: 'title', label: 'Title' },
    { key: 'type', label: 'Type', type: 'select' },
    { key: 'duration', label: 'Duration (minutes)', type: 'number', placeholder: 'e.g. 10' }
  ];

  function addFormHtml(){
    return '<div class="edit-form add-talk">' + ADD_FIELDS.map(function(f){
      var dflt = { pitches: 'pitch', keynote: 'keynote' }[base.type] || 'research-talk';
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

  function viewHtml(){
    var s = session();
    var html = badge(s.type) + '<div class="detail-head"><h2>' + esc(s.title) + '</h2>' +
      editButton() + '</div>';
    if (adding) html += addFormHtml();
    if (s.subtitle) html += '<p class="detail-subtitle">' + esc(s.subtitle) + '</p>';

    var where = esc(venue.name || '') + (s.room ? ' &mdash; ' + esc(s.room) : '') +
      (venue.mapsUrl ? ' &middot; <a href="' + esc(venue.mapsUrl) + '" target="_blank" rel="noopener">Open in Google Maps</a>' : '') +
      (venue.address ? '<span class="meta">' + esc(venue.address) + '</span>' : '');
    html += '<dl class="detail-grid">' + row('When', esc(s.day + ', ' + s.time)) + row('Where', where);
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
      var href = t.added ? 'event-collaboration-week-talk.html?talk=' + encodeURIComponent(t.slug)
        : t.slug ? 'event-collaboration-week-talk-' + t.slug + '.html' : '';
      var title = href ? '<a href="' + esc(href) + '">' + esc(t.title) + '</a>' : esc(t.title);
      return '<li><span class="t">' + esc(t.time || t.duration || '') + '</span><span class="e">' + title +
        (t.speaker ? ' <span class="who">— ' + esc(t.speaker) + '</span>' : '') +
        (t.presentationUrl ? ' · <a class="talk-pres" href="' + esc(t.presentationUrl) + '" target="_blank" rel="noopener">Presentation</a>' : '') +
        (t.notes ? '<span class="meta">' + esc(t.notes) + '</span>' : '') + '</span>' +
        (t.type ? '<span class="talk-type">' + badge(t.type) + '</span>' : '') + '</li>';
    }).join('') + '</ul>');

    if (!isEmpty(s.agenda)) html += section('Agenda', '<ul class="session-agenda">' + s.agenda.map(function(a){
      return '<li><span class="t">' + esc(a.time || '') + '</span><span class="e">' + esc(a.activity) +
        (a.speaker ? ' — ' + esc(a.speaker) : '') + (a.duration ? ' (' + esc(a.duration) + ')' : '') + '</span></li>';
    }).join('') + '</ul>');

    if (s.notes) html += '<p class="detail-msg">' + esc(s.notes) + '</p>';
    return html;
  }

  // --- the edit form ----------------------------------------------------------

  function formHtml(){
    var s = session();
    var html = '<div class="detail-head"><h2>Edit session</h2></div>' +
      '<p class="detail-subtitle">' + esc(s.day + ', ' + s.time + ' · ' + (venue.name || '')) +
      ' — day, time and venue are set with the schedule.</p><div class="edit-form">';
    FIELDS.forEach(function(f){
      var id = 'f_' + f.key, v = toText(f.key, s[f.key]);
      html += '<div class="edit-field"><label for="' + id + '">' + esc(f.label) + '</label>' +
        (f.input === 'text'
          ? '<input type="text" id="' + id + '" value="' + esc(v) + '" placeholder="' + esc(f.placeholder || '') + '">'
          : '<textarea id="' + id + '" rows="' + (f.list ? 5 : 6) + '">' + esc(v) + '</textarea>') +
        (f.hint ? '<p class="edit-hint">' + esc(f.hint) + '</p>' : '') + '</div>';
      if (f.key === 'contact') html += '<div class="edit-field"><span class="edit-label">Leads</span>' + (fullWrite
        ? '<div id="leadRows"></div>'
        : '<p class="edit-static">' + leadsHtml(s.leads) + '</p><p class="edit-hint">Only PIs and admins can change the leads.</p>') + '</div>';
    });
    if (allTalks().length > 1) html += '<div class="edit-field"><span class="edit-label">Talk order</span>' +
      '<ul class="session-talks talk-order" id="talkOrder"></ul>' +
      '<p class="edit-hint">Times follow the order: back to back from the session’s start when every talk has a duration, otherwise the programme’s start times stay in place.</p></div>';
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
    }).catch(function(err){ console.error('[BOLD Collaboration Week] loading the roster failed', err); });
    return peoplePromise;
  }

  function openForm(){
    var ready = fullWrite ? loadPeople() : Promise.resolve();
    ready.then(function(){
      leadRows = (session().leads || []).map(function(l){ return { name: l.name, email: l.email || '', free: !l.email }; });
      orderRows = orderedTalks(session().talkOrder).map(talkKey);
      editing = true;
      render();
      el('f_title').focus();
    });
  }

  // Only the fields that changed are written. The first save of a session
  // (always a PI's/admin's — see canEdit) also records its leads from the
  // programme, so they can edit it from then on.
  function saveForm(){
    var btn = el('editSave');
    var fail = function(msg){ var e = el('editError'); e.textContent = msg; e.hidden = false; };
    if (!canEdit() || !ref) return fail(NOT_EDITOR + '.');
    var s = session(), patch = {};
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i], parsed = fromText(f, el('f_' + f.key).value);
      if (parsed.error) return fail(parsed.error);
      if (JSON.stringify(parsed.value) !== JSON.stringify(fromText(f, toText(f.key, s[f.key])).value)) patch[f.key] = parsed.value;
    }
    var currentOrder = orderedTalks(s.talkOrder).map(talkKey);
    if (orderRows.length && JSON.stringify(orderRows) !== JSON.stringify(currentOrder)) patch.talkOrder = orderRows.slice();
    if (fullWrite) {
      var leads = leadRows
        .map(function(r){ return r.free ? { name: (r.name || '').trim() } : { name: r.name, email: r.email }; })
        .filter(function(l){ return l.name; });
      if (!leads.length) return fail('A session needs at least one lead.');
      if (JSON.stringify(leads) !== JSON.stringify(s.leads || [])) { patch.leads = leads; patch.leadEmails = emailsOf(leads); }
    }
    if (!Object.keys(patch).length) { editing = false; render(); return; }
    btn.disabled = true;
    var seed = saved ? {} : { slug: base.slug, leads: base.leads || [], leadEmails: emailsOf(base.leads) };
    var write = Object.assign(seed, patch, { updatedAt: Date.now(), updatedBy: me.email });
    ref.set(write, { merge: true }).then(function(){
      saved = Object.assign({}, saved || {}, write);
      editing = false;
      render();
    }).catch(function(err){
      console.error('[BOLD Collaboration Week] saving the session failed', err);
      btn.disabled = false;
      fail(err && err.code === 'permission-denied' ? NOT_EDITOR + '.' : 'Could not save — try again.');
    });
  }

  function render(){
    bodyEl.innerHTML = editing ? formHtml() : viewHtml();
    if (!editing) {
      var open = el('editOpen');
      if (open) open.addEventListener('click', function(){ adding = false; openForm(); });
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
      }).catch(function(err){ console.error('[BOLD Collaboration Week] access check failed', err); });
    } catch (e){}
  }

  // --- hackathon: join the GitHub team ----------------------------------------
  // Its own box under the session, so the snapshot re-renders above don't wipe
  // what's being typed. Asking only records a request (joinHackathonTeam); a
  // PI/admin approves here, which is when it goes to GitHub (functions/index.js).

  var joinEl = null, join = { mine: null, canApprove: false, all: [] };
  if (base.hackathonJoin) {
    joinEl = document.createElement('div');
    joinEl.className = 'detail-field join-box';
    bodyEl.parentNode.appendChild(joinEl);
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
        console.error('[BOLD Collaboration Week] hackathon join request failed', err);
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
        console.error('[BOLD Collaboration Week] approving hackathon joins failed', err);
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
    }).catch(function(err){ console.error('[BOLD Collaboration Week] loading hackathon requests failed', err); });
  }

  render();
  renderJoin();
  var unsubscribe = null;
  // This session's talk docs: edits made on each talk's own page (title,
  // presentation link…), and the talks added here.
  function loadTalkEdits(){
    return db.collection('collabWeekTalks').where('sessionSlug', '==', base.slug).get().then(function(snap){
      talkEdits = {};
      snap.docs.forEach(function(d){ talkEdits[d.id] = d.data(); });
      if (!editing) (adding ? renderKeepingAdd : render)();
    }).catch(function(err){ console.error('[BOLD Collaboration Week] loading talk edits failed', err); });
  }

  BOLD.onUser(function(user){
    adding = false;
    me = user ? { email: user.email || '' } : null;
    fullWrite = false;
    editing = false;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    join = { mine: null, canApprove: false, all: [] };
    renderJoin();
    loadJoin();
    if (!user || !ref) { render(); return; }
    loadAccess();
    talkEdits = {};
    loadTalkEdits();
    unsubscribe = ref.onSnapshot(function(snap){
      saved = snap.exists ? snap.data() : null;
      if (!editing) (adding ? renderKeepingAdd : render)();
    }, function(err){
      console.error('[BOLD Collaboration Week] loading the session failed', err);
    });
  });
})();
