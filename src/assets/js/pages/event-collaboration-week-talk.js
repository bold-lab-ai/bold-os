// A Collaboration Week talk's page: the Presentation link. The rest of the
// page is static (event-collaboration-week-talk.njk). The link lives in
// Firestore's collabWeekTalks/{slug}; the speaker, the session's leads and
// PIs/admins can add or change it through the talkPresentation function,
// which also says whether the signed-in person may.
(function(){
  if (!BOLD.getAuth()) return;

  var esc = BOLD.escapeHtml;
  var box = document.getElementById('talkPresentation');
  if (!box) return;
  var slug = box.getAttribute('data-slug');

  var db = null;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){}
  function callable(){ return firebase.app().functions('europe-west2').httpsCallable('talkPresentation'); }

  var url = '';           // the saved link
  var canEdit = false;
  var editing = false;
  var busy = false;
  var error = '';

  function render(){
    if (editing) {
      box.innerHTML =
        '<div class="join-row"><input type="text" id="presUrl" value="' + esc(url) + '" placeholder="https://…">' +
        '<button class="btn btn-primary" type="button" id="presSave"' + (busy ? ' disabled' : '') + '>Save</button>' +
        '<button class="btn" type="button" id="presCancel"' + (busy ? ' disabled' : '') + '>Cancel</button></div>' +
        '<p class="edit-hint">Slides, a shared doc or a recording. Leave empty to remove it.</p>' +
        (error ? '<div class="field-error">' + esc(error) + '</div>' : '');
      var input = document.getElementById('presUrl');
      input.focus();
      input.addEventListener('keydown', function(e){ if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); });
      document.getElementById('presSave').addEventListener('click', save);
      document.getElementById('presCancel').addEventListener('click', cancel);
      return;
    }
    box.innerHTML = (url
      ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(url) + '</a>'
      : '<span class="detail-muted">Not added yet.</span>') +
      (canEdit ? ' <button class="btn-text" type="button" id="presEdit">' + (url ? 'Change' : 'Add link') + '</button>' : '');
    var btn = document.getElementById('presEdit');
    if (btn) btn.addEventListener('click', function(){ editing = true; error = ''; render(); });
  }

  function cancel(){ editing = false; error = ''; render(); }

  function save(){
    if (busy) return;
    var value = document.getElementById('presUrl').value.trim();
    if (value && !/^https?:\/\/\S+$/.test(value)) { error = 'That isn’t a link — paste the full https://… address.'; render(); return; }
    busy = true; error = ''; render();
    callable()({ slug: slug, url: value }).then(function(r){
      url = r.data.presentationUrl || '';
      busy = false; editing = false; render();
    }).catch(function(err){
      busy = false; error = (err && err.message) || 'Couldn’t save — try again.'; render();
    });
  }

  BOLD.onUser(function(user){
    canEdit = false; editing = false;
    if (!user || !db) { render(); return; }
    db.collection('collabWeekTalks').doc(slug).get().then(function(snap){
      url = (snap.exists && snap.data().presentationUrl) || '';
      render();
    }).catch(function(){ render(); });
    callable()({ slug: slug }).then(function(r){
      canEdit = !!r.data.canEdit;
      if (!editing) render();
    }).catch(function(err){ console.error('[BOLD Lab] talkPresentation', err); });
  });
})();
