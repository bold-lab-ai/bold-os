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
  // Its meeting, slides, notes and members: projectWorkspaces/{id}, kept by the
  // server (projectWorkspace in functions/index.js), followed live.
  var ws = null, wsLoaded = false, wsUnsub = null, wsBusy = false, wsMsg = '';
  // Its presentations, projectWorkspaces/{id}/presentations, newest first.
  var talks = [], talksUnsub = null;
  var TALK_KINDS = [['group', 'Group meeting'], ['pitch', 'Pitch Day'], ['conference', 'Conference'], ['invited', 'Invited talk'], ['other', 'Other']];
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
  var TABS = [['overview', 'Overview'], ['team', 'Team'], ['presentations', 'Presentations'], ['paper', 'Paper']];
  var tab = (location.hash.match(/[#&]tab=([^&]+)/) || [])[1];
  if (!TABS.some(function(t){ return t[0] === tab; })) tab = 'overview';

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
    // Who's on it and how they meet.
    team: function(){
      return '<dl class="detail-grid">' + row('People', membersHtml()) +
        editableRow('slack', 'Slack channel', card.slackChannel ? esc(card.slackChannel) : missing(),
          card.slackChannel ? ' id="slackChannel"' : '', channelEntryHtml(card.slackChannel), 'slackSave') +
        workspaceRows() + '</dl>';
    },
    // Talks about the project; the pitch deck is the card's own (the board uses it).
    presentations: function(){
      return '<dl class="detail-grid">' + simpleRow('pitch') + '</dl>' + presentationsHtml();
    },
    // The write-up and its submission.
    paper: function(){
      return '<dl class="detail-grid">' + row('Venue', !boardId ? '<span class="detail-muted">No venue yet</span>'
          : '<a href="audit-board.html#board=' + encodeURIComponent(boardId) + '">' + esc(venueLabel || boardId) + '</a>') +
        repoRow() + simpleRow('overleaf') + simpleRow('arxiv') + simpleRow('compute') +
        row('Internal review', boardId
          ? '<a href="audit-board.html#board=' + encodeURIComponent(boardId) + '&card=' + encodeURIComponent(projectId) + '">Its card on ' + esc(venueLabel || 'the board') + '</a>'
          : '<span class="detail-muted">Once the project has a venue</span>') + '</dl>';
    }
  };

  function render(){
    var html = '<div class="detail-head"><h2>' + esc(card.title) + '</h2>';
    html += '<div class="detail-badges">';
    if (STAGE_LABELS[card.status]) html += '<span class="badge badge-stage">' + STAGE_LABELS[card.status] + '</span>';
    if (OUTCOME_LABELS[card.outcome] && !(card.outcome === 'accepted' && card.status === 'conference')) {
      html += '<span class="badge">' + OUTCOME_LABELS[card.outcome] + '</span>';
    }
    html += '<button class="btn-text danger detail-remove" type="button" id="removeProject"' + (canRemove() ? '' : ' disabled title="' + NOT_SUBMITTER + '"') + '>Remove project</button>';
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
    var meeting = m && !ws.eventId ? esc(meetingText(m)) + ' <span class="detail-muted">\u00b7 not set up yet</span>'
      : m ? esc(meetingText(m)) +
        (ws.meetUrl ? ' \u00b7 <a href="' + esc(ws.meetUrl) + '" target="_blank" rel="noopener">Google Meet</a>' : '') +
        (ws.eventLink ? ' \u00b7 <a href="' + esc(ws.eventLink) + '" target="_blank" rel="noopener">Calendar</a>' : '')
      : wsLoaded && !setting ? missing() : state;
    var html = editableRow('meeting', 'Meeting', meeting, '',
      meetingEntryHtml(m) + (m ? '<button class="btn-text danger" type="button" id="meetingRemove">Remove the meeting</button>' : ''), 'meetingSave');
    html += row('Slides', ws && ws.deckUrl ? openLink(ws.deckUrl) : state + retry);
    html += row('Meeting notes', ws && ws.notesUrl ? openLink(ws.notesUrl) : failed ? missing() : state);
    return html;
  }

  // Its GitHub repository: a link once there is one; until then editors choose its
  // template, as on the register form.
  function repoRow(){
    var linked = ws && ws.repoUrl;
    var value = linked ? '<a href="' + esc(ws.repoUrl) + '" target="_blank" rel="noopener">' + esc(ws.repoUrl.replace(/^https:\/\/github\.com\//, '')) + '</a>'
      : !wsLoaded ? '<span class="detail-muted">Loading\u2026</span>'
      : ws && ws.repoError ? '<span class="detail-muted">' + esc(ws.repoError) + '</span>'
      : ws && ws.repo && ws.syncing ? '<span class="detail-muted">Setting up\u2026</span>'
      : missing();
    var retry = ws && ws.repoError && ws.repo && !linked
      ? ' <button class="btn-text detail-inline-edit" type="button" data-ws="setUp"' + (canEdit() && !wsBusy ? '' : ' disabled title="' + NOT_EDITOR + '"') + '>Try again</button>' : '';
    // Once made, it stays.
    if (ws && ws.repoName) return row('Repository', value);
    return editableRow('repo', 'Repository', value + retry, '', repoEntryHtml(), 'repoSave');
  }

  function saveRepo(){
    var fail = failer(), repo = readRepoEntry();
    if (repo.error) return fail(repo.error);
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

  // Whoever registered it, its authors and whoever joined; Join or Leave for the viewer.
  function memberEmails(){
    if (ws && ws.members) return ws.members;
    return [card.submittedBy && card.submittedBy.email].concat(card.authorEmails || []).filter(function(e, i, all){ return e && all.indexOf(e) === i; });
  }
  function membersHtml(){
    var list = memberEmails();
    var names = list.map(function(e){ var p = personByEmail(e); return esc(p && p.name || e); }).join(', ');
    var mine = list.some(isMe);
    var joined = ws && (ws.joined || []).some(isMe);
    var btn = !mine ? '<button class="btn-text detail-inline-edit" type="button" data-ws="join"' + (wsBusy ? ' disabled' : '') + '>Join the project</button>'
      : joined ? '<button class="btn-text detail-inline-edit" type="button" data-ws="leave"' + (wsBusy ? ' disabled' : '') + '>Leave</button>'
      : '';
    return (names || missing()) + btn + (wsMsg ? '<div class="detail-hint">' + wsMsg + '</div>' : '');
  }

  function callWorkspace(args){
    try {
      return firebase.app().functions('europe-west2').httpsCallable('projectWorkspace')(Object.assign({ id: projectId, board: boardId || null }, args));
    } catch (e){ return Promise.reject(e); }
  }

  // Join, Leave, Set up / Try again.
  function workspaceAction(action){
    if (wsBusy) return;
    wsBusy = true; wsMsg = '';
    render();
    callWorkspace({ action: action }).then(function(r){
      var d = r.data || {};
      wsBusy = false;
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

  function talkKind(k){ var t = TALK_KINDS.filter(function(x){ return x[0] === k; })[0]; return t ? t[1] : ''; }

  function talkFormHtml(t){
    t = t || { title: '', date: new Date().toISOString().slice(0, 10), presenter: me && me.displayName || '', kind: 'group', slidesUrl: '', recordingUrl: '' };
    var input = function(id, type, v, ph){ return '<input type="' + type + '" id="' + id + '" value="' + esc(v || '') + '"' + (ph ? ' placeholder="' + ph + '"' : '') + '>'; };
    return '<dl class="detail-grid talk-form">' +
      row('Title', input('talkTitle', 'text', t.title)) +
      row('Date', input('talkDate', 'date', t.date)) +
      row('Presenter', input('talkPresenter', 'text', t.presenter)) +
      row('Type', '<select id="talkKind">' + TALK_KINDS.map(function(k){ return '<option value="' + k[0] + '"' + (k[0] === t.kind ? ' selected' : '') + '>' + k[1] + '</option>'; }).join('') + '</select>') +
      row('Slides', input('talkSlides', 'url', t.slidesUrl, 'https://\u2026')) +
      row('Recording', input('talkRecording', 'url', t.recordingUrl, 'https://\u2026 (optional)')) +
      '</dl>' + saveCancelHtml('talkSave');
  }

  function presentationsHtml(){
    var off = canTalk() ? '' : ' disabled title="' + NOT_MEMBER + '"';
    var html = '<div class="detail-abstract-label">Presentations' +
      (editing === 'talk:new' ? '' : ' <button class="btn-text detail-inline-edit" type="button" data-talk="new"' + off + '>+ Add presentation</button>') + '</div>';
    if (editing === 'talk:new') html += talkFormHtml();
    if (!talks.length && editing !== 'talk:new') return html + missing();
    html += '<ul class="talk-list">' + talks.map(function(t){
      if (editing === 'talk:' + t.id) return '<li>' + talkFormHtml(t) + '</li>';
      var title = t.slidesUrl ? '<a href="' + esc(t.slidesUrl) + '" target="_blank" rel="noopener">' + esc(t.title) + '</a>' : esc(t.title);
      var when = new Date(t.date + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
      return '<li><div class="talk-when">' + esc(when) + ' \u00b7 ' + esc(talkKind(t.kind)) + '</div>' +
        '<div class="talk-title">' + title + (t.presenter ? ' <span class="detail-muted">\u2014 ' + esc(t.presenter) + '</span>' : '') + '</div>' +
        '<div class="talk-actions">' +
          (t.recordingUrl ? '<a href="' + esc(t.recordingUrl) + '" target="_blank" rel="noopener">Recording</a>' : '') +
          '<button class="btn-text" type="button" data-talk="' + esc(t.id) + '"' + off + '>Edit</button>' +
          '<button class="btn-text danger" type="button" data-talk-remove="' + esc(t.id) + '"' + (canTalk() || (t.by && isMe(t.by.email)) ? '' : off) + '>Remove</button>' +
        '</div></li>';
    }).join('') + '</ul>';
    return html;
  }

  function talksRef(){ return db.collection('projectWorkspaces').doc(projectId).collection('presentations'); }

  function saveTalk(){
    var fail = failer(), id = editing.slice(5), v = function(x){ return el(x).value.trim(); };
    var t = { title: v('talkTitle'), date: v('talkDate'), presenter: v('talkPresenter'), kind: v('talkKind'), slidesUrl: v('talkSlides'), recordingUrl: v('talkRecording') };
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
    if (wsUnsub || !db || !projectId) return;
    wsUnsub = db.collection('projectWorkspaces').doc(projectId).onSnapshot(function(snap){
      ws = snap.exists ? snap.data() : null;
      wsLoaded = true;
      // Members show by name.
      loadPeople().then(function(){ if (card && !editing) render(); });
      if (card && !editing) render();
    }, function(err){ console.error('[BOLD Lab] loading the meeting failed', err); });
    talksUnsub = talksRef().onSnapshot(function(snap){
      talks = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); })
        .sort(function(a, b){ return (b.date || '').localeCompare(a.date || '') || (b.at || 0) - (a.at || 0); });
      if (card && !editing) render();
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
    } else if (editing.indexOf('talk:') === 0) {
      el('talkSave').addEventListener('click', saveTalk);
    } else if (editing === 'repo') {
      wireRepoEntry();
      el('repoSave').addEventListener('click', saveRepo);
    } else if (editing === 'meeting') {
      el('meetingSave').addEventListener('click', function(){ saveMeeting(false); });
      if (el('meetingRemove')) el('meetingRemove').addEventListener('click', function(){
        if (window.confirm('Remove the meeting? Its guests are told it\u2019s cancelled.')) saveMeeting(true);
      });
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
    if (!user) {
      if (wsUnsub) { wsUnsub(); talksUnsub(); wsUnsub = talksUnsub = null; }
      return cacheClear();
    }
    // The Edit buttons depend on who's signed in; already right if the first paint used the same person.
    if (card && !editing && was !== (user.email || '').toLowerCase()) render();
    load();
    loadAccess();
    watchWorkspace();
  });
})();
