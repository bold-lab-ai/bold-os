(function(){
  'use strict';
  if (!BOLD.getAuth()) return;
  var db = firebase.firestore(BOLD.getApp());
  var call = function(name, data){ return firebase.app().functions('europe-west2').httpsCallable('groupRota' + name)(data || {}); };
  var esc = BOLD.escapeHtml, msg = document.getElementById('rotaMessage'), body = document.getElementById('rotaBody');
  var user = null, access = null, meetings = [], slots = [], members = [], people = [], seasons = [], projects = [], photoUrls = {}, busy = false;
  var manageOpen = false, changelogOpen = false, changes = [], changesLoaded = false, changesLoading = false, changesFailed = false, changesLast = null, changesMore = false;
  var params = new URLSearchParams(location.search), selectedDate = params.get('date') || '', selectedSlot = params.get('slot') || '', archive = params.get('archive') === '1';
  var search = '', panel = null, visibleCount = 10, pendingJump = !!selectedDate, trackerOpen = false, trackerYear = new Date().getFullYear();
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
  function publicPhoto(s, person){ return photoUrls[s.presenterSlackId] || ''; }
  function fmt(date){ return new Date(date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
  function projectHref(p){ return 'project.html#id=' + encodeURIComponent(p.cardId || p.id) + (p.boardId ? '&board=' + encodeURIComponent(p.boardId) : '') + '&tab=presentations'; }
  function past(m){ return !!m && (m.date + 'T' + (m.startTime || '00:00')) <= new Date().toLocaleString('sv-SE', { timeZone: 'Europe/London', hour12: false }).replace(' ', 'T').slice(0, 16); }
  function future(m){ return !!m && m.status !== 'skipped' && !past(m); }
  function mine(s){ return !!access && !!access.slackId && !!s.presenterSlackId && s.presenterSlackId === access.slackId; }
  function able(s){ return !!access && mine(s) && future(meetings.filter(function(m){ return m.date === s.meetingId; })[0]) && !s.pendingActionId; }
  function disabled(ok, reason){ return ok ? '' : ' disabled title="' + esc(reason) + '"'; }
  function slotLabel(s){ return 'Slot ' + s.slotNumber + ' · ' + (s.format === 'long' ? 'Long' : 'Short'); }
  function actionsHtml(id, label, controls){
    return '<div class="rota-actions"><button type="button" class="rota-actions-trigger" aria-label="' + esc(label) + '" aria-expanded="false" aria-controls="' + esc(id) + '" title="' + esc(label) + '">&#8230;</button><div class="rota-actions-menu" id="' + esc(id) + '">' + controls + '</div></div>';
  }
  function slotHtml(s){
    var assigned = !!s.presenterSlackId || !!s.legacyMemberId || !!s.legacyName;
    var project = s.projectId ? projects.filter(function(p){ return p.id === s.projectId; })[0] : null;
    var m = meetings.filter(function(x){ return x.date === s.meetingId; })[0];
    var can = able(s), canSwap = can && access.registered && access.eligible, adminEdit = access && access.admin && assigned && !s.pendingActionId, open = !assigned && future(m) && !s.pendingActionId, claimant = open && s.format === 'long' && access && access.registered && access.eligible;
    var why = !access ? 'Sign in to use this action' : access.reason || 'Only the assigned presenter may use this action for an upcoming slot';
    var slide = s.slidesUrl ? '<a href="' + esc(s.slidesUrl) + '" target="_blank" rel="noopener">Slides</a>' : '<span class="rota-muted">Slides not added</span>';
    var presenter = name(s.presenterSlackId, s.legacyName);
    var photo = assigned ? publicPhoto(s, presenter) : '';
    var outcome = assigned && !future(m) ? (s.outcome === 'presented' ? 'Presented' : s.outcome === 'did-not-present' ? 'Did not present' : 'Unconfirmed') : '';
    return '<article class="rota-slot" id="slot-' + esc(s.meetingId) + '-' + esc(s.slotNumber) + '"><div class="rota-slot-head"><h3>' + esc(slotLabel(s)) + '</h3>' + (outcome ? '<span class="rota-outcome">' + esc(outcome) + '</span>' : '') + '</div>' +
      '<div class="rota-slot-content"><span class="rota-avatar' + (assigned ? '' : ' rota-avatar--open') + '" aria-hidden="true">' + (assigned ? esc(initials(presenter)) + (photo ? '<img class="rota-avatar-photo" src="' + esc(photo) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : '') : '+') + '</span><div class="rota-slot-details">' +
      '<p class="rota-person">' + esc(presenter) + (assigned && (!s.presenterSlackId || !people.some(function(p){ return p.slackId === s.presenterSlackId; })) ? ' <span class="rota-muted">(unresolved account)</span>' : '') + '</p>' +
      (assigned ? '<div class="rota-topic-row"><p class="rota-topic">' + esc(s.topic || 'Topic to come') + '</p><p class="rota-slides">' + slide + '</p></div>' : '') +
      (s.projectId ? '<p class="rota-project">' + (project ? '<a href="' + projectHref(project) + '">' + esc(project.title || 'Project') + '</a>' : '<span class="rota-muted">Project unavailable</span>') + '</p>' : '') + '</div></div>' +
      actionsHtml('rota-actions-' + s.id, 'Actions for ' + slotLabel(s),
      '<button type="button" class="btn-text" data-action="edit" data-id="' + esc(s.id) + '"' + disabled(can || adminEdit, why) + '>' + (s.slidesUrl ? 'Edit talk' : 'Add slides URL / edit talk') + '</button>' +
      '<button type="button" class="btn-text" data-action="swap" data-id="' + esc(s.id) + '"' + disabled(canSwap, access && access.reason || why) + '>Swap</button>' +
      '<button type="button" class="btn-text" data-action="recuse" data-id="' + esc(s.id) + '"' + disabled(can, why) + '>Decline slot</button>' +
      '<button type="button" class="btn-text" data-action="claim" data-id="' + esc(s.id) + '"' + disabled(claimant, s.format !== 'long' ? 'Only open long slots can be claimed' : access && access.reason || 'This slot is unavailable') + '>Claim</button>' +
      (!assigned && future(m) && s.format === 'short' ? '<button type="button" class="btn-text" data-action="offer" data-id="' + esc(s.id) + '"' + disabled(access && access.admin && !s.pendingActionId, access && access.admin ? 'An offer is already pending' : 'Only a rota administrator can offer a short slot') + '>Offer short slot</button>' : '') +
      (!future(m) ? '<button type="button" class="btn-text" data-action="outcome" data-id="' + esc(s.id) + '"' + disabled(access && access.admin, 'Only a rota administrator can set presentation outcomes') + '>Set outcome</button>' : '') +
      (s.origin === 'site' && s.revision === 0 && !assigned ? '<button type="button" class="btn-text" data-action="deleteSlot" data-id="' + esc(s.id) + '"' + disabled(access && access.admin, 'Only a rota administrator can remove a new open slot') + '>Remove slot</button>' : '')) + '</article>';
  }
  function meetingHtml(m, index){
    var rows = slots.filter(function(s){ return s.meetingId === m.date; }).sort(function(a,b){ return a.slotNumber - b.slotNumber; });
    var remove = m.origin === 'site' && !rows.length ? '<button type="button" class="btn-text" data-action="deleteMeeting" data-date="' + esc(m.date) + '"' + disabled(access && access.admin, 'Only a rota administrator can remove a new empty meeting') + '>Remove meeting</button>' : '';
    return '<section class="rota-meeting' + (index === 0 && !archive ? ' is-next' : '') + '" id="date-' + esc(m.date) + '"><div class="rota-meeting-head' + (remove ? ' has-actions' : '') + '"><div><span class="rota-meeting-eyebrow">' + (index === 0 && !archive ? 'Next meeting' : archive ? 'Past meeting' : 'Group meeting') + '</span><h2>' + esc(fmt(m.date)) + '</h2></div><p>' + esc(m.startTime || '') + ' · ' + esc(m.format || '') + (m.location ? ' · ' + esc(m.location) : '') + (m.status === 'skipped' ? ' · Skipped' + (m.skipReason ? ': ' + esc(m.skipReason) : '') : '') + '</p>' +
      (remove ? actionsHtml('rota-actions-meeting-' + m.date, 'Actions for meeting on ' + fmt(m.date), remove) : '') + '</div>' +
      (m.status === 'skipped' ? '' : '<div class="rota-slots">' + rows.map(slotHtml).join('') + '</div>') + '</section>';
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
      '<button type="button" class="btn-text" data-action="season"' + disabled(access && access.admin, 'Only a rota administrator can edit a season') + '>Edit season</button>' +
      '<button type="button" class="btn-text" data-action="meeting"' + disabled(access && access.admin, 'Only a rota administrator can edit a meeting') + '>Add or edit meeting</button>' +
      '<button type="button" class="btn-text" data-action="photo"' + disabled(access && access.slackId, 'Your Slack account must match the roster') + '>Your rota photo</button></div></details>';
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
    var season = seasons.filter(function(s){ return s.publicationState === 'published'; })[0] || seasons[0];
    document.getElementById('rotaMeta').textContent = season ? [season.label, season.regularTime, season.location].filter(Boolean).join(' · ') : '';
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
    var dateNav = document.getElementById('rotaDates');
    var navMeetings = meetings.filter(function(m){ return future(m); }).sort(function(a,b){ return a.date.localeCompare(b.date); }).slice(0, 6);
    dateNav.hidden = archive || !!search || !navMeetings.length;
    dateNav.innerHTML = dateNav.hidden ? '' : '<span class="rota-dates-label">Coming up</span>' + navMeetings.map(function(m){
      return '<a href="group-meetings.html?date=' + esc(m.date) + '">' + esc(new Date(m.date + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })) + '</a>';
    }).join('');
    var remaining = filtered.length - visible.length;
    var more = remaining ? '<div class="rota-more"><span>Showing ' + visible.length + ' of ' + filtered.length + ' meetings</span><button type="button" class="btn-text" data-action="moreMeetings">Show ' + Math.min(10, remaining) + ' more</button></div>' : '';
    var notice = access && !access.eligible ? '<p class="rota-alert">New assignments and swaps are unavailable until your Slack eligibility is confirmed. Published assignments remain visible.</p>' : '';
    var pendingSwaps = access ? (access.swaps || []).filter(function(s){ return s.status === 'pending'; }) : [];
    body.innerHTML = notice +
      (pendingSwaps.length ? '<section class="rota-pending"><h2>Pending swaps</h2><ul>' + pendingSwaps.map(function(s){ return '<li>' + esc(s.slotId + ' ↔ ' + s.otherSlotId) + ' · Slack: ' + esc(s.notificationState || 'queued') + (s.requesterSlackId === access.slackId ? ' <button type="button" class="btn-text" data-action="cancelSwap" data-id="' + esc(s.id) + '">Cancel request</button>' + (s.notificationState === 'failed' ? ' <button type="button" class="btn-text" data-action="retrySwap" data-id="' + esc(s.id) + '">Retry message</button>' : '') : ' · Respond in Slack') + '</li>'; }).join('') + '</ul></section>' : '') +
      '<div id="rotaPanel"></div>' + (filtered.length ? visible.map(meetingHtml).join('') + more : '<p>' + (search ? 'No meetings match.' : archive ? 'No past meetings yet.' : 'No upcoming meetings.') + '</p>') + trackerHtml() + manageHtml() + changelogHtml();
    body.hidden = false; text('');
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
      db.collection('groupMeetings').get(), db.collection('groupRotaSlots').get(), db.collection('groupRotaMembers').get(),
      (access.canSeeDrafts ? db.collection('groupMeetingSeasons') : db.collection('groupMeetingSeasons').where('publicationState', '==', 'published')).get(),
      db.collection('projectWorkspaces').get().catch(function(){ return { docs: [] }; }), db.collection('groupRotaPhotos').get()
    ]); }).then(function(v){
      meetings = v[0].docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
      var linkedMeeting = selectedDate && meetings.filter(function(m){ return m.date === selectedDate; })[0];
      if (linkedMeeting) { archive = past(linkedMeeting); updateArchiveHeader(); }
      slots = v[1].docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
      members = v[2].docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
      seasons = v[3].docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
      projects = v[4].docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
      people = access.people || []; photoUrls = {}; render();
      if (v[5].docs.length && !window.ROTA_LOCAL_PREVIEW) Promise.all(v[5].docs.map(function(d){
        return firebase.storage(BOLD.getApp()).ref(d.data().path).getDownloadURL().then(function(url){ photoUrls[d.id] = url; }).catch(function(){});
      })).then(render);
    }).catch(function(e){ console.error('[BOLD Lab] rota load failed', e); text('Could not load the rota. ' + (e.message || 'Try again.')); });
  }
  function showPanel(html){ panel = '<div class="rota-panel">' + html + '<button type="button" class="btn-text" data-action="close">Cancel</button></div>'; render(); document.getElementById('rotaPanel').scrollIntoView({ block: 'nearest' }); }
  function projectOptions(selected){
    var mine = projects.filter(function(p){ return access && (p.members || []).map(function(x){ return String(x).toLowerCase(); }).includes(user.email.toLowerCase()) || p.id === selected; });
    return '<option value="">No project</option>' + mine.map(function(p){ return '<option value="' + esc(p.id) + '"' + (p.id === selected ? ' selected' : '') + '>' + esc(p.title || p.id) + '</option>'; }).join('');
  }
  function openAction(action, s){
    if (action === 'edit') showPanel('<h2>Edit talk</h2><form id="rotaForm" data-submit="Edit" data-id="' + esc(s.id) + '"><label>Topic <input name="topic" maxlength="140" value="' + esc(s.topic || '') + '"></label><label>Project <select name="projectId">' + projectOptions(s.projectId) + '</select></label><label>Slides URL <input name="slidesUrl" type="url" value="' + esc(s.slidesUrl || '') + '" placeholder="https://…"></label>' + (access.admin && !mine(s) ? '<label>Correction note <textarea name="auditNote" required maxlength="300"></textarea></label>' : '') + '<button type="submit">Save</button></form>');
    if (action === 'recuse') showPanel('<h2>Decline slot</h2><form id="rotaForm" data-submit="Recuse" data-id="' + esc(s.id) + '"><label>Reason (private) <textarea name="reason" required maxlength="2000"></textarea></label><button type="submit">Decline slot</button></form>');
    if (action === 'swap') {
      var others = slots.filter(function(x){ return x.id !== s.id && x.format === s.format && x.presenterSlackId && x.presenterSlackId !== s.presenterSlackId && !x.pendingActionId && future(meetings.filter(function(m){ return m.date === x.meetingId; })[0]); });
      showPanel('<h2>Request swap</h2><form id="rotaForm" data-submit="RequestSwap" data-id="' + esc(s.id) + '"><label>Other presenter’s slot <select name="otherSlotId" required>' + others.map(function(x){ return '<option value="' + esc(x.id) + '">' + esc(x.date + ' · ' + name(x.presenterSlackId)) + '</option>'; }).join('') + '</select></label><button type="submit"' + disabled(others.length, 'No matching slots') + '>Send request</button></form>');
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
  body.addEventListener('error', function(e){
    if (e.target.classList && e.target.classList.contains('rota-avatar-photo')) e.target.remove();
  }, true);
  body.addEventListener('pointerover', function(e){ syncMenu(e.target.closest('.rota-actions')); });
  body.addEventListener('pointerout', function(e){
    var menu = e.target.closest('.rota-actions');
    if (menu && !menu.contains(e.relatedTarget)) setTimeout(function(){ syncMenu(menu); }, 0);
  });
  body.addEventListener('focusin', function(e){ syncMenu(e.target.closest('.rota-actions')); });
  body.addEventListener('focusout', function(e){
    var menu = e.target.closest('.rota-actions');
    if (menu) setTimeout(function(){ syncMenu(menu); }, 0);
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
    if (action === 'deleteSlot') { act('DeleteSlot', { slotId: s.id }); return; }
    if (action === 'deleteMeeting') { act('DeleteMeeting', { date: button.dataset.date }); return; }
    if (action === 'claim') { act('Claim', { slotId: s.id }); return; }
    if (action === 'leave') { act('Leave', {}); return; }
    if (action === 'register') { showPanel('<h2>Join the rota</h2><form id="rotaForm" data-submit="Register"><label>Category <select name="category"><option value="phd">PhD</option><option value="masters">Master’s</option><option value="postdoc">Postdoc</option><option value="associate">Associate</option></select></label><button type="submit">Save registration</button></form>'); return; }
    if (action === 'photo') { showPanel('<h2>Your rota photo</h2><p>Choose a WebP, PNG or JPEG image up to 2 MB.</p><label>Photo <input type="file" id="rotaPhotoFile" accept="image/webp,image/png,image/jpeg"></label><button type="button" class="btn-text" data-action="uploadPhoto">Save photo</button> <button type="button" class="btn-text" data-action="removePhoto"' + disabled(!!photoUrls[access.slackId], 'No photo to remove') + '>Remove photo</button>'); return; }
    if (action === 'uploadPhoto' || action === 'removePhoto') { savePhoto(action === 'removePhoto'); return; }
    if (action === 'season') {
      var season = seasons[0] || {};
      showPanel('<h2>Season details</h2><form id="rotaForm" data-submit="SaveSeason"><label>Season ID <input name="id" required pattern="[a-z0-9-]+" value="' + esc(season.id || '') + '"></label><label>Label <input name="label" required value="' + esc(season.label || '') + '"></label><label>Regular time <input name="regularTime" value="' + esc(season.regularTime || '') + '"></label><label>Location <input name="location" value="' + esc(season.location || '') + '"></label><label>Rotation description <textarea name="rotationDescription">' + esc(season.rotationDescription || '') + '</textarea></label><label>Visibility <select name="publicationState"><option value="draft"' + (season.publicationState === 'draft' ? ' selected' : '') + '>Hidden draft</option><option value="published"' + (season.publicationState === 'published' ? ' selected' : '') + '>Published</option></select></label><button type="submit">Save season</button></form>'); return;
    }
    if (action === 'meeting') {
      var m = meetings.filter(function(x){ return x.date === selectedDate; })[0] || meetings[0] || {};
      showPanel('<h2>Meeting details</h2><form id="rotaForm" data-submit="SaveMeeting"><label>Date <input type="date" name="date" required value="' + esc(m.date || '') + '"></label><label>Season <select name="seasonId">' + seasons.map(function(x){ return '<option value="' + esc(x.id) + '"' + (x.id === m.seasonId ? ' selected' : '') + '>' + esc(x.label || x.id) + '</option>'; }).join('') + '</select></label><label>Format <select name="format"><option value="short"' + (m.format === 'short' ? ' selected' : '') + '>Short</option><option value="long"' + (m.format === 'long' ? ' selected' : '') + '>Long</option></select></label><label>Start <input type="time" name="startTime" value="' + esc(m.startTime || '') + '"></label><label>Duration in minutes <input type="number" name="durationMinutes" min="15" max="480" value="' + esc(m.durationMinutes || 60) + '"></label><label>Location <input name="location" value="' + esc(m.location || '') + '"></label><button type="submit">Save meeting</button></form>'); return;
    }
    if (s) openAction(action, s);
  });
  body.addEventListener('submit', function(e){
    if (e.target.id !== 'rotaForm') return; e.preventDefault();
    var f = e.target, data = Object.fromEntries(new FormData(f).entries());
    if (f.dataset.submit === 'SaveMeeting') data.durationMinutes = Number(data.durationMinutes);
    var s = slots.filter(function(x){ return x.id === f.dataset.id; })[0];
    if (s) { data.slotId = s.id; data.revision = s.revision; }
    act(f.dataset.submit, data);
  });
  body.addEventListener('change', function(e){ if (e.target.id === 'rotaTrackerYear') { trackerYear = Number(e.target.value) || new Date().getFullYear(); render(); } });
  document.getElementById('rotaSearch').addEventListener('input', function(e){ search = e.target.value.toLowerCase().trim(); visibleCount = 10; render(); });
  function act(name, data){
    busy = true; text('Saving…');
    call(name, data).then(function(){ busy = false; panel = null; refresh(); }).catch(function(e){ busy = false; text(e.message || 'Could not save. Reload and try again.'); });
  }
  function savePhoto(remove){
    if (!access || !access.slackId) return;
    var path = 'rota-profiles/' + access.slackId + '/portrait', ref = firebase.storage(BOLD.getApp()).ref(path), doc = db.collection('groupRotaPhotos').doc(access.slackId);
    var file = !remove && document.getElementById('rotaPhotoFile').files[0];
    if (!remove && (!file || !['image/webp', 'image/png', 'image/jpeg'].includes(file.type) || file.size > 2 * 1024 * 1024)) { text('Choose a WebP, PNG or JPEG image up to 2 MB.'); return; }
    busy = true; text(remove ? 'Removing photo…' : 'Saving photo…');
    var work = remove ? ref.delete().then(function(){ return doc.delete(); }) : ref.put(file, { contentType: file.type }).then(function(){ return doc.set({ path: path, updatedBy: user.email.toLowerCase(), updatedAt: Date.now() }); });
    work.then(function(){ busy = false; panel = null; refresh(); }).catch(function(e){ busy = false; text(e.message || 'Could not save the photo.'); });
  }
  BOLD.onUser(function(u){ user = u; if (!u) { body.hidden = true; text('Sign in to view the rota.'); return; } refresh(); });
})();
