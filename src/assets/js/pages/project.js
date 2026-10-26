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
  // Its meeting, slides, notes, members and venues: projectWorkspaces/{project id},
  // kept by the server (projectWorkspace in functions/index.js), followed live. The
  // project id is the card's projectId (a card submitted to another venue from here),
  // or the card's own id.
  var ws = null, wsLoaded = false, wsUnsub = null, wsBusy = false, wsMsg = '', wsKey = '';
  // Its presentations, projectWorkspaces/{id}/presentations, newest first.
  var talks = [], talksUnsub = null;
  // Where each was given (`occasion`): one of the site's events, a venue on the board,
  // or another occasion, named. Group meetings come later, from the meetings rota.
  // Presentations saved before had a `kind` instead; they still show by it.
  // A presentation's type: a talk's (src/_data/collabWeekTypes.js), the same for both.
  var PRES_TYPES = [['research-talk', 'Research talk'], ['pitch', 'Pitch'], ['keynote', 'Keynote']];
  var OLD_KINDS = { group: 'Group meeting', pitch: 'Pitch Day', conference: 'Conference', invited: 'Invited talk', other: 'Other' };
  var events = null;   // the released events, loaded when a presentation is edited
  var authorRows = [];     // in-progress rows while editing the authors, see authors.js
  var projectId = (location.hash.match(/[#&]id=([^&]+)/) || [])[1];
  if (projectId) projectId = decodeURIComponent(projectId);
  var boardId = (location.hash.match(/[#&]board=([^&]+)/) || [])[1];
  if (boardId) boardId = decodeURIComponent(boardId);
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){}

  // Back to the Projects tab and filters you came from (projects.js keeps them).
  try {
    var back = sessionStorage.getItem('boldProjects:back');
    if (back) el('detailBack').href = 'projects.html' + back;
  } catch (e){}

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
    title: { label: 'Title', field: 'title', type: 'text', required: true, placeholder: 'The project\u2019s title', view: esc },
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

  // The page's tabs, chosen by &tab= in the address (Overview when there's none).
  var TABS = [['overview', 'Overview'], ['presentations', 'Presentations'], ['paper', 'Papers']];
  var tab = (location.hash.match(/[#&]tab=([^&]+)/) || [])[1];
  // The Team tab's people and channel are on Overview now, its meeting, slides and notes on Presentations.
  if (tab === 'team') tab = 'overview';
  if (!TABS.some(function(t){ return t[0] === tab; })) tab = 'overview';
  // &join=1, the link in a project's #all-active-projects announcement: join it
  // once it's loaded, on the Overview tab (maybeJoin).
  var joinRequested = /[#&]join=1(&|$)/.test(location.hash);
  // &pres=<id>: one presentation (from an event's Projects tab), scrolled to and marked once it's drawn.
  var presWanted = (location.hash.match(/[#&]pres=([^&]+)/) || [])[1] || '';, presScrolled = false;
  if (joinRequested) tab = 'overview';

  function setTab(name, focus){
    if (name === tab) return;
    var hash = location.hash.replace(/&tab=[^&]*/, '') + (name === 'overview' ? '' : '&tab=' + name);
    try { history.replaceState(null, '', location.pathname + location.search + hash); } catch (e){}
    BOLD.switchTab('.tabs', el('projectBody'), function(){ tab = name; editing = false; render(); });
    if (focus) document.querySelector('.tab.active').focus();
  }

  // What each tab shows; a field that isn't filled in says so.
  var PANELS = {
    // What the project is.
    overview: function(){
      var html = '<dl class="detail-grid">';
      html += '<dt>Authors</dt><dd>' + (editing === 'authors'
        ? '<div id="authorsWrap"></div>' +
          '<button class="btn-text" type="button" id="authorsAdd">+ Add author</button>' +
          '<div class="detail-hint">In author order \u2014 the last one is the PI.</div>' +
          '<div class="field-error" id="detailEditError" hidden></div>' +
          '<div class="stage-fields-actions"><button class="btn" type="button" id="authorsSave">Save</button><button class="btn" type="button" id="editCancel">Cancel</button></div>'
        : (card.authors && card.authors.length
            ? card.authors.map(function(a){ return esc(a.name || a.email || '?'); }).join(', ')
            : missing()) + editButton('authors')) + '</dd>';
      html += peopleRows();
      html += editableRow('keywords', 'Keywords', card.keywords && card.keywords.length ? card.keywords.map(keywordLink).join(', ') : missing(),
        '', '<div id="keywordEntry">' + keywordEntryHtml() + '</div>', 'keywordsSave');
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
      return html;
    },
    // Its meeting, slides and notes; talks about the project; the pitch deck is the card's own (the board uses it).
    presentations: function(){
      return '<dl class="detail-grid">' + workspaceRows() + simpleRow('pitch') + '</dl>' + presentationsHtml();
    },
    // The write-up and its submission.
    paper: function(){
      return '<dl class="detail-grid">' + row('Venues', venuesHtml()) +
        repoRow() + simpleRow('overleaf') + simpleRow('arxiv') + simpleRow('compute') + '</dl>';
    }
  };

  function render(){
    // The title, edited in place (Edit beside it).
    var html = '<div class="detail-head">' + (editing === 'title'
      ? '<div class="detail-title-edit"><input type="text" id="fieldInput" maxlength="300" value="' + esc(card.title || '') + '" aria-label="Title">' + saveCancelHtml('fieldSave') + '</div>'
      : '<h2>' + esc(card.title) + editButton('title') + '</h2>');
    html += '<div class="detail-badges">';
    if (STAGE_LABELS[card.status]) html += '<span class="badge badge-stage">' + STAGE_LABELS[card.status] + '</span>';
    if (OUTCOME_LABELS[card.outcome] && !(card.outcome === 'accepted' && card.status === 'conference')) {
      html += '<span class="badge">' + OUTCOME_LABELS[card.outcome] + '</span>';
    }
    if (ws && ws.completedAt) html += '<span class="badge">Completed</span>';
    // Marking it completed (or reopening it): its meeting is cancelled (or comes back).
    var done = !!(ws && ws.completedAt);
    // Join (or Leave, for whoever joined rather than registered or wrote it).
    html += joinButton();
    html += '<button class="btn-box detail-remove" type="button" id="completeProject"' + (canEdit() && wsLoaded && !wsBusy ? '' : ' disabled title="' + (canEdit() ? 'Loading\u2026' : NOT_EDITOR) + '"') + '>' +
      (done ? 'Reopen project' : 'Mark as completed') + '</button>';
    html += '<button class="btn-box danger" type="button" id="removeProject"' + (canRemove() ? '' : ' disabled title="' + NOT_SUBMITTER + '"') + '>Remove project</button>';
    html += '</div></div>';
    html += '<div class="tabs" role="tablist" aria-label="Project">' + TABS.map(function(t){
      var on = t[0] === tab;
      return '<button class="tab' + (on ? ' active' : '') + '" type="button" role="tab" data-tab="' + t[0] + '" aria-selected="' + on + '"' +
        (on ? '' : ' tabindex="-1"') + ' aria-controls="projectPanel">' + t[1] + '</button>';
    }).join('') + '</div>';
    html += '<div class="tab-panel" id="projectPanel" role="tabpanel">' + PANELS[tab]() + '</div>';

    el('projectBody').innerHTML = html;
    el('projectBody').hidden = false;
    el('detailMsg').hidden = true;
    document.title = card.title + ' | BOLD Lab';
    linkSlackChannel();
    wireAbstract();
    el('removeProject').addEventListener('click', removeProject);
    el('completeProject').addEventListener('click', completeProject);
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function(t, i, all){
      t.addEventListener('click', function(){ setTab(t.getAttribute('data-tab')); });
      t.addEventListener('keydown', function(e){
        var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        setTab(all[(i + d + all.length) % all.length].getAttribute('data-tab'), true);
      });
    });
  }

  // Left out when it was registered (projectWorkspace's `skipped`), until it's done.
  function skipped(key){
    return ws && (ws.skipped || []).indexOf(key) >= 0 ? ' <span class="detail-muted">\u00b7 skipped when it was registered</span>' : '';
  }
  function wsButton(action, label){
    return ' <button class="btn-text detail-inline-edit" type="button" data-ws="' + action + '"' + (wsBusy || !wsLoaded ? ' disabled' : '') + '>' + label + '</button>';
  }

  // The workspace's rows: meeting, slides, notes.
  function workspaceRows(){
    var setting = ws && ws.syncing, failed = ws && ws.error;
    var state = !wsLoaded ? '<span class="detail-muted">Loading\u2026</span>'
      : setting ? '<span class="detail-muted">Setting up\u2026</span>'
      : failed ? '<span class="detail-muted">' + esc(ws.error) + '</span>'
      : missing();
    var retry = wsLoaded && !setting && (failed || !ws || !ws.deckUrl)
      ? ' <button class="btn-text detail-inline-edit" type="button" data-ws="setUp"' + (canEdit() && !wsBusy ? '' : ' disabled title="' + NOT_EDITOR + '"') + '>' + (failed ? 'Try again' : 'Set up') + '</button>'
      : '';
    var m = ws && ws.meeting;
    // Chosen but not in Google Calendar yet (the lab's Google account isn't connected, say).
    // Pausing cancels it in Google Calendar and keeps the time; resuming sends a new invitation.
    var pauseBtn = function(action){
      return ' <button class="btn-text detail-inline-edit" type="button" data-ws="' + action + '"' + (canEdit() && !wsBusy ? '' : ' disabled title="' + NOT_EDITOR + '"') + '>' + (action === 'pause' ? 'Pause' : 'Resume') + '</button>';
    };
    var meeting = m && ws.pausedAt && ws.group !== 'completed' ? esc(meetingText(m)) + ' <span class="detail-muted">\u00b7 paused</span>' + pauseBtn('resume')
      : m && !ws.eventId ? esc(meetingText(m)) + ' <span class="detail-muted">\u00b7 ' + (ws.group === 'completed' ? 'ended with the project' : 'not set up yet') + '</span>'
      : m ? esc(meetingText(m)) + pauseBtn('pause') +
        (ws.meetUrl ? ' \u00b7 <a href="' + esc(ws.meetUrl) + '" target="_blank" rel="noopener">' + meetLabel(m) + '</a>' : '') +
        (ws.eventLink ? ' \u00b7 <a href="' + esc(ws.eventLink) + '" target="_blank" rel="noopener">Calendar</a>' : '')
      : wsLoaded && !setting ? missing() + skipped('meeting') : state;
    var html = editableRow('meeting', 'Meeting', meeting, '',
      meetingEntryHtml(m) + (m ? '<button class="btn-text danger" type="button" id="meetingRemove">Remove the meeting</button>' : ''), 'meetingSave');
    html += row('Slides', ws && ws.deckUrl ? openLink(ws.deckUrl) : state + (ws && ws.noDocs ? skipped('docs') : '') + retry);
    html += row('Meeting notes', ws && ws.notesUrl ? openLink(ws.notesUrl) : failed ? missing() : state);
    // Set up part way (shared with some members, say): the error and Try again stay.
    if (failed && ws.deckUrl && !setting) html += row('Setting up', '<span class="detail-muted">' + esc(ws.error) + '</span>' + retry);
    return html;
  }

  // Every venue it went to, oldest first, each linked to its card on the board (the
  // latest's fields are the ones on this page); then submitting it to another.
  function venuesHtml(){
    var list = (ws && ws.venues) || [{ cardId: projectId, boardId: boardId, label: venueLabel, status: card.status, outcome: card.outcome }];
    var html = '<ul class="venue-list">' + list.map(function(v){
      if (!v.boardId) return '<li><span class="detail-muted">No venue yet</span></li>';
      var stage = OUTCOME_LABELS[v.outcome] || STAGE_LABELS[v.status] || '';
      return '<li><a href="audit-board.html#board=' + encodeURIComponent(v.boardId) + '&card=' + encodeURIComponent(v.cardId) + '">' + esc(v.label || v.boardId) + '</a>' +
        (stage ? ' <span class="detail-muted">\u00b7 ' + esc(stage) + '</span>' : '') + '</li>';
    }).join('') + '</ul>';
    if (editing === 'submit') {
      var taken = list.map(function(v){ return v.boardId; });
      var options = venues ? venues.filter(function(v){ return taken.indexOf(v.id) < 0; }) : null;
      html += !options ? '<span class="detail-muted">Loading venues\u2026</span>'
        : !options.length ? '<span class="detail-muted">No other venue on the board yet.</span>'
        : '<select id="submitVenue" aria-label="Venue">' + options.map(function(v){ return '<option value="' + esc(v.id) + '">' + esc(v.label) + '</option>'; }).join('') + '</select>' +
          '<div class="detail-hint">A new card there, registered by you, with this project\u2019s title, abstract, authors and links; its meeting, repository and people stay as they are.</div>';
      html += saveCancelHtml('submitSave');
    } else {
      html += '<button class="btn-text" type="button" data-edit="submit"' + (canEdit() ? '' : ' disabled title="' + NOT_EDITOR + '"') + '>Submit to a venue</button>';
    }
    return html;
  }

  var venues = null;   // the approved venues, loaded when submitting
  function loadVenues(){
    if (venues) return;
    callWorkspace({ action: 'venues' }).then(function(r){
      venues = (r.data && r.data.venues) || [];
      if (editing === 'submit') render();
      if (editing && editing.indexOf('talk:') === 0) renderTalkOccasion();
    }).catch(function(err){ console.error('[BOLD Lab] loading the venues failed', err); venues = []; if (editing === 'submit') render(); });
  }

  // A new card at the chosen venue, made as the board makes one (card-model.js), with
  // this card's details; the server files it under this project.
  function submitToVenue(){
    var fail = failer(), venue = el('submitVenue') && el('submitVenue').value;
    if (!venue) return fail('Choose a venue.');
    var next = makeRegisteredCard({ name: me.displayName, email: me.email }, {
      title: card.title, abstractText: card.abstractText, keywords: card.keywords, slackChannel: card.slackChannel,
      computeEstimate: card.computeEstimate
    });
    ['authors', 'authorEmails', 'overleafLink', 'arxivLink', 'pitchLink'].forEach(function(k){ if (card[k]) next[k] = card[k]; });
    el('submitSave').disabled = true;
    callWorkspace({ action: 'submit', venue: venue, card: next }).then(function(r){
      try { localStorage.removeItem(CACHE_KEY + me.email.toLowerCase()); } catch (e){}
      location.href = 'audit-board.html#board=' + encodeURIComponent(r.data.boardId) + '&card=' + encodeURIComponent(r.data.cardId);
    }).catch(function(err){
      console.error('[BOLD Lab] submitting to a venue failed', err);
      el('submitSave').disabled = false;
      fail((err && err.message) || 'Could not submit it \u2014 try again.');
    });
  }

  // Its GitHub repository: a link once there is one; until then editors choose its
  // template, as on the register form.
  function repoRow(){
    var linked = ws && ws.repoUrl;
    var value = linked ? '<a href="' + esc(ws.repoUrl) + '" target="_blank" rel="noopener">' + esc(ws.repoUrl.replace(/^https:\/\/github\.com\//, '')) + '</a>'
      : !wsLoaded ? '<span class="detail-muted">Loading\u2026</span>'
      : ws && ws.repoError ? '<span class="detail-muted">' + esc(ws.repoError) + '</span>'
      : ws && ws.repo && ws.syncing ? '<span class="detail-muted">Setting up\u2026</span>'
      : missing() + skipped('repo');
    var retry = ws && ws.repoError && ws.repo && !linked
      ? ' <button class="btn-text detail-inline-edit" type="button" data-ws="setUp"' + (canEdit() && !wsBusy ? '' : ' disabled title="' + NOT_EDITOR + '"') + '>Try again</button>' : '';
    // Once made, it stays.
    if (ws && ws.repoName) return row('Repository', value);
    return editableRow('repo', 'Repository', value + retry, '', repoEntryHtml(), 'repoSave');
  }

  function saveRepo(){
    var fail = failer(), repo = readRepoEntry();
    if (repo.error) return fail(repo.error);
    BOLD.confirmAction({ title: 'Make the repository?', go: 'Make it', effects: [
      'Make the project\u2019s GitHub repository in bold-lab-ai, from the ' + repo.template + ' template'] }).then(function(ok){ if (ok) sendRepo(repo, fail); });
  }
  function sendRepo(repo, fail){
    el('repoSave').disabled = true;
    callWorkspace({ action: 'repo', repo: repo }).then(function(r){
      if (r.data && r.data.repoError) { el('repoSave').disabled = false; return fail(r.data.repoError); }
      editing = false; render();
    }).catch(function(err){
      console.error('[BOLD Lab] setting up the repository failed', err);
      el('repoSave').disabled = false;
      fail((err && err.message) || 'Could not save \u2014 try again.');
    });
  }

  // Whoever registered it, its authors and whoever joined.
  function memberEmails(){
    if (ws && ws.members) return ws.members;
    return [card.submittedBy && card.submittedBy.email].concat(card.authorEmails || []).filter(function(e, i, all){ return e && all.indexOf(e) === i; });
  }
  // Overview's: who's on it, its Slack channel, and its announcement if that was skipped.
  function peopleRows(){
    return row('People', membersHtml()) +
      editableRow('slack', 'Slack channel', card.slackChannel ? '<span id="slackChannel">' + esc(card.slackChannel) + '</span>' +
          (ws && me && (ws.slackSkipped || []).indexOf(me.email.toLowerCase()) >= 0 ? ' <span class="detail-muted">\u00b7 you skipped joining it</span>' + wsButton('slack', 'Join it') : '')
        : missing() + skipped('channel'),
        '', channelEntryHtml(card.slackChannel), 'slackSave') +
      (ws && (ws.skipped || []).indexOf('announce') >= 0 ? row('Announcement', '<span class="detail-muted">Not announced in #all-active-projects</span>' + skipped('announce') +
        (canEdit() ? wsButton('announce', 'Announce') : '')) : '');
  }
  function membersHtml(){
    var list = memberEmails();
    var names = list.map(function(e){ var p = personByEmail(e); return esc(p && p.name || e); }).join(', ');
    return (names || missing()) + (wsMsg ? '<div class="detail-hint">' + wsMsg + '</div>' : '');
  }
  function joinButton(){
    var mine = memberEmails().some(isMe), joined = ws && (ws.joined || []).some(isMe);
    var off = wsBusy || !wsLoaded ? ' disabled' : '';
    return !mine ? '<button class="btn-box is-primary detail-remove" type="button" data-ws="join"' + off + '>Join project</button>'
      : joined ? '<button class="btn-box detail-remove" type="button" data-ws="leave"' + off + '>Leave project</button>' : '';
  }

  function callWorkspace(args){
    try {
      return firebase.app().functions('europe-west2').httpsCallable('projectWorkspace')(Object.assign({ id: projectId, board: boardId || null }, args));
    } catch (e){ return Promise.reject(e); }
  }

  // Once, and only for someone not on it yet; the address loses &join=1, so a reload doesn't join again.
  function maybeJoin(){
    if (!joinRequested || !card || !wsLoaded) return;
    joinRequested = false;
    try { history.replaceState(null, '', location.pathname + location.search + location.hash.replace(/&join=1(?=&|$)/, '')); } catch (e){}
    if (memberEmails().some(isMe)) { wsMsg = 'You\u2019re already on this project.'; return; }
    workspaceAction('join');
  }

  // Join, Leave, Set up / Try again.
  // What each of them does outside BOLD.OS, for BOLD.confirmAction.
  var WS_CONFIRM = {
    join: function(){ return { title: 'Join \u201c' + card.title + '\u201d?', go: 'Join', effects: [
      card.slackChannel ? { key: 'slack', text: 'Invite you to ' + card.slackChannel + ' on Slack' } : '',
      ws && ws.meeting ? 'Add you to its meeting on Google Calendar (Google emails you the invitation)' : '',
      'Share its slides and notes on Google Drive with you'].filter(Boolean) }; },
    leave: function(){ return { title: 'Leave \u201c' + card.title + '\u201d?', go: 'Leave', effects: [
      ws && ws.meeting ? 'Take you off its meeting on Google Calendar' : '', 'Stop sharing its slides and notes with you'].filter(Boolean) }; },
    setUp: function(){ return { title: 'Set up the project?', go: 'Set up', effects: [
      ws && ws.meeting ? 'Make its meeting on Google Calendar, with a Meet link (Google emails its members the invitation)' : '',
      'Make its slides and notes on Google Drive, shared with its members',
      ws && ws.repo && !ws.repoName ? 'Make its GitHub repository' : ''].filter(Boolean) }; },
    pause: function(){ return { title: 'Pause the meeting?', go: 'Pause', effects: [
      'Take its upcoming dates off everyone\u2019s Google Calendar until it\u2019s resumed (the invitation and Meet link stay the same)'] }; },
    resume: function(){ return { title: 'Resume the meeting?', go: 'Resume', effects: ['Put its upcoming dates back on everyone\u2019s Google Calendar'] }; },
    announce: function(){ return { title: 'Announce \u201c' + card.title + '\u201d?', go: 'Announce', effects: ['Post it in #all-active-projects on Slack'] }; },
    slack: function(){ return { title: 'Join ' + card.slackChannel + '?', go: 'Join', effects: ['Invite you to ' + card.slackChannel + ' on Slack'] }; },
  };

  function workspaceAction(action){
    if (wsBusy) return;
    if (!WS_CONFIRM[action]) return runWorkspaceAction(action, {});
    BOLD.confirmAction(WS_CONFIRM[action]()).then(function(ok){ if (ok) runWorkspaceAction(action, ok.skip || {}); });
  }
  function runWorkspaceAction(action, skip){
    if (wsBusy) return;
    wsBusy = true; wsMsg = '';
    render();
    callWorkspace({ action: action, slack: action === 'join' && skip.slack ? false : undefined }).then(function(r){
      var d = r.data || {};
      wsBusy = false;
      if (action === 'slack') wsMsg = d.url ? 'You\u2019re in <a href="' + esc(d.url) + '" target="_blank" rel="noopener">' + esc(card.slackChannel) + '</a>.' : '';
      if (action === 'announce') wsMsg = 'Announced in #all-active-projects.';
      if (action === 'join' && d.slack) {
        wsMsg = d.slack.error ? esc(d.slack.error)
          : 'You\u2019re invited to the meeting' + (d.slack.url ? ' and in <a href="' + esc(d.slack.url) + '" target="_blank" rel="noopener">' + esc(card.slackChannel) + '</a>' : '') + '.';
      } else if (action === 'join') wsMsg = 'You\u2019re invited to the meeting.';
      if (!editing) render();
    }).catch(function(err){
      console.error('[BOLD Lab] projectWorkspace ' + action + ' failed', err);
      wsBusy = false;
      wsMsg = esc((err && err.message) || 'That didn\u2019t work \u2014 try again.');
      if (!editing) render();
    });
  }

  function saveMeeting(remove){
    var fail = failer(), meeting = null;
    if (!remove) {
      meeting = readMeetingEntry();
      if (meeting.error) return fail(meeting.error);
    }
    BOLD.confirmAction(remove ? { title: 'Remove the meeting?', go: 'Remove', effects: ['Cancel it on Google Calendar: Google tells its guests'] }
      : { title: ws && ws.meeting ? 'Change the meeting?' : 'Add a meeting?', go: 'Save', effects: [ws && ws.meeting
        ? 'Change it on Google Calendar to ' + meetingText(meeting) + ': Google emails its guests the change'
        : 'Make it on Google Calendar, ' + meetingText(meeting) + ', ' + meetVia(meeting) + ': Google emails the project\u2019s members the invitation'] }).then(function(ok){
      if (ok) sendMeeting(meeting, fail);
    });
  }
  function sendMeeting(meeting, fail){
    el('meetingSave').disabled = true;
    callWorkspace({ action: 'meeting', meeting: meeting }).then(function(){
      editing = false; render();
    }).catch(function(err){
      console.error('[BOLD Lab] saving the meeting failed', err);
      el('meetingSave').disabled = false;
      fail((err && err.message) || 'Could not save \u2014 try again.');
    });
  }

  // Members and PIs/admins add, change and remove presentations (firestore.rules).
  var NOT_MEMBER = 'Join the project to add presentations';
  function canTalk(){ return fullWrite || memberEmails().some(isMe); }

  // The occasion, linked to its event's page or its venue's board.
  function occasionHtml(t){
    var o = t.occasion;
    if (!o) return esc(OLD_KINDS[t.kind] || '');
    if (o.kind === 'event') {
      // The exact talk or session on the event's programme, when it was one.
      var href = o.talkSlug ? 'talk.html?talk=' + encodeURIComponent(o.talkSlug)
        : o.sessionSlug ? 'session.html?session=' + encodeURIComponent(o.sessionSlug)
        : 'event.html?event=' + encodeURIComponent(o.id);
      return '<a href="' + href + '">' + esc(o.label) + (o.sessionTitle ? ' \u00b7 ' + esc(o.sessionTitle) : '') + '</a>';
    }
    if (o.kind === 'venue') return '<a href="audit-board.html#board=' + encodeURIComponent(o.id) + '">' + esc(o.label) + '</a>';
    return esc(o.label);
  }

  // The released events, newest first (as the sidebar lists them), and the venues.
  function loadOccasions(){
    loadVenues();
    if (events) return;
    db.collection('events').where('hidden', '==', false).get().then(function(snap){
      events = snap.docs.map(function(d){ return d.data(); }).filter(function(e){ return e.slug && e.title; })
        .sort(function(a, b){ return a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : 0; });
      if (editing && editing.indexOf('talk:') === 0) { renderTalkOccasion(); fillSessions(); }
    }).catch(function(err){ console.error('[BOLD Lab] loading the events failed', err); events = []; });
  }

  // The occasion menu: events, then venues, then Other (with its name field).
  function occasionOptionsHtml(cur){
    var opt = function(value, label){ return '<option value="' + esc(value) + '"' + (value === cur ? ' selected' : '') + '>' + esc(label) + '</option>'; };
    return (events && events.length ? '<optgroup label="Events">' + events.map(function(e){ return opt('event:' + e.slug, e.title); }).join('') + '</optgroup>' : '') +
      (venues && venues.length ? '<optgroup label="Venues">' + venues.map(function(v){ return opt('venue:' + v.id, v.label); }).join('') + '</optgroup>' : '') +
      opt('other', 'Other');
  }
  function occasionValue(t){
    var o = t && t.occasion;
    return o && o.kind !== 'other' ? o.kind + ':' + o.id : 'other';
  }
  function renderTalkOccasion(){
    var sel = el('talkOccasion');
    if (!sel) return;
    // The choice so far: the saved one, or what was picked (kept while the lists load).
    var cur = sel.getAttribute('data-value');
    sel.innerHTML = occasionOptionsHtml(cur);
    el('talkOther').hidden = sel.value !== 'other';
  }
  // → { kind, id, label } or { error }.
  function readOccasion(){
    var v = el('talkOccasion').value;
    if (v === 'other') {
      var name = el('talkOther').value.trim();
      return name ? { kind: 'other', id: '', label: name.slice(0, 200) } : { error: 'Name the venue.' };
    }
    var kind = v.split(':')[0], id = v.slice(kind.length + 1);
    var list = kind === 'event' ? (events || []).map(function(e){ return { id: e.slug, label: e.title }; }) : (venues || []);
    var hit = list.filter(function(x){ return x.id === id; })[0];
    if (!hit) return { error: 'Choose the venue.' };
    var o = { kind: kind, id: id, label: hit.label };
    var s = kind === 'event' && pickedSession(), t = s && pickedTalk();
    if (s) { o.sessionSlug = s.slug; o.sessionTitle = s.title.slice(0, 200); }
    if (t) { o.talkSlug = t.slug; o.talkTitle = t.title.slice(0, 200); }
    return o;
  }

  // An event's sessions, in programme order (its days and slots), and a session's
  // talks: the event's own (collabWeekSessions, collabWeekTalks), loaded as needed.
  var sessionsBy = {}, talksBy = {};
  function loadSessions(eventSlug){
    if (sessionsBy[eventSlug]) return Promise.resolve(sessionsBy[eventSlug]);
    var ev = (events || []).filter(function(e){ return e.slug === eventSlug; })[0] || {};
    return db.collection('collabWeekSessions').where('eventSlug', '==', eventSlug).get().then(function(snap){
      var bySlug = {};
      snap.docs.forEach(function(d){ var x = d.data(); if (!x.removed) bySlug[d.id] = x; });
      var list = [];
      (ev.days || []).forEach(function(day){
        (day.slots || []).forEach(function(slot){
          (slot.sessions || []).forEach(function(slug){
            if (bySlug[slug]) { list.push({ slug: slug, title: bySlug[slug].title || slug, date: day.date || '', start: slot.start || '', type: bySlug[slug].type || '' }); delete bySlug[slug]; }
          });
        });
      });
      // Any not on the schedule (yet) come last.
      Object.keys(bySlug).forEach(function(slug){ list.push({ slug: slug, title: bySlug[slug].title || slug, date: '', start: '', type: bySlug[slug].type || '' }); });
      return (sessionsBy[eventSlug] = list);
    });
  }
  function loadTalks(sessionSlug){
    if (talksBy[sessionSlug]) return Promise.resolve(talksBy[sessionSlug]);
    return db.collection('collabWeekTalks').where('sessionSlug', '==', sessionSlug).get().then(function(snap){
      return (talksBy[sessionSlug] = snap.docs.map(function(d){ return Object.assign({ slug: d.id }, d.data()); })
        .filter(function(t){ return !t.removed; })
        .map(function(t){
          var names = (t.speakers || []).map(function(p){ return p.name || p.email; }).filter(Boolean).join(', ') || t.speaker || '';
          return { slug: t.slug, title: t.title || 'Untitled talk', type: t.type || '', speakers: names, slidesUrl: t.presentationUrl || '' };
        }));
    });
  }
  function pickedSession(){
    var v = el('talkSession') && el('talkSession').value, ev = el('talkOccasion').value.slice(6);
    return v ? (sessionsBy[ev] || []).filter(function(s){ return s.slug === v; })[0] || null : null;
  }
  function pickedTalk(){
    var s = pickedSession(), v = el('talkTalk') && el('talkTalk').value;
    return s && v ? (talksBy[s.slug] || []).filter(function(t){ return t.slug === v; })[0] || null : null;
  }

  // Shows a form row (its dt and dd) or hides it.
  function showRow(ddId, on){ var dd = el(ddId); if (dd) { dd.hidden = !on; dd.previousElementSibling.hidden = !on; } }

  // The Session menu for the chosen event, and the Talk menu for the chosen session.
  var dayFmt = function(iso){ return iso ? new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : ''; };
  function fillSessions(){
    var occ = el('talkOccasion').value, sel = el('talkSession');
    if (occ.indexOf('event:') !== 0) { showRow('talkSessionRow', false); showRow('talkTalkRow', false); return; }
    showRow('talkSessionRow', true);
    if (!events) return;   // called again once they're in: the order comes from their schedule
    var ev = occ.slice(6);
    loadSessions(ev).then(function(list){
      if (el('talkOccasion').value !== occ) return;
      var cur = sel.getAttribute('data-value') || '';
      sel.innerHTML = '<option value="">Not a session on its programme</option>' + list.map(function(s){
        return '<option value="' + esc(s.slug) + '"' + (s.slug === cur ? ' selected' : '') + '>' + esc([dayFmt(s.date), s.start, s.title].filter(Boolean).join(' \u00b7 ')) + '</option>';
      }).join('');
      fillTalks();
    }).catch(function(err){ console.error('[BOLD Lab] loading the sessions failed', err); });
  }
  function fillTalks(){
    var s = pickedSession(), sel = el('talkTalk');
    if (!s) { showRow('talkTalkRow', false); return; }
    loadTalks(s.slug).then(function(list){
      if (pickedSession() !== s) return;
      // A keynote's or an oral's one talk is the session itself.
      if (!list.length) { showRow('talkTalkRow', false); return; }
      showRow('talkTalkRow', true);
      var cur = sel.getAttribute('data-value') || '';
      sel.innerHTML = '<option value="">The whole session</option>' + list.map(function(t){
        return '<option value="' + esc(t.slug) + '"' + (t.slug === cur ? ' selected' : '') + '>' + esc(t.title + (t.speakers ? ' \u2014 ' + t.speakers : '')) + '</option>';
      }).join('');
      if (cur) fillFromTalk();
    }).catch(function(err){ console.error('[BOLD Lab] loading the talks failed', err); });
  }

  // Choosing a talk fills in what the programme knows, except what was typed here.
  var typed = {};
  // A presentation of a talk on an event's programme is that talk: its title, type,
  // speakers and slides are the talk's, shown here and edited on its page.
  var TALK_OWN = ['talkTitle', 'talkType', 'talkPresenter', 'talkSlides'];
  function fillFromTalk(){
    var s = pickedSession(), t = pickedTalk();
    var set = function(id, v){ if (v && !typed[id]) el(id).value = v; };
    if (s) set('talkDate', s.date);
    if (t) {
      el('talkTitle').value = t.title; el('talkType').value = t.type || ''; el('talkPresenter').value = t.speakers; el('talkSlides').value = t.slidesUrl;
    }
    TALK_OWN.forEach(function(id){ el(id).disabled = !!t; });
    var up = document.querySelector('.talk-form .pu-btn');
    if (up) up.disabled = !!t;
    var note = el('talkFromTalk');
    if (note) {
      note.hidden = !t;
      if (t) note.innerHTML = 'Title, type, speakers and slides are the talk\u2019s: <a href="talk.html?talk=' + encodeURIComponent(t.slug) + '">edit them on its page</a>.';
    }
  }

  function talkFormHtml(t){
    t = t || { title: '', date: new Date().toISOString().slice(0, 10), presenter: me && me.displayName || '', occasion: null, slidesUrl: '', recordingUrl: '' };
    var input = function(id, type, v, ph){ return '<input type="' + type + '" id="' + id + '" value="' + esc(v || '') + '"' + (ph ? ' placeholder="' + ph + '"' : '') + '>'; };
    var o = t.occasion || {};
    // Where it was given first: choosing a talk there fills in the rest.
    return '<dl class="detail-grid talk-form">' +
      row('Venue', '<select id="talkOccasion" data-value="' + esc(occasionValue(t)) + '">' + occasionOptionsHtml(occasionValue(t)) + '</select>' +
        '<input type="text" id="talkOther" placeholder="e.g. a workshop or an invited talk" value="' + esc(t.occasion && t.occasion.kind === 'other' ? t.occasion.label : '') + '"' + (occasionValue(t) === 'other' ? '' : ' hidden') + '>') +
      row('Session', '<select id="talkSession" data-value="' + esc(o.sessionSlug || '') + '"><option value="">Loading\u2026</option></select>', ' id="talkSessionRow" hidden') +
      row('Talk', '<select id="talkTalk" data-value="' + esc(o.talkSlug || '') + '"></select><p class="detail-hint" id="talkFromTalk" hidden></p>', ' id="talkTalkRow" hidden') +
      row('Title', input('talkTitle', 'text', t.title)) +
      row('Type', '<select id="talkType"><option value="">\u2014</option>' + PRES_TYPES.map(function(x){
        return '<option value="' + x[0] + '"' + (x[0] === t.type ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select>') +
      row('Presenter', input('talkPresenter', 'text', t.presenter)) +
      row('Date', input('talkDate', 'date', t.date)) +
      row('Slides', input('talkSlides', 'url', t.slidesUrl, 'https://\u2026') +
        BoldPresentationUpload.html('detail-hint')) +
      row('Recording', input('talkRecording', 'url', t.recordingUrl, 'https://\u2026 (optional)')) +
      '</dl>' + saveCancelHtml('talkSave');
  }

  // The talks the presentations are of, as they are now on their event's programme.
  var liveTalks = {};
  function loadLiveTalks(){
    talks.forEach(function(t){
      var slug = t.occasion && t.occasion.talkSlug;
      if (!slug || liveTalks[slug]) return;
      liveTalks[slug] = { loading: true };
      db.collection('collabWeekTalks').doc(slug).get().then(function(snap){
        var x = snap.exists ? snap.data() : null;
        liveTalks[slug] = x ? { title: x.title || '', type: x.type || '', slidesUrl: x.presentationUrl || '',
          presenter: (x.speakers || []).map(function(p){ return p.name || p.email; }).filter(Boolean).join(', ') || x.speaker || '' } : { gone: true };
        if (card && !editing) render();
      }).catch(function(err){ console.error('[BOLD Lab] loading a presented talk failed', err); });
    });
  }
  // A presentation as shown: a talk's own details from the talk itself.
  function shown(t){
    var live = t.occasion && t.occasion.talkSlug && liveTalks[t.occasion.talkSlug];
    if (!live || live.loading || live.gone) return t;
    return Object.assign({}, t, { title: live.title || t.title, type: live.type, presenter: live.presenter, slidesUrl: live.slidesUrl || t.slidesUrl });
  }
  function typeLabel(k){ var x = PRES_TYPES.filter(function(p){ return p[0] === k; })[0]; return x ? x[1] : ''; }

  function presentationsHtml(){
    var off = canTalk() ? '' : ' disabled title="' + NOT_MEMBER + '"';
    var html = '<div class="detail-abstract-label">Presentations' +
      (editing === 'talk:new' ? '' : ' <button class="btn-text detail-inline-edit" type="button" data-talk="new"' + off + '>+ Add presentation</button>') + '</div>';
    if (editing === 'talk:new') html += talkFormHtml();
    if (!talks.length && editing !== 'talk:new') return html + missing();
    html += '<ul class="talk-list">' + talks.map(function(t){
      if (editing === 'talk:' + t.id) return '<li>' + talkFormHtml(t) + '</li>';
      t = shown(t);
      var title = t.slidesUrl ? '<a href="' + esc(t.slidesUrl) + '" target="_blank" rel="noopener">' + esc(t.title) + '</a>' : esc(t.title);
      var when = new Date(t.date + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
      var occasion = occasionHtml(t);
      return '<li id="pres-' + esc(t.id) + '"' + (t.id === presWanted ? ' class="is-target"' : '') + '><div class="talk-when">' + esc(when) + (occasion ? ' \u00b7 ' + occasion : '') + (typeLabel(t.type) ? ' \u00b7 ' + typeLabel(t.type) : '') + '</div>' +
        '<div class="talk-title">' + title + (t.presenter ? ' <span class="detail-muted">\u2014 ' + esc(t.presenter) + '</span>' : '') + '</div>' +
        '<div class="talk-actions">' +
          (t.recordingUrl ? '<a href="' + esc(t.recordingUrl) + '" target="_blank" rel="noopener">Recording</a>' : '') +
          '<button class="btn-text" type="button" data-talk="' + esc(t.id) + '"' + off + '>Edit</button>' +
          '<button class="btn-text danger" type="button" data-talk-remove="' + esc(t.id) + '"' + (canTalk() || (t.by && isMe(t.by.email)) ? '' : off) + '>Remove</button>' +
        '</div></li>';
    }).join('') + '</ul>';
    return html;
  }

  function talksRef(){ return db.collection('projectWorkspaces').doc(wsKey).collection('presentations'); }

  function saveTalk(){
    var fail = failer(), id = editing.slice(5), v = function(x){ return el(x).value.trim(); };
    var occasion = readOccasion();
    if (occasion.error) return fail(occasion.error);
    var t = { title: v('talkTitle'), type: v('talkType'), date: v('talkDate'), presenter: v('talkPresenter'), occasion: occasion, slidesUrl: v('talkSlides'), recordingUrl: v('talkRecording') };
    if (!t.title) return fail('Give it a title.');
    if (!/^\d{4}-\d\d-\d\d$/.test(t.date)) return fail('Choose a date.');
    if ([t.slidesUrl, t.recordingUrl].some(function(u){ return u && !/^https?:\/\//i.test(u); })) return fail('Enter full links, starting with https://');
    var old = talks.filter(function(x){ return x.id === id; })[0];
    t.by = old ? old.by : { email: me.email, name: me.displayName || '' };
    t.at = Date.now();
    var btn = el('talkSave');
    btn.disabled = true;
    // An older project has no workspace yet: set it up first (its members are what the rules check).
    (ws ? Promise.resolve() : callWorkspace({ action: 'setUp' })).then(function(){
      return old ? talksRef().doc(id).set(t) : talksRef().add(t);
    }).then(function(){ editing = false; render(); }).catch(function(err){
      console.error('[BOLD Lab] saving the presentation failed', err);
      btn.disabled = false;
      fail(err && err.code === 'permission-denied' ? NOT_MEMBER + '.' : 'Could not save \u2014 try again.');
    });
  }

  function removeTalk(id){
    var t = talks.filter(function(x){ return x.id === id; })[0];
    if (!t || !window.confirm('Remove "' + t.title + '"?')) return;
    talksRef().doc(id).delete().catch(function(err){
      console.error('[BOLD Lab] removing the presentation failed', err);
      window.alert('Could not remove it \u2014 try again.');
    });
  }

  function watchWorkspace(){
    var key = card && (card.projectId || projectId);
    if (!db || !key || !me || key === wsKey) return;
    if (wsUnsub) { wsUnsub(); talksUnsub(); }
    wsKey = key;
    wsUnsub = db.collection('projectWorkspaces').doc(key).onSnapshot(function(snap){
      ws = snap.exists ? snap.data() : null;
      wsLoaded = true;
      // An earlier venue's card: the project page is its latest one's.
      if (ws && ws.cardId && (ws.cardId !== projectId || (ws.boardId || null) !== (boardId || null))) {
        location.replace('project.html#id=' + encodeURIComponent(ws.cardId) + (ws.boardId ? '&board=' + encodeURIComponent(ws.boardId) : '') +
          (tab !== 'overview' ? '&tab=' + tab : '') + (joinRequested ? '&join=1' : '') + (presWanted ? '&pres=' + presWanted : ''));
        location.reload();
        return;
      }
      maybeJoin();
      // Members show by name.
      loadPeople().then(function(){ if (card && !editing) render(); });
      if (card && !editing) render();
    }, function(err){ console.error('[BOLD Lab] loading the meeting failed', err); });
    talksUnsub = talksRef().onSnapshot(function(snap){
      talks = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); })
        .sort(function(a, b){ return (b.date || '').localeCompare(a.date || '') || (b.at || 0) - (a.at || 0); });
      loadLiveTalks();
      if (card && !editing) render();
      var target = presWanted && document.getElementById('pres-' + presWanted);
      if (target && !presScrolled) { presScrolled = true; target.scrollIntoView({ block: 'center' }); }
    }, function(err){ console.error('[BOLD Lab] loading the presentations failed', err); });
  }

  function wireAbstract(){
    Array.prototype.forEach.call(document.querySelectorAll('[data-talk]'), function(btn){
      btn.addEventListener('click', function(){ editing = 'talk:' + btn.getAttribute('data-talk'); render(); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-talk-remove]'), function(btn){
      btn.addEventListener('click', function(){ removeTalk(btn.getAttribute('data-talk-remove')); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-ws]'), function(btn){
      btn.addEventListener('click', function(){ workspaceAction(btn.getAttribute('data-ws')); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-edit]'), function(btn){
      btn.addEventListener('click', function(){
        if (!canEdit()) return;
        var what = btn.getAttribute('data-edit');
        if (what === 'authors' && authorsLocked()) return;
        if (what === 'submit') loadVenues();
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
    } else if (editing === 'submit') {
      if (el('submitSave')) el('submitSave').addEventListener('click', submitToVenue);
    } else if (editing.indexOf('talk:') === 0) {
      el('talkSave').addEventListener('click', saveTalk);
      BoldPresentationUpload.wire(document.querySelector('.talk-form .pu-line'), { input: el('talkSlides'),
        args: function(){ return { project: wsKey }; }, busy: function(on){ el('talkSave').disabled = on; } });
      loadOccasions();
      // Choosing an event sets the date to its first day; a session or a talk on its
      // programme fills in more (fillFromTalk). Only fields not typed in here.
      typed = {};
      if (editing !== 'talk:new') ['talkTitle', 'talkDate', 'talkPresenter', 'talkSlides'].forEach(function(id){ typed[id] = true; });
      ['talkTitle', 'talkDate', 'talkPresenter', 'talkSlides'].forEach(function(id){
        el(id).addEventListener('input', function(){ typed[id] = true; });
      });
      el('talkOccasion').addEventListener('change', function(){
        this.setAttribute('data-value', this.value);
        el('talkSession').setAttribute('data-value', ''); el('talkTalk').setAttribute('data-value', '');
        el('talkOther').hidden = this.value !== 'other';
        var e = this.value.indexOf('event:') === 0 && (events || []).filter(function(x){ return 'event:' + x.slug === this.value; }, this)[0];
        if (e && e.startDate && !typed.talkDate) el('talkDate').value = e.startDate;
        fillSessions();
      });
      el('talkSession').addEventListener('change', function(){
        this.setAttribute('data-value', this.value); el('talkTalk').setAttribute('data-value', '');
        fillFromTalk(); fillTalks();
      });
      el('talkTalk').addEventListener('change', function(){ this.setAttribute('data-value', this.value); fillFromTalk(); });
      fillSessions();
    } else if (editing === 'repo') {
      wireRepoEntry();
      el('repoSave').addEventListener('click', saveRepo);
    } else if (editing === 'meeting') {
      el('meetingSave').addEventListener('click', function(){ saveMeeting(false); });
      if (el('meetingRemove')) el('meetingRemove').addEventListener('click', function(){ saveMeeting(true); });
    } else if (editing === 'slack') {
      channelField = wireChannelField('save', card.slackChannel || '', { id: projectId, board: boardId || null });
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

  function completeProject(){
    var reopen = !!(ws && ws.completedAt), meeting = ws && ws.meeting;
    if (reopen && !meeting) return sendComplete(true);
    BOLD.confirmAction(reopen
      ? { title: 'Reopen \u201c' + card.title + '\u201d?', go: 'Reopen', effects: meeting ? ['Put its meeting back on Google Calendar: Google emails its guests'] : [] }
      : { title: 'Mark \u201c' + card.title + '\u201d as completed?', go: 'Mark completed', effects: meeting ? ['Cancel its meeting on Google Calendar: Google tells everyone on it'] : [] })
      .then(function(ok){ if (ok) sendComplete(reopen); });
  }
  function sendComplete(reopen){
    wsBusy = true; render();
    callWorkspace({ action: reopen ? 'reopen' : 'complete' }).then(function(){
      wsBusy = false;
      // The Projects page's cached list still has it in its old tab.
      try { localStorage.removeItem(CACHE_KEY + me.email.toLowerCase()); } catch (e){}
      if (!editing) render();
    }).catch(function(err){
      console.error('[BOLD Lab] ' + (reopen ? 'reopening' : 'completing') + ' the project failed', err);
      wsBusy = false; render();
      window.alert((err && err.message) || 'That didn\u2019t work \u2014 try again.');
    });
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
    var effects = channelField.effects(n.name);
    (effects.length ? BOLD.confirmAction({ title: 'Change the Slack channel?', go: 'Save', effects: effects }) : Promise.resolve(true)).then(function(ok){
      if (ok) sendSlack(n, btn, fail);
    });
  }
  function sendSlack(n, btn, fail){
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
      watchWorkspace();
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
    if (!user) {
      if (wsUnsub) { wsUnsub(); talksUnsub(); wsUnsub = talksUnsub = null; wsKey = ''; }
      return cacheClear();
    }
    // The Edit buttons depend on who's signed in; already right if the first paint used the same person.
    if (card && !editing && was !== (user.email || '').toLowerCase()) render();
    load();
    loadAccess();
    watchWorkspace();
  });
})();
