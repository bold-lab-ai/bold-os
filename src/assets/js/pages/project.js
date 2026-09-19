// What authors.js (shared with the board) reads: the roster and a lookup in it.
var state = { people: [] };
function personByEmail(email){
  return email ? state.people.filter(function(p){ return p.email === email; })[0] || null : null;
}
function escapeHtml(s){ return BOLD.escapeHtml(s); }

(function(){
  // The masthead, gate and sidebar are bold.js's; this page fills in one project.
  if (!BOLD.getAuth()) return;

  var el = function(id){ return document.getElementById(id); };
  var esc = BOLD.escapeHtml;

  // Every project is a card (card-model.js): in `projects` until it has a venue, then in
  // that venue's cards (boards/{board}/cards/{id}). This page is the same for both and
  // shows the same head, details grid and abstract as a card's page on the board.
  // #id=<card id> for a project without a venue, #id=<card id>&board=<venue id> otherwise.
  var STAGE_LABELS = {
    register: 'Registered', pitch: 'Pitched', abstract: 'Abstract', paper: 'Paper',
    rebuttal: 'Rebuttal', camera_ready: 'Rebuttal Submitted', conference: 'Accepted'
  };
  var OUTCOME_LABELS = { accepted: 'Accepted', rejected: 'Rejected', withdrawn: 'Withdrawn' };
  var AUTHORS_LOCKED = 'Authors are locked once the abstract is submitted';
  var NOT_EDITOR = 'Only the project\u2019s submitter, authors, PIs and admins can do this';
  var NOT_SUBMITTER = 'Only the project\u2019s submitter, PIs and admins can do this';
  var CACHE_KEY = 'boldProjects:getAllProjects:'; // the Projects page's list cache, see projects.js
  var db = null, me = null, card = null, editing = false;
  var slack = { name: '', url: '' };  // the channel's link in Slack, once looked up
  var venueLabel = '';                // the venue's name, once read (only for a project in a venue)
  var fullWrite = false;   // the viewer is a PI or admin (getMyAccess)
  var keywordField = null, channelField = null;   // project-fields.js
  var authorRows = [];     // in-progress rows while editing the authors, see authors.js
  var projectId = (location.hash.match(/[#&]id=([^&]+)/) || [])[1];
  if (projectId) projectId = decodeURIComponent(projectId);
  var boardId = (location.hash.match(/[#&]board=([^&]+)/) || [])[1];
  if (boardId) boardId = decodeURIComponent(boardId);
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){}

  // The project and its Slack link are kept in localStorage: shown at once on the
  // next visit, then checked against Firestore (one document read) and redrawn only
  // if something changed. Cleared on sign-out.
  function projectRef(){
    return boardId
      ? db.collection('boards').doc(boardId).collection('cards').doc(projectId)
      : db.collection('projects').doc(projectId);
  }

  var CACHE_PREFIX = 'boldProject:';
  function cacheGet(id){
    try { return JSON.parse(localStorage.getItem(CACHE_PREFIX + id) || 'null'); } catch (e){ return null; }
  }
  function cachePut(){
    if (!card) return;
    try { localStorage.setItem(CACHE_PREFIX + projectId, JSON.stringify({ card: card, slack: slack, venueLabel: venueLabel })); } catch (e){}
  }
  function cacheDrop(id){
    try { localStorage.removeItem(CACHE_PREFIX + id); } catch (e){}
  }
  function cacheClear(){
    try {
      Object.keys(localStorage).forEach(function(k){ if (k.indexOf(CACHE_PREFIX) === 0) localStorage.removeItem(k); });
    } catch (e){}
  }

  function formatDate(ms){
    return ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  }

  function show(msg){
    el('detailMsg').textContent = msg;
    el('detailMsg').hidden = false;
  }

  function link(url){
    return '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(url) + '</a>';
  }

  function isMe(email){
    return !!(me && me.email && email && me.email.toLowerCase() === String(email).toLowerCase());
  }

  // Whoever registered the project, one of its authors, or a PI/admin can edit it.
  function canEdit(){
    return fullWrite || isMe(card.submittedBy && card.submittedBy.email) ||
      (card.authors || []).some(function(a){ return a && isMe(a.email); });
  }

  // Removing is the submitter's, or a PI's/admin's (what the Firestore rules allow).
  function canRemove(){ return fullWrite || isMe(card.submittedBy && card.submittedBy.email); }

  // Clients can't read `roles`, so ask the function; kept per person like the project.
  function loadAccess(){
    var email = (me && me.email || '').toLowerCase();
    var cached = cacheGet('access');
    if (cached && cached.email === email && cached.fullWrite !== fullWrite) { fullWrite = cached.fullWrite; if (card && !editing) render(); }
    try {
      firebase.app().functions('europe-west2').httpsCallable('getMyAccess')().then(function(r){
        var v = !!(r.data && r.data.fullWrite);
        try { localStorage.setItem(CACHE_PREFIX + 'access', JSON.stringify({ email: email, fullWrite: v })); } catch (e){}
        if (v !== fullWrite) { fullWrite = v; if (card && !editing) render(); }
      }).catch(function(err){ console.error('[BOLD Lab] access check failed', err); });
    } catch (e){}
  }

  // The channel as plain text, then a link to it in Slack once the function has
  // found it (a private channel, or a failed lookup, stays plain text). The link is
  // looked up once per channel and kept with the cached project.
  var slackPending = '';
  function showSlackLink(){
    var dd = el('slackChannel');
    if (dd && slack.url && slack.name === card.slackChannel) {
      dd.innerHTML = '<a href="' + esc(slack.url) + '" target="_blank" rel="noopener">' + esc(card.slackChannel) + '</a>';
    }
  }
  function linkSlackChannel(){
    if (!el('slackChannel')) return;
    if (slack.url && slack.name === card.slackChannel) return showSlackLink();
    var name = card.slackChannel;
    if (slackPending === name) return;
    slackPending = name;
    try {
      firebase.app().functions('europe-west2').httpsCallable('projectChannel')({ name: name, mode: 'check' })
        .then(function(r){
          slackPending = '';
          if (r.data && r.data.url) { slack = { name: name, url: r.data.url }; cachePut(); showSlackLink(); }
        })
        .catch(function(err){ slackPending = ''; console.error('[BOLD Lab] Slack channel lookup failed', err); });
    } catch (e){ slackPending = ''; }
  }

  // As on the board, the author list is fixed once the abstract has been submitted.
  function authorsLocked(){
    return card.status !== 'register' && card.status !== 'pitch';
  }

  // What every empty field shows.
  // A keyword opens the Projects list filtered by it.
  function keywordLink(k){ return '<a href="projects.html#keyword=' + encodeURIComponent(k) + '">' + esc(k) + '</a>'; }

  function missing(){ return '<span class="detail-muted">Not set</span>'; }
  function row(label, valueHtml, ddAttrs){ return '<dt>' + label + '</dt><dd' + (ddAttrs || '') + '>' + valueHtml + '</dd>'; }

  // The rows edited as a single field: label, the card field, how it shows, and its checks.
  var openLink = function(url){ return '<a href="' + esc(url) + '" target="_blank" rel="noopener">Open</a>'; };
  var SIMPLE = {
    overleaf: { label: 'Overleaf', field: 'overleafLink', type: 'url', required: true, check: function(v){ return overleafLinkIssue(v); },
      placeholder: 'https://www.overleaf.com/project/\u2026 \u2014 must allow edit access, not just view', view: link },
    pitch: { label: 'Pitch deck', field: 'pitchLink', type: 'url', placeholder: 'https://\u2026', view: openLink },
    arxiv: { label: 'arXiv', field: 'arxivLink', type: 'url', placeholder: 'https://arxiv.org/abs/\u2026', view: link },
    compute: { label: 'Compute', field: 'computeEstimate', type: 'text', placeholder: 'e.g. ~2000 A100-hours', view: esc }
  };

  function saveCancelHtml(saveId){
    return '<div class="field-error" id="detailEditError" hidden></div>' +
      '<div class="stage-fields-actions"><button class="btn" type="button" id="' + saveId + '">Save</button><button class="btn" type="button" id="editCancel">Cancel</button></div>';
  }

  // A row with an Edit button; while it's being edited, `editorHtml` (plus Save and Cancel) replaces the value.
  function editableRow(key, label, valueHtml, ddAttrs, editorHtml, saveId){
    return editing === key
      ? row(label, editorHtml + saveCancelHtml(saveId))
      : row(label, valueHtml + editButton(key), ddAttrs);
  }

  function simpleRow(key){
    var f = SIMPLE[key], v = card[f.field];
    return editableRow(key, f.label, v ? f.view(v) : missing(), '',
      '<input type="' + f.type + '" id="fieldInput" value="' + esc(v || '') + '" placeholder="' + esc(f.placeholder) + '">', 'fieldSave');
  }

  function editButton(what){
    var off = !canEdit() ? NOT_EDITOR : what === 'authors' && authorsLocked() ? AUTHORS_LOCKED : '';
    return ' <button class="btn-text detail-inline-edit" type="button" data-edit="' + what + '"' +
      (off ? ' disabled title="' + off + '"' : '') + '>Edit</button>';
  }

  function render(){
    var html = '<div class="detail-head"><h2>' + esc(card.title) + '</h2>';
    html += '<div class="detail-badges">';
    if (STAGE_LABELS[card.status]) html += '<span class="badge badge-stage">' + STAGE_LABELS[card.status] + '</span>';
    if (OUTCOME_LABELS[card.outcome] && !(card.outcome === 'accepted' && card.status === 'conference')) {
      html += '<span class="badge">' + OUTCOME_LABELS[card.outcome] + '</span>';
    }
    html += '<button class="btn-text danger detail-remove" type="button" id="removeProject"' + (canRemove() ? '' : ' disabled title="' + NOT_SUBMITTER + '"') + '>Remove project</button>';
    html += '</div></div>';
    // Only a project in a venue has this line.
    if (boardId && venueLabel) {
      html += '<p class="detail-venue">See project in: <a href="audit-board.html#board=' + encodeURIComponent(boardId) + '&card=' + encodeURIComponent(projectId) + '">' + esc(venueLabel) + '</a></p>';
    }

    // Every project shows the same rows, in the board card's order; a field that isn't
    // filled in says so.
    html += '<dl class="detail-grid">';
    html += '<dt>Authors</dt><dd>' + (editing === 'authors'
      ? '<div id="authorsWrap"></div>' +
        '<button class="btn-text" type="button" id="authorsAdd">+ Add author</button>' +
        '<div class="detail-hint">In author order \u2014 the last one is the PI.</div>' +
        '<div class="field-error" id="detailEditError" hidden></div>' +
        '<div class="stage-fields-actions"><button class="btn" type="button" id="authorsSave">Save</button><button class="btn" type="button" id="editCancel">Cancel</button></div>'
      : (card.authors && card.authors.length
          ? card.authors.map(function(a){ return esc(a.name || a.email || '?'); }).join(', ')
          : missing()) + editButton('authors')) + '</dd>';
    html += editableRow('slack', 'Slack channel', card.slackChannel ? esc(card.slackChannel) : missing(),
      card.slackChannel ? ' id="slackChannel"' : '',
      channelEntryHtml(card.slackChannel), 'slackSave');
    html += editableRow('keywords', 'Keywords', card.keywords && card.keywords.length ? card.keywords.map(keywordLink).join(', ') : missing(),
      '', '<div id="keywordEntry">' + keywordEntryHtml() + '</div>', 'keywordsSave');
    html += simpleRow('pitch');
    html += simpleRow('overleaf');
    html += simpleRow('arxiv');
    html += simpleRow('compute');
    html += row('Submitted by', card.submittedBy && card.submittedBy.name
      ? esc(card.submittedBy.name) + (card.submittedBy.email ? ' <span class="detail-muted">(' + esc(card.submittedBy.email) + ')</span>' : '')
      : missing());
    html += row('Registered', card.createdAt ? formatDate(card.createdAt) : missing());
    html += '</dl>';

    if (editing === 'abstract') {
      // Same editor as the registration form, with Save and Cancel.
      html += '<div class="detail-abstract">' + abstractTextFieldHtml(card.abstractText, '') +
        '<div class="field-error" id="detailEditError" hidden></div>' +
        '<div class="stage-fields-actions"><button class="btn" type="button" id="abstractSave">Save</button><button class="btn" type="button" id="editCancel">Cancel</button></div></div>';
    } else {
      html += '<div class="detail-abstract"><div class="detail-abstract-label">Abstract' +
        editButton('abstract') + '</div>' +
        (card.abstractText
          ? '<div class="abstract-render">' + renderAbstractHtml(card.abstractText) + '</div>'
          : missing()) + '</div>';
    }

    el('projectBody').innerHTML = html;
    el('projectBody').hidden = false;
    el('detailMsg').hidden = true;
    document.title = card.title + ' | BOLD Lab';
    linkSlackChannel();
    wireAbstract();
    el('removeProject').addEventListener('click', removeProject);
  }

  function wireAbstract(){
    Array.prototype.forEach.call(document.querySelectorAll('[data-edit]'), function(btn){
      btn.addEventListener('click', function(){
        if (!canEdit()) return;
        var what = btn.getAttribute('data-edit');
        if (what === 'authors' && authorsLocked()) return;
        if (what !== 'authors') { editing = what; return render(); }
        loadPeople().then(function(){
          // Same rows as the board's Edit fields: a saved author with no match in the roster
          // (someone outside the workspace) shows as a typed name + email.
          authorRows = card.authors && card.authors.length
            ? card.authors.map(function(a){ return { name: (a && a.name) || '', email: (a && a.email) || '', isNew: !(a && a.email && personByEmail(a.email)) }; })
            : [{ name: '', email: '', isNew: false }];
          editing = 'authors'; render();
        });
      });
    });
    if (!editing) return;
    el('editCancel').addEventListener('click', function(){ editing = false; render(); });
    if (editing === 'authors') {
      renderAuthorRows('authorsWrap', authorRows, null, false);
      el('authorsAdd').addEventListener('click', function(){
        authorRows.splice(Math.max(authorRows.length - 1, 0), 0, { name: '', email: '', isNew: false });
        renderAuthorRows('authorsWrap', authorRows, null, false);
      });
      el('authorsSave').addEventListener('click', saveAuthors);
    } else if (editing === 'abstract') {
      wireAbstractPreview();
      el('abstractSave').addEventListener('click', saveAbstract);
    } else if (editing === 'keywords') {
      var errorEl = el('detailEditError');
      keywordField = wireKeywordField(card.keywords, failer(), function(){ errorEl.hidden = true; });
      el('keywordsSave').addEventListener('click', saveKeywords);
    } else if (editing === 'slack') {
      channelField = wireChannelField('save');
      channelField.refresh();
      el('slackSave').addEventListener('click', saveSlack);
    } else {
      el('fieldSave').addEventListener('click', saveSimple);
    }
  }

  // Writes one field of the project's document, then shows it.
  function saveField(saveBtn, patch, fail){
    if (!canEdit() || !db) return fail(NOT_EDITOR + '.');
    saveBtn.disabled = true;
    projectRef().update(Object.assign({ updatedAt: Date.now() }, patch)).then(function(){
      Object.assign(card, patch);
      editing = false;
      cachePut();
      // The Projects page's cached list may still have the old value.
      try { localStorage.removeItem(CACHE_KEY + me.email.toLowerCase()); } catch (e){}
      render();
    }).catch(function(err){
      console.error('[BOLD Lab] saving the project failed', err);
      saveBtn.disabled = false;
      fail('Could not save \u2014 try again.');
    });
  }

  function failer(){
    var errorEl = el('detailEditError');
    return function(msg){ errorEl.textContent = msg; errorEl.hidden = false; };
  }

  // Deletes the project's document. Its Slack channel is left as it is.
  function removeProject(){
    if (!canRemove() || !db) return;
    if (!window.confirm('Remove "' + card.title + '"?')) return;
    var btn = el('removeProject');
    btn.disabled = true;
    projectRef().delete().then(function(){
      cacheDrop(projectId);
      try { localStorage.removeItem(CACHE_KEY + me.email.toLowerCase()); } catch (e){}
      location.href = 'projects.html#planned';
    }).catch(function(err){
      console.error('[BOLD Lab] removing the project failed', err);
      btn.disabled = false;
      window.alert('Could not remove the project \u2014 try again.');
    });
  }

  // The roster, for the author picker: loaded when editing authors, then kept like the project itself.
  var peoplePromise = null;
  function loadPeople(){
    if (peoplePromise) return peoplePromise;
    if (!state.people.length) {
      var cached = cacheGet('people');
      if (cached && cached.people) state.people = cached.people;
    }
    peoplePromise = db.collection('people').get().then(function(snap){
      var fresh = snap.docs.map(function(d){ return d.data(); })
        .sort(function(a, b){ return (a.name || '').localeCompare(b.name || ''); });
      state.people = fresh;
      try { localStorage.setItem(CACHE_PREFIX + 'people', JSON.stringify({ people: fresh })); } catch (e){}
    }).catch(function(err){ console.error('[BOLD Lab] loading the roster failed', err); });
    return peoplePromise;
  }

  function saveAuthors(){
    var fail = failer();
    if (authorsLocked()) return fail(AUTHORS_LOCKED + '.');
    var issue = authorRowsIssue(authorRows);
    if (issue) return fail(issue);
    var authors = authorsForSave(authorRows);
    saveField(el('authorsSave'), { authors: authors, authorEmails: authorEmailsOf(authors) }, fail);
  }

  function saveSimple(){
    var f = SIMPLE[editing], fail = failer(), v = el('fieldInput').value.trim();
    if (!v && f.required) return fail('Can\u2019t be blank.');
    if (v && f.type === 'url' && !/^https?:\/\//i.test(v)) return fail('Enter a full link, starting with https://');
    var issue = v && f.check && f.check(v);
    if (issue) return fail(issue);
    var patch = {}; patch[f.field] = v;
    saveField(el('fieldSave'), patch, fail);
  }

  function saveKeywords(){
    keywordField.addTyped();
    saveField(el('keywordsSave'), { keywords: keywordField.get().slice() }, failer());
  }

  // As on the registration form: the name gets proj- if it lacks it, the channel is
  // created (and you invited) if it doesn't exist, and only then is it saved.
  function saveSlack(){
    var fail = failer(), n = normalizeProjectChannel(el('pfChannel').value), btn = el('slackSave');
    if (n.error) return fail(n.error);
    btn.disabled = true;
    channelField.ensure(n.name).then(function(r){
      slack = { name: '#' + r.name, url: r.url || '' };
      btn.disabled = false;
      saveField(btn, { slackChannel: '#' + r.name }, fail);
    }).catch(function(err){
      console.error('[BOLD Lab] setting up the Slack channel failed', err);
      btn.disabled = false;
      channelField.refresh();
      var code = err && err.code;
      fail((code === 'functions/failed-precondition' || code === 'functions/invalid-argument') && err.message
        ? err.message
        : 'Could not set up the Slack channel \u2014 try again.');
    });
  }

  function saveAbstract(){
    var fail = failer();
    var text = el('stageAbstractText').value.trim();
    if (!text) return fail('Can\u2019t be blank.');
    if (text.length > ABSTRACT_MAX_CHARS) return fail('The abstract can be at most ' + ABSTRACT_MAX_CHARS + ' characters.');
    saveField(el('abstractSave'), { abstractText: text }, fail);
  }
  // The venue's name, for the "See project in" line; redrawn only if it changed.
  function loadVenueLabel(){
    if (!boardId || !db) return;
    db.collection('boards').doc(boardId).get().then(function(doc){
      var label = doc.exists ? (doc.data().label || boardId) : '';
      if (label === venueLabel) return;
      venueLabel = label;
      cachePut();
      if (card && !editing) render();
    }).catch(function(err){ console.error('[BOLD Lab] loading the venue failed', err); });
  }

  // Whatever is on screen stays until Firestore has answered; then the page is redrawn
  // only if the project differs (never while a field is being edited).
  function load(){
    if (!projectId) return show('No project selected.');
    if (!db) return card || show('Could not load the project.');
    loadVenueLabel();
    projectRef().get().then(function(doc){
      if (!doc.exists) {
        cacheDrop(projectId);
        card = null;
        el('projectBody').hidden = true;
        return show('This project isn\u2019t here \u2014 it may have been removed. Find it under Projects.');
      }
      var fresh = doc.data();
      var changed = !card || JSON.stringify(fresh) !== JSON.stringify(card);
      card = fresh;
      cachePut();
      if (changed && !editing) render();
    }).catch(function(err){
      console.error('[BOLD Lab] loading project failed', err);
      if (!card) show('Could not load the project.');
    });
  }

  // First paint from the last visit's copy, before Firebase has loaded.
  try {
    var hint = BOLD.authHint(), hit = projectId && hint && hint.e ? cacheGet(projectId) : null;
    if (hit && hit.card) {
      me = { email: hint.e };
      var access = cacheGet('access');
      fullWrite = !!(access && access.email === hint.e.toLowerCase() && access.fullWrite);
      card = hit.card;
      slack = hit.slack || slack;
      venueLabel = hit.venueLabel || '';
      render();
    }
  } catch (e){}

  // Firestore reads need the signed-in user; the gate has already checked.
  BOLD.onUser(function(user){
    var was = me && me.email && me.email.toLowerCase();
    me = user;
    if (!user) return cacheClear();
    // The Edit buttons depend on who's signed in; already right if the first paint used the same person.
    if (card && !editing && was !== (user.email || '').toLowerCase()) render();
    load();
    loadAccess();
  });
})();
