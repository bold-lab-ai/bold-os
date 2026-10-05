// A Collaboration Week talk's page. The programme (src/_data, inlined as
// #talkData) is the default and the static first paint; Firestore's
// collabWeekTalks/{slug} holds what's been edited since, including the
// presentation link, and the presenters' sign-in emails. A presenter, a lead
// of the session or a PI/admin gets an "Edit talk" button; only leads and
// PIs/admins can set who the presenters are. Saving goes through the editTalk
// function, which also says what the signed-in person may do. Speaker, day,
// time and duration belong to the schedule, so they aren't edited here.
(function(){
  if (!BOLD.getAuth()) return;

  var esc = BOLD.escapeHtml;
  var el = function(id){ return document.getElementById(id); };
  var bodyEl = el('talkBody');
  var base = JSON.parse(el('talkData').textContent);
  var venue = JSON.parse(el('talkLocation').textContent) || {};
  var TYPES = JSON.parse(el('talkTypes').textContent) || {};

  var db = null;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){}
  function editTalk(data){ return firebase.app().functions('europe-west2').httpsCallable('editTalk')(data); }

  var NOT_EDITOR = 'Only the talk’s presenters, the session’s leads, PIs and admins can edit it';

  var FIELDS = [
    { key: 'title', label: 'Title', input: 'text' },
    { key: 'affiliation', label: 'Affiliation', input: 'text' },
    { key: 'presentationUrl', label: 'Presentation', input: 'text', placeholder: 'https://…', hint: 'Slides, a shared doc or a recording.' },
    { key: 'notes', label: 'Notes', input: 'text' },
    { key: 'abstract', label: 'Abstract', input: 'area', rows: 10 },
    { key: 'bio', label: 'About the speaker', input: 'area', rows: 6 }
  ];

  var saved = null, canEdit = false, canSetPresenters = false, editing = false, busy = false, error = '';
  var people = [];          // the `people` roster, for the presenters picker
  var presenterRows = [];   // { email, free } while the form is open
  var suggested = false;    // presenterRows were guessed from the speaker's name

  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function personFor(email){ return people.filter(function(p){ return p.email === email; })[0]; }

  // Saved presenters, or, before any are set, roster people named like the speaker.
  function startPresenterRows(){
    var emails = saved && saved.presenterEmails;
    suggested = !emails;
    if (!emails) {
      var names = String(base.speaker || '').split(/,|&|\band\b/).map(function(n){ return n.trim().toLowerCase(); }).filter(Boolean);
      emails = people.filter(function(p){ return p.email && names.indexOf(String(p.name || '').trim().toLowerCase()) >= 0; })
        .map(function(p){ return p.email; });
    }
    presenterRows = emails.map(function(e){ return { email: e, free: !personFor(e) }; });
    if (!presenterRows.length) presenterRows.push({ email: '', free: false });
  }

  function presentersHtml(){
    if (!canSetPresenters) return '';
    return '<div class="edit-field"><span class="edit-label">Presenters</span>' +
      presenterRows.map(function(r, i){
        var control = r.free
          ? '<input type="text" class="pres-email" data-i="' + i + '" value="' + esc(r.email) + '" placeholder="Their Slack sign-in email">' +
            '<button type="button" class="btn-text pres-roster" data-i="' + i + '">Pick from list</button>'
          : '<select class="pres-select" data-i="' + i + '"><option value="">Choose a person…</option>' +
            people.map(function(p){
              return '<option value="' + esc(p.email) + '"' + (p.email === r.email ? ' selected' : '') + '>' + esc(p.name) + ' (' + esc(p.email) + ')</option>';
            }).join('') + '<option value="__free__">Someone not on the list…</option></select>';
        return '<div class="lead-row">' + control +
          '<button type="button" class="btn-text danger pres-remove" data-i="' + i + '">Remove</button></div>';
      }).join('') +
      '<button type="button" class="btn-text" id="presAdd">+ Add a presenter</button>' +
      '<p class="edit-hint">' + (suggested ? 'Suggested from the speaker’s name — check before saving. ' : '') +
      'Presenters can edit this talk, matched by the email they sign in to Slack with.</p></div>';
  }

  function wirePresenters(){
    if (!canSetPresenters) return;
    bodyEl.querySelectorAll('.pres-select').forEach(function(sel){
      sel.addEventListener('change', function(){
        var i = Number(sel.getAttribute('data-i'));
        presenterRows[i] = sel.value === '__free__' ? { email: '', free: true } : { email: sel.value, free: false };
        keepTyped(readFields());
      });
    });
    bodyEl.querySelectorAll('.pres-email').forEach(function(inp){
      inp.addEventListener('input', function(){ presenterRows[Number(inp.getAttribute('data-i'))].email = inp.value; });
    });
    bodyEl.querySelectorAll('.pres-roster').forEach(function(btn){
      btn.addEventListener('click', function(){ presenterRows[Number(btn.getAttribute('data-i'))] = { email: '', free: false }; keepTyped(readFields()); });
    });
    bodyEl.querySelectorAll('.pres-remove').forEach(function(btn){
      btn.addEventListener('click', function(){ presenterRows.splice(Number(btn.getAttribute('data-i')), 1); keepTyped(readFields()); });
    });
    el('presAdd').addEventListener('click', function(){ presenterRows.push({ email: '', free: false }); keepTyped(readFields()); });
  }

  var peoplePromise = null;
  function loadPeople(){
    if (!peoplePromise) peoplePromise = db.collection('people').get().then(function(snap){
      people = snap.docs.map(function(d){ return d.data(); }).filter(function(p){ return p.email; })
        .sort(function(a, b){ return (a.name || '').localeCompare(b.name || ''); });
    }).catch(function(err){ console.error('[BOLD Collaboration Week] loading the roster failed', err); });
    return peoplePromise;
  }

  function talk(){ return Object.assign({}, base, saved || {}); }

  function viewHtml(){
    var t = talk();
    var html = (TYPES[t.type] ? '<span class="type-badge type-' + esc(t.type) + '">' + esc(TYPES[t.type]) + '</span>' : '') +
      '<div class="detail-head"><h2>' + esc(t.title) + '</h2>' +
      '<button class="btn" type="button" id="editOpen"' + (canEdit ? '' : ' disabled title="' + esc(NOT_EDITOR) + '"') + '>Edit talk</button>' +
      '</div><dl class="detail-grid">';
    if (t.speaker) html += '<dt>Speaker</dt><dd>' + esc(t.speaker) + (t.affiliation ? ' <span class="detail-muted">(' + esc(t.affiliation) + ')</span>' : '') + '</dd>';
    if (t.sessionSlug) html += '<dt>Session</dt><dd><a href="event-collaboration-week-session-' + esc(t.sessionSlug) + '.html">' + esc(t.sessionTitle) + '</a></dd>';
    if (t.day) html += '<dt>When</dt><dd>' + esc(t.day) + (t.time ? ', ' + esc(t.time) : '') + '</dd>';
    if (venue.name) html += '<dt>Where</dt><dd>' + esc(venue.name) +
      (venue.mapsUrl ? ' &middot; <a href="' + esc(venue.mapsUrl) + '" target="_blank" rel="noopener">Open in Google Maps</a>' : '') +
      (venue.address ? '<span class="meta">' + esc(venue.address) + '</span>' : '') + '</dd>';
    if (t.duration) html += '<dt>Duration</dt><dd>' + esc(t.duration) + '</dd>';
    if (t.notes) html += '<dt>Notes</dt><dd>' + esc(t.notes) + '</dd>';
    if (t.presentationUrl) html += '<dt>Presentation</dt><dd class="talk-pres"><a href="' + esc(t.presentationUrl) + '" target="_blank" rel="noopener">' + esc(t.presentationUrl) + '</a></dd>';
    html += '</dl><div class="detail-field"><p class="detail-field-label">Abstract</p>' +
      (t.abstract ? '<p class="talk-text">' + esc(t.abstract) + '</p>' : '<p class="detail-muted">Abstract not yet available.</p>') + '</div>';
    if (t.bio) html += '<div class="detail-field"><p class="detail-field-label">About the speaker</p><p class="talk-text">' + esc(t.bio) + '</p></div>';
    return html;
  }

  function formHtml(){
    var t = talk();
    var html = '<div class="detail-head"><h2>Edit talk</h2></div>' +
      '<p class="detail-subtitle">' + esc(t.speaker || '') + (t.day ? ' · ' + esc(t.day) + (t.time ? ', ' + esc(t.time) : '') : '') +
      (t.duration ? ' · ' + esc(t.duration) : '') + ' — speaker, time and duration are set with the schedule.</p><div class="edit-form">';
    FIELDS.forEach(function(f){
      var id = 'f_' + f.key, v = t[f.key] || '';
      html += '<div class="edit-field"><label for="' + id + '">' + esc(f.label) + '</label>' +
        (f.input === 'text'
          ? '<input type="text" id="' + id + '" value="' + esc(v) + '" placeholder="' + esc(f.placeholder || '') + '">'
          : '<textarea id="' + id + '" rows="' + f.rows + '">' + esc(v) + '</textarea>') +
        (f.hint ? '<p class="edit-hint">' + esc(f.hint) + '</p>' : '') + '</div>';
      if (f.key === 'title') html += presentersHtml();
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
      return;
    }
    wirePresenters();
    el('editSave').addEventListener('click', save);
    el('editCancel').addEventListener('click', function(){ editing = false; error = ''; render(); });
  }

  function openForm(){
    var go = function(){ startPresenterRows(); editing = true; error = ''; render(); };
    if (canSetPresenters) loadPeople().then(go); else go();
  }

  function readFields(){
    var edits = {};
    FIELDS.forEach(function(f){ edits[f.key] = el('f_' + f.key).value.trim(); });
    return edits;
  }

  function save(){
    if (busy) return;
    var edits = readFields();
    var emails = presenterRows.map(function(r){ return r.email.trim().toLowerCase(); }).filter(Boolean);
    var badEmail = emails.filter(function(e){ return !EMAIL.test(e); })[0];
    if (!edits.title) error = 'The title can’t be empty.';
    else if (canSetPresenters && badEmail) error = 'Not an email: ' + badEmail;
    else if (edits.presentationUrl && !/^https?:\/\/\S+$/.test(edits.presentationUrl)) error = 'The presentation isn’t a link — paste the full https://… address.';
    else error = '';
    if (error) { keepTyped(edits); return; }
    busy = true; keepTyped(edits);
    var payload = Object.assign({}, edits);
    if (canSetPresenters) payload.presenterEmails = emails;
    editTalk({ slug: base.slug, edits: payload }).then(function(r){
      saved = Object.assign({}, saved || {}, r.data.saved);
      busy = false; editing = false; render();
    }).catch(function(err){
      busy = false; error = (err && err.message) || 'Couldn’t save — try again.'; keepTyped(edits);
    });
  }

  // Re-render the form (to show busy/error) without losing what was typed.
  function keepTyped(edits){
    render();
    FIELDS.forEach(function(f){ el('f_' + f.key).value = edits[f.key]; });
  }

  BOLD.onUser(function(user){
    canEdit = false; canSetPresenters = false; editing = false;
    if (!user || !db) { render(); return; }
    db.collection('collabWeekTalks').doc(base.slug).get().then(function(snap){
      saved = snap.exists ? snap.data() : null;
      if (!editing) render();
    }).catch(function(err){ console.error('[BOLD Collaboration Week] loading the talk failed', err); });
    editTalk({ slug: base.slug }).then(function(r){
      canEdit = !!r.data.canEdit;
      canSetPresenters = !!r.data.canSetPresenters;
      if (!editing) render();
    }).catch(function(err){ console.error('[BOLD Collaboration Week] editTalk access check failed', err); });
  });
})();
