(function(){
  'use strict';
  if (!BOLD.getAuth()) return;
  var db = firebase.firestore(BOLD.getApp());
  var call = function(name, data){ return firebase.app().functions('europe-west2').httpsCallable('groupRota' + name)(data || {}); };
  var esc = BOLD.escapeHtml, msg = document.getElementById('rotaMessage'), body = document.getElementById('rotaBody');
  var user = null, access = null, meetings = [], slots = [], members = [], people = [], seasons = [], projects = [], busy = false;
  var manageOpen = false, changelogOpen = false, changes = [], changesLoaded = false, changesLoading = false, changesFailed = false, changesLast = null, changesMore = false;
  var params = new URLSearchParams(location.search), edition = params.get('edition') || '', selectedDate = params.get('date') || (/\d{4}-\d{2}-\d{2}$/.test(edition) ? edition.slice(-10) : ''), selectedSlot = params.get('slot') || '', archive = params.get('archive') === '1';
  var search = '', panel = null, visibleCount = 10, pendingJump = !!selectedDate, trackerOpen = false, trackerYear = new Date().getFullYear();
  var resourceHint = document.createElement('div');
  resourceHint.className = 'rota-resource-hint';
  resourceHint.setAttribute('role', 'tooltip');
  resourceHint.hidden = true;
  document.body.appendChild(resourceHint);
  function hideResourceHint(){ resourceHint.hidden = true; }
  function showResourceHint(target){
    resourceHint.textContent = target.dataset.rotaHint;
    resourceHint.hidden = false;
    var rect = target.getBoundingClientRect(), gap = 5, edge = 8;
    resourceHint.style.left = Math.max(edge, Math.min(rect.left, window.innerWidth - resourceHint.offsetWidth - edge)) + 'px';
    resourceHint.style.top = rect.bottom + gap + 'px';
  }
  function updateArchiveHeader(){
    var archiveLink = document.getElementById('rotaArchiveLink');
    archiveLink.href = archive ? 'group-meetings.html' : 'group-meetings.html?archive=1';
    archiveLink.textContent = archive ? 'Upcoming meetings →' : 'Archive →';
    document.querySelector('.rota-hero h1').textContent = archive ? 'Past group meetings' : 'Group meetings';
    document.querySelector('.rota-hero .hero-note').textContent = archive ? 'Previous talks and presentations, newest first.' : 'The weekly rota, talks and presentation record.';
  }
  updateArchiveHeader();
  function text(s){ msg.textContent = s; msg.hidden = !s; }
  function name(id, legacy){
    var p = people.filter(function(x){ return x.slackId === id; })[0];
    return p ? p.name || legacy || 'Presenter' : legacy || (id ? 'Unresolved presenter' : 'Unassigned');
  }
  function initials(person){
    var parts = String(person || '').trim().split(/\s+/);
    return ((parts[0] || '').charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : '')).toUpperCase();
  }
  function fmt(date){ return new Date(date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
  function projectHref(p){ return 'project.html#id=' + encodeURIComponent(p.cardId || p.id) + (p.boardId ? '&board=' + encodeURIComponent(p.boardId) : '') + '&tab=presentations'; }
  function past(m){ return !!m && (m.date + 'T' + (m.startTime || '00:00')) <= new Date().toLocaleString('sv-SE', { timeZone: 'Europe/London', hour12: false }).replace(' ', 'T').slice(0, 16); }
  function future(m){ return !!m && !m.hidden && m.status !== 'skipped' && !past(m); }
  function mine(s){ return !!access && !!access.slackId && !!s.presenterSlackId && s.presenterSlackId === access.slackId; }
  function able(s){ return !!access && mine(s) && future(meetings.filter(function(m){ return m.date === s.meetingId; })[0]) && !s.pendingActionId; }
  function ownShortSlots(){ return slots.filter(function(s){ return s.format === 'short' && mine(s) && !s.pendingActionId && future(meetings.filter(function(m){ return m.date === s.meetingId; })[0]); }); }
  function disabled(ok, reason){ return ok ? '' : ' disabled title="' + esc(reason) + '"'; }
  function slotLabel(s){ return 'Slot ' + s.slotNumber + ' · ' + (s.format === 'long' ? 'Long' : 'Short'); }
  function actionsHtml(id, label, controls){
    return '<div class="rota-actions"><button type="button" class="rota-actions-trigger" aria-label="' + esc(label) + '" aria-expanded="false" aria-controls="' + esc(id) + '" title="' + esc(label) + '">&#8943;</button><div class="rota-actions-menu" id="' + esc(id) + '">' + controls + '</div></div>';
  }
  function swapHtml(s, ready, reason){
    var hint = ready ? 'Request Swap' : 'Request Swap · ' + reason;
    return '<span class="rota-swap-hint" data-rota-hint="' + esc(hint) + '"' + (ready ? '' : ' tabindex="0" aria-label="' + esc(hint) + '"') + '><button type="button" class="rota-swap-trigger" data-action="swap" data-id="' + esc(s.id) + '" aria-label="Request swap"' + (ready ? '' : ' disabled') + '><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4"/></svg></button></span>';
  }
  function declineHtml(s, ready, reason){
    var hint = ready ? 'Decline slot' : 'Decline slot · ' + reason;
    return '<span class="rota-swap-hint" data-rota-hint="' + esc(hint) + '"' + (ready ? '' : ' tabindex="0" aria-label="' + esc(hint) + '"') + '><button type="button" class="rota-swap-trigger" data-action="recuse" data-id="' + esc(s.id) + '" aria-label="Decline slot"' + (ready ? '' : ' disabled') + '><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg></button></span>';
  }
  function slotHtml(s){
    var assigned = !!s.presenterSlackId || !!s.legacyMemberId || !!s.legacyName;
    var project = s.projectId ? projects.filter(function(p){ return p.id === s.projectId; })[0] : null;
    var m = meetings.filter(function(x){ return x.date === s.meetingId; })[0];
    var own = mine(s), admin = access && access.admin;
    var can = able(s), adminEdit = admin && assigned && !s.pendingActionId, open = !assigned && future(m) && !s.pendingActionId;
    var alreadyPresenting = access && slots.some(function(x){ return x.meetingId === s.meetingId && x.presenterSlackId === access.slackId; });
    var claimant = open && !alreadyPresenting && ['short', 'long'].includes(s.format) && access && (access.registered && access.eligible || access.preview);
    var why = !access ? 'Sign in to use this action' : access.reason || 'Only the assigned presenter may use this action for an upcoming slot';
    var swapSources = s.format === 'short' && !own ? ownShortSlots() : [];
    var swapReason = !s.presenterSlackId ? 'This slot has no presenter' : !future(m) ? 'Only upcoming slots can be swapped' : s.pendingActionId ? 'A change is already pending' : !swapSources.length ? 'You need your own upcoming short slot' : access && access.reason || 'An active eligible rota registration is required';
    var swapReady = !!s.presenterSlackId && future(m) && !s.pendingActionId && !!swapSources.length && !!access && (access.registered && access.eligible || access.preview);
    var editAllowed = can || admin && assigned && !s.pendingActionId;
    var editButton = function(field, label, missing){ return '<button type="button" class="rota-field-button' + (missing ? ' is-missing' : '') + '" data-action="edit" data-focus="' + field + '" data-id="' + esc(s.id) + '" aria-label="' + esc(missing ? label : 'Edit ' + (field === 'topic' ? 'title' : field === 'projectId' ? 'project' : 'slides')) + '"' + disabled(editAllowed, why) + '>' + esc(label) + '</button>'; };
    var slide = s.slidesUrl ? '<a data-rota-slides-link href="' + esc(s.slidesUrl) + '" target="_blank" rel="noopener">Slides <span class="rota-resource-arrow" aria-hidden="true">↗</span></a>' : own ? editButton('slidesUrl', 'Add slides', true) : '';
    var projectLink = project ? '<a href="' + projectHref(project) + '" title="' + esc(project.title || 'Project') + '">Project <span class="rota-resource-arrow" aria-hidden="true">↗</span></a>' : own ? editButton('projectId', s.projectId ? 'Project unavailable' : 'Add project', true) : '';
    var topic = own ? editButton('topic', s.topic || 'Add title', !s.topic) : esc(s.topic || 'Topic to come');
    var presenter = name(s.presenterSlackId, s.legacyName);
    var profileId = s.presenterSlackId || (s.legacyMemberId && (members.filter(function(x){ return x.legacyMemberId === s.legacyMemberId; })[0] || {}).id) || '';
    var hasProfile = !!profileId && people.some(function(p){ return p.slackId === profileId; });
    var presenterHtml = hasProfile ? '<a href="person.html?id=' + encodeURIComponent(profileId) + '">' + esc(presenter) + '</a>' : esc(presenter);
    var sharedPhoto = assigned && !!s.presenterSlackId && !!BOLD.photo;
    var outcome = assigned && !future(m) ? (s.outcome === 'presented' ? 'Presented' : s.outcome === 'did-not-present' ? 'Did not present' : 'Unconfirmed') : '';
    var menuControls = (!own && admin && assigned ? '<button type="button" class="btn-text" data-action="edit" data-id="' + esc(s.id) + '"' + disabled(adminEdit, why) + '>' + (s.slidesUrl ? 'Edit talk' : 'Add slides URL / edit talk') + '</button>' : '') +
      (!assigned && future(m) && s.format === 'short' && admin ? '<button type="button" class="btn-text" data-action="offer" data-id="' + esc(s.id) + '"' + disabled(!s.pendingActionId, 'An offer is already pending') + '>Offer short slot</button>' : '') +
      (!own && !future(m) && admin ? '<button type="button" class="btn-text" data-action="outcome" data-id="' + esc(s.id) + '">Set outcome</button>' : '') +
      (s.origin === 'site' && s.revision === 0 && !assigned && admin ? '<button type="button" class="btn-text" data-action="deleteSlot" data-id="' + esc(s.id) + '">Remove slot</button>' : '');
    var slotActions = (own ? declineHtml(s, can, why) : menuControls ? actionsHtml('rota-actions-' + s.id, 'Actions for ' + slotLabel(s), menuControls) : '') + (s.format === 'short' && !own && s.presenterSlackId ? swapHtml(s, swapReady, swapReason) : '');
    return '<article class="rota-slot" id="slot-' + esc(s.meetingId) + '-' + esc(s.slotNumber) + '"><div class="rota-slot-head"><h3>' + esc(slotLabel(s)) + '</h3>' + (outcome ? own && admin ? '<button type="button" class="rota-outcome rota-outcome-edit" data-action="outcome" data-id="' + esc(s.id) + '" title="Set outcome">' + esc(outcome) + '</button>' : '<span class="rota-outcome">' + esc(outcome) + '</span>' : '') + '</div>' +
      '<div class="rota-slot-content"><span class="rota-avatar' + (assigned ? '' : ' rota-avatar--open') + '"' + (sharedPhoto ? ' data-id="' + esc(s.presenterSlackId) + '" data-name="' + esc(presenter) + '"' : '') + ' aria-hidden="true">' + (assigned ? esc(initials(presenter)) : '+') + '</span><div class="rota-slot-details">' +
      '<div class="rota-person-row"><p class="rota-person">' + presenterHtml + (assigned && !hasProfile ? ' <span class="rota-muted">(unresolved account)</span>' : '') + '</p>' + slotActions + '</div>' +
      (assigned ? (topic ? '<p class="rota-topic">' + topic + '</p>' : '') + (slide || projectLink ? '<p class="rota-resources">' + slide + projectLink + '</p>' : '') : '<button type="button" class="btn-text rota-claim" data-action="claim" data-id="' + esc(s.id) + '"' + disabled(claimant, alreadyPresenting ? 'You already present at this meeting' : access && access.reason || 'This slot is unavailable') + '>Claim slot</button>') + '</div></div></article>';
  }
  function meetingHtml(m, index){
    var rows = slots.filter(function(s){ return s.meetingId === m.date; }).sort(function(a,b){ return a.slotNumber - b.slotNumber; });
    var remove = m.origin === 'site' && !rows.length ? '<button type="button" class="btn-text" data-action="deleteMeeting" data-date="' + esc(m.date) + '"' + disabled(access && access.admin, 'Only a rota administrator can remove a new empty meeting') + '>Remove meeting</button>' : '';
    var visibility = '<button type="button" class="btn-text" data-action="meetingVisibility" data-date="' + esc(m.date) + '" data-hidden="' + (m.hidden ? 'false' : 'true') + '"' + disabled(access && access.admin && (!m.hidden || !access.seriesHidden), access && access.seriesHidden && m.hidden ? 'Release the event series first' : 'Only a series organiser, PI or admin can change visibility') + '>' + (m.hidden ? 'Release meeting' : 'Hide meeting') + '</button>';
    return '<section class="rota-meeting' + (index === 0 && !archive ? ' is-next' : '') + '" id="date-' + esc(m.date) + '"><div class="rota-meeting-head has-actions"><div>' + (index === 0 && !archive ? '<span class="rota-meeting-eyebrow">Next meeting</span>' : '') + '<h2>' + esc(fmt(m.date)) + '</h2></div><p>' + esc(m.startTime || '') + ' · ' + esc(m.format || '') + (m.status === 'skipped' ? ' · Skipped' + (m.skipReason ? ': ' + esc(m.skipReason) : '') : '') + (m.hidden ? ' · Hidden' : '') + '</p>' +
      actionsHtml('rota-actions-meeting-' + m.date, 'Actions for meeting on ' + fmt(m.date), visibility + remove) + '</div>' +
      (m.status === 'skipped' ? '' : '<div class="rota-slots rota-slots--' + Math.min(rows.length, 3) + '">' + rows.map(slotHtml).join('') + '</div>') + '</section>';
  }
  function changesHtml(){
    if (changesFailed) return '<p>Could not load the changelog. Close and reopen it to retry.</p>';
    if (changesLoading && !changesLoaded) return '<p>Loading changes…</p>';
    if (!changesLoaded) return '';
    if (!changes.length) return '<p>No changes recorded yet.</p>';
    return '<ol class="rota-changelog-list">' + changes.map(function(e){
      var label = e.date && e.slotNumber ? fmt(e.date) + ' · Slot ' + e.slotNumber : e.title || e.docId || 'Slot';
      var href = e.kind !== 'deleted' && e.date && e.slotNumber ? 'group-meetings.html?date=' + encodeURIComponent(e.date) + '&slot=' + encodeURIComponent(e.slotNumber) : '';
      var by = e.by && (e.by.name || e.by.email);
      return '<li><time>' + esc(new Date(e.at).toLocaleString()) + '</time> · ' + (href ? '<a href="' + esc(href) + '">' + esc(label) + '</a>' : esc(label)) + ' · ' + esc(e.note || e.kind || 'Changed') + (by ? ' · ' + esc(by) : '') + '</li>';
    }).join('') + '</ol>' + (changesMore ? '<button type="button" class="btn-text" data-action="moreChangelog"' + (changesLoading ? ' disabled' : '') + '>Show more</button>' : '');
  }
  function changelogHtml(){
    return '<details class="rota-changelog" id="rotaChangelog"' + (changelogOpen ? ' open' : '') + '><summary>Changelog</summary><div id="rotaChangelogContent">' + changesHtml() + '</div></details>';
  }
  function trackerHtml(){
    var rows = members.filter(function(m){ return m.active; }).map(function(m){
      var own = slots.filter(function(s){ return s.presenterSlackId === m.id; });
      var done = own.filter(function(s){ return s.outcome === 'presented' && past(meetings.filter(function(x){ return x.date === s.meetingId; })[0]); });
      var last = done.slice().sort(function(a,b){ return b.date.localeCompare(a.date); })[0];
      var next = own.filter(function(s){ return future(meetings.filter(function(x){ return x.date === s.meetingId; })[0]); }).sort(function(a,b){ return a.date.localeCompare(b.date); })[0];
      var unknown = own.filter(function(s){ return s.outcome === 'unconfirmed' && past(meetings.filter(function(x){ return x.date === s.meetingId; })[0]); }).length;
      return '<tr><th scope="row">' + esc(name(m.id)) + '</th><td>' + (last ? esc(last.date) : '—') + '</td><td>' + done.filter(function(s){ return s.date.slice(0,4) === String(trackerYear); }).length + '</td><td>' + (next ? '<a href="group-meetings.html?date=' + esc(next.date) + '&slot=' + esc(next.slotNumber) + '">' + esc(next.date) + '</a>' : '—') + '</td><td>' + (unknown || '—') + '</td></tr>';
    });
    return '<details class="rota-tracker" id="rotaTracker"' + (trackerOpen ? ' open' : '') + '><summary>Presenter tracker</summary><label>Confirmed presentations in <input id="rotaTrackerYear" type="number" min="2000" max="2100" value="' + trackerYear + '"></label><div class="rota-table-wrap"><table><thead><tr><th>Presenter</th><th>Last confirmed</th><th>Count</th><th>Next</th><th>Past unconfirmed</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div></details>';
  }
  function manageHtml(){
    return '<details class="rota-manage" id="rotaManage"' + (manageOpen ? ' open' : '') + '><summary>Rota actions</summary><div class="rota-manage-controls">' +
      '<button type="button" class="btn-text" data-action="register"' + disabled(access && access.eligible, 'Eligibility has not been confirmed') + '>' + (access && access.registered ? 'Update registration' : 'Join the rota') + '</button>' +
      '<button type="button" class="btn-text" data-action="leave"' + disabled(access && access.registered, 'Join the rota before leaving future registration') + '>Leave future registration</button>' +
      '<button type="button" class="btn-text" data-action="editSeries"' + disabled(access && access.admin && access.seriesId, 'Only a series organiser, PI or admin can edit the series') + '>Edit event series</button>' +
      '<button type="button" class="btn-text" data-action="season"' + disabled(access && access.admin, 'Only a rota administrator can edit a season') + '>Edit season</button>' +
      '<button type="button" class="btn-text" data-action="meeting"' + disabled(access && access.admin, 'Only a rota administrator can edit a meeting') + '>Add or edit meeting</button></div></details>';
  }
  function loadChangelog(more){
    if (changesLoading) return;
    changesLoading = true; changesFailed = false;
    var root = document.getElementById('rotaChangelogContent');
    if (root) root.innerHTML = changesHtml();
    var query = db.collection('changelog').where('collection', '==', 'groupRotaSlots').orderBy('at', 'desc');
    if (more && changesLast) query = query.startAfter(changesLast);
    query.limit(51).get().then(function(q){
      var page = q.docs.slice(0, 50);
      changes = (more ? changes : []).concat(page.map(function(d){ return d.data(); }));
      changesLast = page.length ? page[page.length - 1] : changesLast;
      changesMore = q.docs.length > 50;
      changesLoaded = true; changesLoading = false;
      var content = document.getElementById('rotaChangelogContent'); if (content) content.innerHTML = changesHtml();
    }).catch(function(e){
      console.error('[BOLD Lab] rota changelog load failed', e);
      changesFailed = true; changesLoading = false;
      var content = document.getElementById('rotaChangelogContent'); if (content) content.innerHTML = changesHtml();
    });
  }
  function render(){
    if (!user) return;
    hideResourceHint();
    var season = seasons.filter(function(s){ return s.publicationState === 'published'; })[0] || seasons[0];
    document.getElementById('rotaMeta').textContent = season ? [season.label, season.regularTime].filter(Boolean).join(' · ') : '';
    var ordered = meetings.filter(function(m){ return search ? true : archive ? past(m) : !past(m); })
      .sort(function(a,b){
        if (search) {
          var aPast = past(a), bPast = past(b);
          if (aPast !== bPast) return aPast ? 1 : -1;
          return aPast ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date);
        }
        return archive ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date);
      });
    var filtered = ordered.filter(function(m){
      return !search || slots.some(function(s){ return s.meetingId === m.date && (name(s.presenterSlackId, s.legacyName) + ' ' + s.topic).toLowerCase().includes(search); });
    });
    if (pendingJump && !search) {
      var linkedIndex = filtered.findIndex(function(m){ return m.date === selectedDate; });
      if (linkedIndex >= visibleCount) visibleCount = linkedIndex + 1;
    }
    var visible = filtered.slice(0, visibleCount);
    var remaining = filtered.length - visible.length;
    var more = remaining ? '<div class="rota-more"><span>Showing ' + visible.length + ' of ' + filtered.length + ' meetings</span><button type="button" class="btn-text" data-action="moreMeetings">Show ' + Math.min(10, remaining) + ' more</button></div>' : '';
    var notice = access && !access.eligible ? '<p class="rota-alert">New assignments and swaps are unavailable until your Slack eligibility is confirmed. Published assignments remain visible.</p>' : '';
    var pendingSwaps = access ? (access.swaps || []).filter(function(s){ return s.status === 'pending'; }) : [];
    body.innerHTML = notice +
      (pendingSwaps.length ? '<section class="rota-pending"><h2>Pending swaps</h2><ul>' + pendingSwaps.map(function(s){ return '<li>' + esc(s.slotId + ' ↔ ' + s.otherSlotId) + ' · Slack: ' + esc(s.notificationState || 'queued') + (s.requesterSlackId === access.slackId ? ' <button type="button" class="btn-text" data-action="cancelSwap" data-id="' + esc(s.id) + '">Cancel request</button>' + (s.notificationState === 'failed' ? ' <button type="button" class="btn-text" data-action="retrySwap" data-id="' + esc(s.id) + '">Retry message</button>' : '') : ' · Respond in Slack') + '</li>'; }).join('') + '</ul></section>' : '') +
      '<div id="rotaPanel"></div>' + (filtered.length ? visible.map(meetingHtml).join('') + more : '<p>' + (search ? 'No meetings match.' : archive ? 'No past meetings yet.' : 'No upcoming meetings.') + '</p>') + trackerHtml() + manageHtml() + changelogHtml();
    body.hidden = false; text('');
    if (BOLD.photo) BOLD.photo.mountMany(body.querySelectorAll('.rota-avatar[data-id]'));
    if (panel) document.getElementById('rotaPanel').innerHTML = panel;
    if (pendingJump) {
      var target = selectedSlot && document.getElementById('slot-' + selectedDate + '-' + selectedSlot) || document.getElementById('date-' + selectedDate);
      if (target) { target.scrollIntoView({ block: 'center' }); pendingJump = false; }
    }
  }
  function refresh(){
    if (!user || busy) return;
    text('Loading…');
    call('Access').then(function(a){ access = a.data; return Promise.all([
      call('Snapshot'), db.collection('projectWorkspaces').get().catch(function(){ return { docs: [] }; })
    ]); }).then(function(v){
      var snapshot = v[0].data;
      meetings = snapshot.meetings || [];
      var linkedMeeting = selectedDate && meetings.filter(function(m){ return m.date === selectedDate; })[0];
      if (linkedMeeting) { archive = past(linkedMeeting); updateArchiveHeader(); }
      slots = snapshot.slots || [];
      members = snapshot.members || [];
      seasons = snapshot.seasons || [];
      projects = v[1].docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
      people = access.people || []; render();
    }).catch(function(e){ console.error('[BOLD Lab] rota load failed', e); text('Could not load the rota. ' + (e.message || 'Try again.')); });
  }
  function showPanel(html){ panel = '<div class="rota-panel">' + html + '<button type="button" class="btn-text" data-action="close">Cancel</button></div>'; render(); document.getElementById('rotaPanel').scrollIntoView({ block: 'nearest' }); }
  function projectOptions(selected){
    var email = user && user.email ? user.email.toLowerCase() : '';
    var mine = projects.filter(function(p){ return access && (p.members || []).map(function(x){ return String(x).toLowerCase(); }).includes(email) || p.id === selected; });
    return '<option value="">No project</option>' + mine.map(function(p){ return '<option value="' + esc(p.id) + '"' + (p.id === selected ? ' selected' : '') + '>' + esc(p.title || p.id) + '</option>'; }).join('');
  }
  function openAction(action, s, focusField){
    if (action === 'edit') {
      showPanel('<h2>Edit talk</h2><form id="rotaForm" data-submit="Edit" data-id="' + esc(s.id) + '"><label>Title <input name="topic" maxlength="140" value="' + esc(s.topic || '') + '"></label><label>Project <select name="projectId">' + projectOptions(s.projectId) + '</select></label><label>Slides URL <input name="slidesUrl" type="url" value="' + esc(s.slidesUrl || '') + '" placeholder="https://…"></label>' + (access.admin && !mine(s) ? '<label>Correction note <textarea name="auditNote" required maxlength="300"></textarea></label>' : '') + '<button type="submit">Save</button></form>');
      if (['topic', 'projectId', 'slidesUrl'].includes(focusField)) document.getElementById('rotaForm').elements[focusField].focus({ preventScroll: true });
    }
    if (action === 'recuse') showPanel('<h2>Decline slot</h2><form id="rotaForm" data-submit="Recuse" data-id="' + esc(s.id) + '"><label>Reason (private) <textarea name="reason" required maxlength="2000"></textarea></label><button type="submit">Decline slot</button></form>');
    if (action === 'swap') {
      var sources = ownShortSlots();
      showPanel('<h2>Request swap</h2><p>Ask ' + esc(name(s.presenterSlackId)) + ' to swap their ' + esc(fmt(s.meetingId)) + ' slot with yours. They can confirm or decline in Slack.</p><form id="rotaForm" data-submit="RequestSwap" data-id="' + esc(s.id) + '"><label>Your short slot <select name="slotId" required>' + sources.map(function(x){ return '<option value="' + esc(x.id) + '">' + esc(fmt(x.meetingId) + ' · Slot ' + x.slotNumber) + '</option>'; }).join('') + '</select></label><button type="submit"' + disabled(sources.length && !(access && access.preview), access && access.preview ? 'Changes are unavailable in the local preview' : 'No upcoming short slot to swap') + '>Send request</button></form>');
    }
    if (action === 'outcome') showPanel('<h2>Presentation outcome</h2><form id="rotaForm" data-submit="Outcome" data-id="' + esc(s.id) + '"><label>Outcome <select name="outcome">' + ['unconfirmed','presented','did-not-present'].map(function(v){ return '<option value="' + v + '"' + (s.outcome === v ? ' selected' : '') + '>' + v + '</option>'; }).join('') + '</select></label><button type="submit">Save</button></form>');
    if (action === 'offer') {
      var options = members.filter(function(m){ return m.active && !slots.some(function(x){ return x.meetingId === s.meetingId && x.presenterSlackId === m.id; }); });
      showPanel('<h2>Offer short slot</h2><form id="rotaForm" data-submit="OfferShort" data-id="' + esc(s.id) + '"><label>Presenter <select name="recipientSlackId" required>' + options.map(function(m){ return '<option value="' + esc(m.id) + '">' + esc(name(m.id)) + '</option>'; }).join('') + '</select></label><button type="submit"' + disabled(options.length, 'No available registered presenter') + '>Send offer</button></form>');
    }
  }
  function syncMenu(menu){
    if (!menu) return;
    var open = menu.classList.contains('is-open') || menu.matches(':hover') || menu.contains(document.activeElement);
    menu.querySelector('.rota-actions-trigger').setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function closeMenus(except){
    body.querySelectorAll('.rota-actions.is-open').forEach(function(menu){
      if (menu !== except) { menu.classList.remove('is-open'); syncMenu(menu); }
    });
  }
  body.addEventListener('pointerover', function(e){
    syncMenu(e.target.closest('.rota-actions'));
    var target = e.target.closest('[data-rota-hint]');
    if (target) showResourceHint(target);
  });
  body.addEventListener('pointerout', function(e){
    var menu = e.target.closest('.rota-actions');
    if (menu && !menu.contains(e.relatedTarget)) setTimeout(function(){ syncMenu(menu); }, 0);
    var hinted = e.target.closest('[data-rota-hint]');
    if (hinted && !hinted.contains(e.relatedTarget)) hideResourceHint();
  });
  body.addEventListener('focusin', function(e){
    syncMenu(e.target.closest('.rota-actions'));
    var target = e.target.closest('[data-rota-hint]');
    if (target) showResourceHint(target);
  });
  body.addEventListener('focusout', function(e){
    var menu = e.target.closest('.rota-actions');
    if (menu) setTimeout(function(){ syncMenu(menu); }, 0);
    if (e.target.closest('[data-rota-hint]')) hideResourceHint();
  });
  body.addEventListener('keydown', function(e){
    if (e.key !== 'Escape') return;
    var menu = e.target.closest('.rota-actions');
    if (!menu) return;
    closeMenus();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    syncMenu(menu);
  });
  body.addEventListener('toggle', function(e){
    if (e.target.id === 'rotaManage') { manageOpen = e.target.open; return; }
    if (e.target.id === 'rotaTracker') { trackerOpen = e.target.open; return; }
    if (e.target.id !== 'rotaChangelog') return;
    changelogOpen = e.target.open;
    if (changelogOpen && (!changesLoaded || changesFailed)) loadChangelog(false);
  }, true);
  body.addEventListener('click', function(e){
    var trigger = e.target.closest('.rota-actions-trigger');
    if (trigger) {
      var menu = trigger.closest('.rota-actions');
      closeMenus(menu); menu.classList.add('is-open'); syncMenu(menu); return;
    }
    closeMenus();
    var button = e.target.closest('[data-action]'); if (!button || button.disabled || busy) return;
    if (button.closest('.rota-actions')) button.blur();
    var action = button.dataset.action, s = slots.filter(function(x){ return x.id === button.dataset.id; })[0];
    if (action === 'moreMeetings') { visibleCount += 10; render(); return; }
    if (action === 'moreChangelog') { loadChangelog(true); return; }
    if (action === 'close') { panel = null; render(); return; }
    if (action === 'cancelSwap') { act('CancelSwap', { id: button.dataset.id }); return; }
    if (action === 'retrySwap') { act('RetrySwap', { id: button.dataset.id }); return; }
    if (action === 'claim') { act('Claim', { slotId: s.id }); return; }
    if (action === 'deleteSlot') { act('DeleteSlot', { slotId: s.id }); return; }
    if (action === 'deleteMeeting') { act('DeleteMeeting', { date: button.dataset.date }); return; }
    if (action === 'meetingVisibility') {
      var hidden = button.dataset.hidden === 'true', date = button.dataset.date;
      BOLD.confirmAction({ title: (hidden ? 'Hide' : 'Release') + ' the meeting on ' + fmt(date) + '?', go: hidden ? 'Hide meeting' : 'Release meeting',
        effects: [hidden ? 'Hide this date from members’ Events, Calendar and rota' : 'Show this date on Events, Calendar and the rota'], always: true
      }).then(function(ok){ if (ok) act('SetMeetingVisibility', { date: date, hidden: hidden }); });
      return;
    }
    if (action === 'leave') { act('Leave', {}); return; }
    if (action === 'editSeries') { location.href = 'series.html?series=' + encodeURIComponent(access.seriesId) + '&edit=1&back=group-meetings.html'; return; }
    if (action === 'register') { showPanel('<h2>Join the rota</h2><form id="rotaForm" data-submit="Register"><label>Category <select name="category"><option value="phd">PhD</option><option value="masters">Master’s</option><option value="postdoc">Postdoc</option><option value="associate">Associate</option></select></label><button type="submit">Save registration</button></form>'); return; }
    if (action === 'season') {
      var season = seasons[0] || {};
      showPanel('<h2>Season details</h2><form id="rotaForm" data-submit="SaveSeason"><label>Season ID <input name="id" required pattern="[a-z0-9-]+" value="' + esc(season.id || '') + '"></label><label>Label <input name="label" required value="' + esc(season.label || '') + '"></label><label>Regular time <input name="regularTime" value="' + esc(season.regularTime || '') + '"></label><label>Location <input name="location" value="' + esc(season.location || '') + '"></label><label>Rotation description <textarea name="rotationDescription">' + esc(season.rotationDescription || '') + '</textarea></label><label>Visibility <select name="publicationState"><option value="draft"' + (season.publicationState === 'draft' ? ' selected' : '') + '>Hidden draft</option><option value="published"' + (season.publicationState === 'published' ? ' selected' : '') + '>Published</option></select></label><button type="submit">Save season</button></form>'); return;
    }
    if (action === 'meeting') {
      var m = meetings.filter(function(x){ return x.date === selectedDate; })[0] || meetings[0] || {};
      showPanel('<h2>Meeting details</h2><form id="rotaForm" data-submit="SaveMeeting"><label>Date <input type="date" name="date" required value="' + esc(m.date || '') + '"></label><label>Season <select name="seasonId">' + seasons.map(function(x){ return '<option value="' + esc(x.id) + '"' + (x.id === m.seasonId ? ' selected' : '') + '>' + esc(x.label || x.id) + '</option>'; }).join('') + '</select></label><label>Format <select name="format"><option value="short"' + (m.format === 'short' ? ' selected' : '') + '>Short</option><option value="long"' + (m.format === 'long' ? ' selected' : '') + '>Long</option></select></label><label>Start <input type="time" name="startTime" value="' + esc(m.startTime || '') + '"></label><label>Duration in minutes <input type="number" name="durationMinutes" min="15" max="480" value="' + esc(m.durationMinutes || 60) + '"></label><label>Location <input name="location" value="' + esc(m.location || '') + '"></label><button type="submit">Save meeting</button></form>'); return;
    }
    if (s) openAction(action, s, button.dataset.focus);
  });
  body.addEventListener('submit', function(e){
    if (e.target.id !== 'rotaForm') return; e.preventDefault();
    var f = e.target, data = Object.fromEntries(new FormData(f).entries());
    if (f.dataset.submit === 'SaveMeeting') data.durationMinutes = Number(data.durationMinutes);
    var s = slots.filter(function(x){ return x.id === f.dataset.id; })[0];
    if (s && f.dataset.submit === 'RequestSwap') data.otherSlotId = s.id;
    else if (s) { data.slotId = s.id; data.revision = s.revision; }
    if (f.dataset.submit === 'RequestSwap') {
      BOLD.confirmAction({ title: 'Request a swap with ' + name(s.presenterSlackId) + '?', go: 'Send request', effects: ['Send ' + name(s.presenterSlackId) + ' a Slack message asking them to confirm or decline the swap'] }).then(function(ok){ if (ok) act('RequestSwap', data); });
      return;
    }
    if (f.dataset.submit === 'OfferShort') {
      BOLD.confirmAction({ title: 'Offer this short slot to ' + name(data.recipientSlackId) + '?', go: 'Send offer', effects: ['Send ' + name(data.recipientSlackId) + ' a Slack message with Accept and Decline buttons'] }).then(function(ok){ if (ok) act('OfferShort', data); });
      return;
    }
    act(f.dataset.submit, data);
  });
  body.addEventListener('change', function(e){ if (e.target.id === 'rotaTrackerYear') { trackerYear = Number(e.target.value) || new Date().getFullYear(); render(); } });
  document.getElementById('rotaSearch').addEventListener('input', function(e){ search = e.target.value.toLowerCase().trim(); visibleCount = 10; render(); });
  function act(name, data){
    busy = true; text('Saving…');
    call(name, data).then(function(){ busy = false; panel = null; refresh(); }).catch(function(e){ busy = false; text(e.message || 'Could not save. Reload and try again.'); });
  }
  BOLD.onUser(function(u){ user = u; if (!u) { body.hidden = true; text('Sign in to view the rota.'); return; } refresh(); });
})();
