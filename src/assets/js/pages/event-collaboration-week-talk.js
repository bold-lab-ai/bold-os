// A Collaboration Week talk's page. The programme (src/_data, inlined as
// #talkData) is the default and the static first paint; Firestore's
// collabWeekTalks/{slug} holds what's been edited since, including the
// presentation link. The speaker, the session's leads and PIs/admins get an
// "Edit talk" button; saving goes through the editTalk function, which also
// says whether the signed-in person may. Speaker, day, time and duration
// belong to the schedule, so they aren't edited here.
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

  var FIELDS = [
    { key: 'title', label: 'Title', input: 'text' },
    { key: 'affiliation', label: 'Affiliation', input: 'text' },
    { key: 'presentationUrl', label: 'Presentation', input: 'text', placeholder: 'https://…', hint: 'Slides, a shared doc or a recording.' },
    { key: 'notes', label: 'Notes', input: 'text' },
    { key: 'abstract', label: 'Abstract', input: 'area', rows: 10 },
    { key: 'bio', label: 'About the speaker', input: 'area', rows: 6 }
  ];

  var saved = null, canEdit = false, editing = false, busy = false, error = '';

  function talk(){ return Object.assign({}, base, saved || {}); }

  function viewHtml(){
    var t = talk();
    var html = (TYPES[t.type] ? '<span class="type-badge type-' + esc(t.type) + '">' + esc(TYPES[t.type]) + '</span>' : '') +
      '<div class="detail-head"><h2>' + esc(t.title) + '</h2>' +
      (canEdit ? '<button class="btn" type="button" id="editOpen">Edit talk</button>' : '') + '</div><dl class="detail-grid">';
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
    });
    return html + '</div><div class="field-error" id="editError"' + (error ? '' : ' hidden') + '>' + esc(error) + '</div>' +
      '<div class="edit-actions"><button class="btn btn-primary" type="button" id="editSave"' + (busy ? ' disabled' : '') + '>Save</button>' +
      '<button class="btn" type="button" id="editCancel"' + (busy ? ' disabled' : '') + '>Cancel</button></div>';
  }

  function render(){
    bodyEl.innerHTML = editing ? formHtml() : viewHtml();
    if (!editing) {
      var open = el('editOpen');
      if (open) open.addEventListener('click', function(){ editing = true; error = ''; render(); });
      return;
    }
    el('editSave').addEventListener('click', save);
    el('editCancel').addEventListener('click', function(){ editing = false; error = ''; render(); });
  }

  function save(){
    if (busy) return;
    var edits = {};
    FIELDS.forEach(function(f){ edits[f.key] = el('f_' + f.key).value.trim(); });
    if (!edits.title) error = 'The title can’t be empty.';
    else if (edits.presentationUrl && !/^https?:\/\/\S+$/.test(edits.presentationUrl)) error = 'The presentation isn’t a link — paste the full https://… address.';
    else error = '';
    if (error) { keepTyped(edits); return; }
    busy = true; keepTyped(edits);
    editTalk({ slug: base.slug, edits: edits }).then(function(r){
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
    canEdit = false; editing = false;
    if (!user || !db) { render(); return; }
    db.collection('collabWeekTalks').doc(base.slug).get().then(function(snap){
      saved = snap.exists ? snap.data() : null;
      if (!editing) render();
    }).catch(function(err){ console.error('[BOLD Collaboration Week] loading the talk failed', err); });
    editTalk({ slug: base.slug }).then(function(r){
      canEdit = !!r.data.canEdit;
      if (!editing) render();
    }).catch(function(err){ console.error('[BOLD Collaboration Week] editTalk access check failed', err); });
  });
})();
