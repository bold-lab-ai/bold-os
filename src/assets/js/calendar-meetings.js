// Reusable form, also exercised by the offline preview. All access decisions are server-side.
(function(){
  window.BoldCalendarMeetings = function(options){
    var esc = BOLD.escapeHtml, directory = [], projects = [], model, details, pending, busy = false, error = '', message = '', generation = 0;
    async function call(data){ var g = generation; var r = await options.call(data); if (g !== generation) throw new Error('Dialog closed.'); return r; }
    var dialog = document.createElement('dialog');
    dialog.className = 'cs-dialog'; dialog.setAttribute('aria-labelledby', 'csTitle');
    document.body.appendChild(dialog);
    function people(ids){ return ids.map(function(id){ return directory.filter(function(p){ return p.id === id; })[0] || { id: id, name: id }; }); }
    function names(ids){ return people(ids).map(function(p){ return p.name; }).join(', ') || 'None'; }
    function notice(s){ return s.mode === 'create' ? '<p class="cs-notice">BOLD.OS manages this recurring Google Calendar meeting and its Meet link.</p>' : ''; }
    function projectLink(s){ return s.projectId ? '<p class="cs-hint">Project: <a href="project.html#id=' + encodeURIComponent(s.projectId) + (s.projectBoard ? '&amp;board=' + encodeURIComponent(s.projectBoard) : '') + '">' + esc(s.projectTitle || s.projectId) + '</a></p>' : ''; }
    async function confirmGoogle(s, operation){
      var removing = operation === 'remove', previous = details && details.inviteGuests;
      var effects = [removing ? 'Delete this recurring meeting from the lab’s Google Calendar and remove its BOLD.OS entry.' : (s.version ? 'Update' : 'Create') + ' a recurring meeting on the lab’s Google Calendar with a Google Meet link.'];
      if (removing) effects.push('Google sends cancellations to anyone already invited.');
      else {
        effects.push(s.inviteGuests ? 'Invite the selected participants: ' + names(s.participantIds) + '. Their Google invitations include the meeting link, even for people outside the Slack channel.' : 'Create or keep the meeting without participant invitations.');
        if (s.version || operation === 'retry') effects.push('Google sends updates or cancellations to previously invited guests when the schedule or guest list changes.');
        if (previous && !s.inviteGuests) effects.push('Turning invitations off removes all previously invited guests.');
      }
      return BOLD.confirmAlways({ title: removing ? 'Delete this meeting?' : operation === 'retry' ? 'Retry Google Calendar update?' : s.version ? 'Update this meeting?' : 'Create this meeting?', go: removing ? 'Delete meeting' : 'Confirm', effects: effects });
    }
    function info(key, label, text){
      return '<span class="cs-help"><button type="button" class="cs-info" name="help-' + key + '" aria-label="About ' + esc(label) + '" aria-describedby="cs-help-' + key + '" aria-controls="cs-help-' + key + '" aria-expanded="false"><span aria-hidden="true">i</span></button><span class="cs-tooltip" id="cs-help-' + key + '" role="tooltip" hidden>' + esc(text) + '</span></span>';
    }
    function labelRow(name, label, hint){ return '<div class="cs-label-row"><label for="cs-' + name + '">' + label + '</label>' + (hint ? info(name, label, hint) : '') + '</div>'; }
    function field(name, label, type, value, extra, hint){ return '<div class="cs-field">' + labelRow(name, label, hint) + '<input id="cs-' + name + '" name="' + name + '" type="' + type + '" value="' + esc(value || '') + '" ' + (extra || '') + '></div>'; }
    var visibilityHint = 'Title and schedule are visible to calendar viewers. Participants are visible to listed people and channel members. Only current Slack channel members can see the meeting link on BOLD.OS. Channel members with calendar editing access can edit this entry.';
    var openHelp = null, pinnedHelp = null;
    function hideHelp(){
      if (openHelp) { openHelp.querySelector('.cs-tooltip').hidden = true; openHelp.querySelector('button').setAttribute('aria-expanded', 'false'); }
      openHelp = null; pinnedHelp = null;
    }
    function positionHelp(){
      if (!openHelp) return;
      var button = openHelp.querySelector('button'), tip = openHelp.querySelector('.cs-tooltip');
      var r = button.getBoundingClientRect(), bounds = dialog.getBoundingClientRect();
      if (r.bottom < bounds.top || r.top > bounds.bottom) { hideHelp(); return; }
      tip.style.width = Math.min(300, bounds.width - 32) + 'px';
      tip.style.left = Math.max(bounds.left + 12, Math.min(r.left, bounds.right - tip.offsetWidth - 12)) + 'px';
      var top = r.bottom;
      if (top + tip.offsetHeight > bounds.bottom - 12) top = r.top - tip.offsetHeight;
      tip.style.top = Math.max(bounds.top + 12, top) + 'px';
    }
    function showHelp(help){
      if (openHelp !== help) hideHelp();
      openHelp = help; help.querySelector('.cs-tooltip').hidden = false;
      help.querySelector('button').setAttribute('aria-expanded', 'true'); positionHelp();
    }
    dialog.addEventListener('pointerover', function(e){ var h = e.target.closest('.cs-help'); if (h && (!pinnedHelp || pinnedHelp === h)) showHelp(h); });
    dialog.addEventListener('pointerout', function(e){ if (openHelp && !pinnedHelp && !openHelp.contains(e.relatedTarget) && !openHelp.contains(document.activeElement)) hideHelp(); });
    dialog.addEventListener('focusin', function(e){ var h = e.target.closest('.cs-help'); if (h) showHelp(h); else hideHelp(); });
    dialog.addEventListener('focusout', function(e){ if (openHelp && !openHelp.contains(e.relatedTarget)) hideHelp(); });
    dialog.addEventListener('keydown', function(e){ if (e.key === 'Escape' && openHelp) { e.preventDefault(); e.stopPropagation(); hideHelp(); } });
    dialog.addEventListener('scroll', positionHelp);
    window.addEventListener('resize', hideHelp);

    function selected(v, wanted){ return String(v) === String(wanted) ? ' selected' : ''; }
    function render(){
      hideHelp();
      var active = dialog.contains(document.activeElement) ? document.activeElement : null;
      var activeName = active && active.name, activeClass = active && Array.from(active.classList).find(function(c){ return c.indexOf('cs-') === 0; });
      var html = '<button type="button" class="btn-text cs-close" aria-label="Close">×</button><h2 id="csTitle" tabindex="-1">' + (model ? model.version ? 'Edit meeting' : 'Add meeting' : 'Meeting') + '</h2>';
      if (model) {
        html = '<div class="cs-heading">' + html + info('visibility', 'visibility and editing', visibilityHint) + '</div>';
        html += '<form id="csForm"><fieldset' + (busy ? ' disabled' : '') + '>' +
          '<div class="cs-grid"><div class="cs-field">' + labelRow('category', 'Category') + '<select id="cs-category" name="category">' + ['project', 'supervision', 'other'].map(function(k){ return '<option value="' + k + '"' + selected(model.category, k) + '>' + ({project:'Project meeting',supervision:'Supervision',other:'Other meeting'})[k] + '</option>'; }).join('') + '</select></div><div class="cs-field">' + labelRow('mode', 'Meeting link', (model.mode === 'create' ? 'BOLD.OS creates and manages a recurring Google Calendar meeting. A Google Meet link is generated when you save.' : 'Use the meeting link you already have.') + ' On BOLD.OS, only verified Slack channel members can see the link.' + (model.version ? ' Link creation mode cannot be changed for an existing entry.' : '')) + '<select id="cs-mode" name="mode"' + (model.version ? ' disabled title="Link creation mode is fixed for an existing entry."' : '') + '><option value="create"' + selected(model.mode, 'create') + '>Create a new Google Meet</option><option value="existing"' + selected(model.mode, 'existing') + '>Use an existing link</option></select></div></div>' +
          (model.category === 'project' ? '<div class="cs-field">' + labelRow('projectId', 'BOLD.OS project', 'Link this meeting to an existing project.') + '<select id="cs-projectId" name="projectId" required><option value="">Choose a project</option>' + projects.map(function(p){ return '<option value="' + esc(p.id) + '"' + selected(model.projectId, p.id) + '>' + esc(p.title + (p.venue ? ' · ' + p.venue : '')) + '</option>'; }).join('') + '</select></div>' : '') +
          field('title', 'Meeting title', 'text', model.title, 'required maxlength="120" placeholder="e.g. Joint supervision"') +
          '<div class="cs-channel">' + field('channel', 'Associated Slack channel', 'text', model.channel, 'required placeholder="Paste a channel link or ID"' + (model.version ? ' readonly' : ''), 'You and the BOLD.OS app must be members of this channel, including private channels.' + (model.version ? ' The associated channel cannot be changed after creation.' : '')) +
          '<button type="button" class="view-btn cs-verify">' + (model.verified ? 'Refresh from channel' : 'Check channel') + '</button></div>' +
          '<p class="cs-channel-status' + (model.verified ? ' is-verified' : '') + '" role="status">' + (model.verified ? '✓ #' + esc(model.channelName) + ' verified' : '') + '</p>' +
          (model.mode === 'existing' ? field('link', 'Existing meeting link', 'url', model.link, 'required placeholder="https://meet.google.com/…"') : '') +
          '<h3 class="cs-section-title">Schedule</h3><div class="cs-grid">' + field('firstDate', 'First meeting', 'date', model.firstDate, 'required') + field('time', 'Start time · London', 'time', model.time, 'required') +
          '<div class="cs-field">' + labelRow('minutes', 'Duration') + '<select id="cs-minutes" name="minutes">' + Array.from({ length: 16 }, function(_, i){ var m = (i + 1) * 15; return '<option value="' + m + '"' + selected(model.minutes, m) + '>' + m + ' minutes</option>'; }).join('') + '</select></div>' +
          '<div class="cs-field">' + labelRow('every', 'Repeat') + '<select id="cs-every" name="every">' + [1, 2, 3, 4].map(function(n){ return '<option value="' + n + '"' + selected(model.every, n) + '>' + (n === 1 ? 'Every week' : 'Every ' + n + ' weeks') + '</option>'; }).join('') + '</select></div>' +
          field('until', 'End date · optional', 'date', model.until, '') + '</div>' +
          '<div class="cs-people"><div class="cs-section-heading"><h3>Participants <span class="cs-count">' + model.participantIds.length + '</span></h3>' + info('participants', 'participants', 'Add BOLD.OS people manually or import channel members. Refresh the channel to update the list to current members in the channel.') + '</div>' +
          '<button type="button" class="view-btn cs-import"' + (!model.verified ? ' disabled' : '') + '>Import from channel</button>' +
          '<ul class="cs-selected">' + people(model.participantIds).map(function(p){ return '<li><span>' + esc(p.name) + '<small>' + (model.manualIds.indexOf(p.id) >= 0 ? 'Manually added' : 'From channel') + '</small></span><button type="button" class="btn-text cs-remove-person" data-person="' + esc(p.id) + '" aria-label="Remove ' + esc(p.name) + '">Remove</button></li>'; }).join('') + '</ul>' +
          '<label>Find a person<input type="search" class="cs-search" placeholder="Search BOLD.OS people" autocomplete="off"></label><ul class="cs-results"></ul></div>' +
          (pending ? '<section class="cs-refresh" aria-label="Review channel participants"><h3>Review channel participants</h3><p><strong>Add:</strong> ' + esc(names(pending.add)) + '</p><p><strong>Remove:</strong> ' + esc(names(pending.remove)) + '</p><p>' + pending.unmatched + (pending.unmatched === 1 ? ' channel member has no matching BOLD.OS account and is not imported.' : ' channel members have no matching BOLD.OS account and are not imported.') + ' Applying changes replaces the participant list with current channel members who have BOLD.OS accounts.</p><button type="button" class="view-btn cs-apply">Apply participant changes</button> <button type="button" class="btn-text cs-discard">Keep current list</button></section>' : '') +
          (model.mode === 'create' ? '<div class="cs-invitation-row"><label class="cs-check"><input name="inviteGuests" type="checkbox"' + (model.inviteGuests ? ' checked' : '') + '>Send Google Calendar invitations</label></div>' : '') +
          '<div class="cs-actions"><button type="submit" class="join-btn"' + (!model.verified || !!pending ? ' disabled' : '') + '>' + (busy ? 'Working…' : model.version ? 'Save changes' : 'Add to calendar') + '</button><button type="button" class="btn-text cs-close">Cancel</button></div></fieldset></form>';
      } else if (details) {
        html += '<h3>' + esc(details.title) + '</h3><p>' + esc(meetingText(details.meeting)) + '</p><p class="cs-hint">First meeting: ' + esc(details.firstDate) + '</p>' + notice(details) + projectLink(details);
        if (details.syncError) html += '<p class="cs-notice" role="alert">' + esc(details.syncError) + '</p>';
        if (details.syncing) html += '<p role="status">Google Calendar update in progress. Refresh access shortly.</p>';
        if (details.link) html += '<a class="join-btn cs-meeting-link" target="_blank" rel="noopener" href="' + esc(details.link) + '">Join meeting ↗</a><p class="cs-hint">#' + esc(details.channel.name) + ' · Link visible to verified channel members only</p>';
        else html += '<p class="cs-notice">' + esc(details.channelError || (details.channel && details.mode === 'create' ? 'The meeting link will appear when Google Calendar finishes creating it.' : 'The meeting link is only available to Slack channel members.')) + '</p>';
        if (details.people) html += '<h3>Participants</h3><ul class="cs-selected">' + details.people.map(function(p){ return '<li>' + esc(p.name) + '</li>'; }).join('') + '</ul>';
        html += '<div class="cs-actions"><button type="button" class="view-btn cs-retry"' + (busy ? ' disabled' : '') + '>Refresh access</button>' +
          '<button type="button" class="view-btn cs-edit"' + (!details.canEdit || details.syncing || busy ? ' disabled title="Current channel membership and calendar editing access are required; wait for any update to finish."' : '') + '>Edit meeting</button><button type="button" class="btn-text danger cs-delete"' + (!details.canEdit || details.syncing || busy ? ' disabled title="Channel membership and calendar editing access are required; wait for any update to finish."' : '') + '>' + (details.mode === 'create' ? 'Delete meeting' : 'Remove entry') + '</button>' +
          (details.canEdit && details.mode === 'create' && details.calendarState !== 'ready' ? '<button type="button" class="view-btn cs-sync"' + (details.syncing || busy ? ' disabled' : '') + '>Retry Google Calendar</button>' : '') + '</div>';
      } else html += '<p>Checking access…</p>';
      dialog.innerHTML = html + '<p class="cs-error" role="alert">' + esc(error) + '</p><p role="status">' + esc(message) + '</p>';
      if (dialog.open) {
        var focus = activeName ? dialog.querySelector('[name="' + activeName + '"]') : activeClass ? dialog.querySelector('.' + activeClass) : null;
        if (!focus || focus.disabled || focus.closest('fieldset[disabled]')) focus = dialog.querySelector('#csTitle');
        focus.focus({ preventScroll: true });
      }
    }
    function read(){
      if (!model) return;
      var form = dialog.querySelector('form'); if (!form) return;
      ['title', 'channel', 'link', 'firstDate', 'time', 'minutes', 'every', 'until', 'mode', 'category', 'projectId'].forEach(function(k){ if (form.elements[k]) model[k] = form.elements[k].value; });
      model.inviteGuests = !!(form.elements.inviteGuests && form.elements.inviteGuests.checked);
    }
    function mergeDirectory(list){ list.forEach(function(p){ if (!directory.some(function(q){ return q.id === p.id; })) directory.push(p); }); }
    async function directoryLoad(){ var r = await call({ action: 'directory' }); directory = r.people; var p = await call({ action: 'projects' }); projects = p.projects; }
    function show(){ if (!dialog.open) dialog.showModal(); }
    async function attempt(fn){
      var g = generation;
      read(); error = ''; message = ''; busy = true; render();
      try { await fn(); } catch (e) { if (g === generation) error = e.message || 'Could not complete that action. Please retry.'; }
      if (g === generation) { busy = false; render(); }
    }
    async function openNew(){
      generation++; model = { id: crypto.randomUUID(), mode: 'create', category: 'supervision', projectId: '', inviteGuests: false, title: '', channel: '', channelName: '', verified: false, link: '', firstDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date()), time: '15:00', minutes: 60, every: 1, until: '', participantIds: [], manualIds: [] };
      details = null; pending = null; error = ''; message = ''; render(); show(); await attempt(directoryLoad);
    }
    async function openDetails(id){
      var g = ++generation;
      model = null; details = null; pending = null; error = ''; message = ''; render(); show();
      try { var d = await call({ action: 'get', id: id }); if (g === generation) { details = d; render(); } }
      catch (e) { if (g === generation) { error = e.message; render(); } }
    }
    async function loadChannel(review){
      var r = await call({ action: 'channel', channel: model.channel });
      model.channel = r.channel.id; model.channelName = r.channel.name; model.verified = true; mergeDirectory(r.people);
      if (review) {
        var imported = r.people.map(function(p){ return p.id; });
        pending = { ids: imported, unmatched: r.unmatched,
          add: imported.filter(function(id){ return model.participantIds.indexOf(id) < 0; }),
          remove: model.participantIds.filter(function(id){ return imported.indexOf(id) < 0; }) };
      }
    }
    dialog.addEventListener('change', function(e){
      if (!model || ['mode', 'category', 'projectId'].indexOf(e.target.name) < 0) return;
      var previous = projects.find(function(p){ return p.id === model.projectId; });
      read();
      if (model.category === 'project') {
        var project = projects.find(function(p){ return p.id === model.projectId; });
        // Follow project changes until someone gives the meeting its own title.
        if (project && (!model.title.trim() || (previous && model.title === previous.title))) model.title = project.title;
      }
      render();
    });
    dialog.addEventListener('input', function(e){
      if (e.target.name === 'channel' && model && !model.version) {
        read(); model.verified = false; pending = null;
        dialog.querySelector('.cs-import').disabled = true; dialog.querySelector('[type="submit"]').disabled = true;
        dialog.querySelector('.cs-channel-status').textContent = 'Check this channel before saving.';
        dialog.querySelector('.cs-channel-status').classList.remove('is-verified');
      }
      if (e.target.classList.contains('cs-search')) {
        var q = e.target.value.trim().toLowerCase();
        dialog.querySelector('.cs-results').innerHTML = q ? directory.filter(function(p){ return p.name.toLowerCase().indexOf(q) >= 0 && model.participantIds.indexOf(p.id) < 0; }).slice(0, 20).map(function(p){ return '<li><button type="button" class="btn-text cs-add-person" data-person="' + esc(p.id) + '">+ ' + esc(p.name) + '</button></li>'; }).join('') || '<li>No matching people</li>' : '';
      }
    });
    dialog.addEventListener('click', function(e){
      var help = e.target.closest('.cs-help');
      if (help) {
        if (e.target.closest('.cs-info')) { if (pinnedHelp === help) hideHelp(); else { showHelp(help); pinnedHelp = help; } }
        return;
      }
      hideHelp();
      var b = e.target.closest('button'); if (!b || b.disabled) return;
      if (b.classList.contains('cs-close')) { generation++; dialog.close(); return; }
      if (busy) return;
      read(); var id = b.getAttribute('data-person');
      if (b.classList.contains('cs-add-person')) { model.participantIds.push(id); model.manualIds.push(id); render(); }
      if (b.classList.contains('cs-remove-person')) { model.participantIds = model.participantIds.filter(function(p){ return p !== id; }); model.manualIds = model.manualIds.filter(function(p){ return p !== id; }); render(); }
      if (b.classList.contains('cs-verify') || b.classList.contains('cs-import')) { var review = model.verified || b.classList.contains('cs-import'); attempt(function(){ return loadChannel(review); }); }
      if (b.classList.contains('cs-discard')) { pending = null; render(); }
      if (b.classList.contains('cs-apply')) { model.participantIds = Array.from(new Set(pending.ids)); model.manualIds = []; pending = null; render(); }
      if (b.classList.contains('cs-retry')) openDetails(details.id);
      if (b.classList.contains('cs-edit')) attempt(async function(){
        // Fetch access again when entering the editor; never trust a cached permission.
        var d = await call({ action: 'get', id: details.id });
        details = d;
        if (!d.canEdit) throw new Error('Current Slack channel membership and calendar editing access are required.');
        await directoryLoad();
        model = { mode: d.mode, category: d.category, projectId: d.projectId, inviteGuests: d.inviteGuests, id: d.id, version: d.version, title: d.title, firstDate: d.firstDate, time: d.meeting.time, minutes: d.meeting.minutes, every: d.meeting.every, until: d.meeting.until || '', link: d.link,
          channel: d.channel.id, channelName: d.channel.name, verified: true, participantIds: d.participantIds.slice(), manualIds: d.manualIds.slice() };
      });
      if (b.classList.contains('cs-delete') || b.classList.contains('cs-sync')) attempt(async function(){
        var d = details, action = b.classList.contains('cs-delete') ? 'remove' : 'retry';
        if (d.mode === 'create') {
          mergeDirectory(d.people || []);
          if (!await confirmGoogle(d, action === 'retry' && d.pendingOperation === 'remove' ? 'remove' : action)) return;
        } else if (!await BOLD.confirmAlways({ title: 'Remove this calendar entry?', go: 'Remove entry', effects: ['Remove this entry from BOLD.OS. Its original calendar invitation stays unchanged.'] })) return;
        var r = await call({ action: action, id: d.id, version: d.version, confirmed: true }); options.changed();
        if (r.removed) { dialog.close(); return; }
        details = await call({ action: 'get', id: d.id });
      });
    });
    dialog.addEventListener('submit', function(e){
      e.preventDefault(); if (!model || busy) return;
      attempt(async function(){
        if (model.mode === 'create' && !await confirmGoogle(model, 'save')) return;
        var payload = { action: 'save', confirmed: model.mode === 'create' };
        ['id', 'version', 'title', 'channel', 'link', 'firstDate', 'time', 'minutes', 'every', 'until', 'participantIds', 'manualIds', 'mode', 'category', 'projectId', 'inviteGuests'].forEach(function(k){ if (model[k] !== undefined) payload[k] = model[k]; });
        var r = await call(payload); options.changed();
        model = null; details = r;
        message = r.existing ? 'This meeting is already on the calendar.' : r.calendarState === 'error' ? 'Entry saved. Google Calendar needs attention below.' : r.mode === 'create' ? 'Meeting saved.' : 'Saved to BOLD.OS. The original invitation is unchanged.';
        details = await call({ action: 'get', id: r.id });
      });
    });
    dialog.addEventListener('cancel', function(){ generation++; });
    dialog.addEventListener('close', function(){ hideHelp(); model = null; details = null; pending = null; dialog.innerHTML = ''; });
    return { openNew: openNew, openDetails: openDetails, close: function(){ generation++; dialog.close(); } };
  };
})();
