(function(){
  // The masthead, gate and sidebar are bold.js's; this page is just the form.
  if (!BOLD.getAuth()) return;

  var el = function(id){ return document.getElementById(id); };
  var form = el('projectForm'), errorBox = el('projectError'), submitBtn = el('submitBtn');
  var me;
  BOLD.onUser(function(user){ me = user; });

  var db = null;
  try { db = firebase.firestore(BOLD.getApp()); } catch (e){}

  // The board's own abstract field (counter, LaTeX preview) — see card-model.js.
  el('abstractField').innerHTML = abstractTextFieldHtml('', '');
  wireAbstractPreview();

  function showError(msg){ errorBox.textContent = msg; errorBox.hidden = false; }

  /* ---------- keywords and the Slack channel: project-fields.js ---------- */
  el('keywordEntry').innerHTML = keywordEntryHtml();
  el('channelEntry').innerHTML = channelEntryHtml('');
  var keywordField = wireKeywordField([], showError, function(){ errorBox.hidden = true; });
  var channelField = wireChannelField('submit');
  var channelInput = el('pfChannel');
  el('meetingEntry').innerHTML = meetingEntryHtml();
  el('repoEntry').innerHTML = repoEntryHtml(true);
  wireRepoEntry();

  form.addEventListener('submit', function(e){
    e.preventDefault();
    if (!me || !me.email || !db) return showError('Could not connect — reload, or check back shortly.');
    var title = el('pfTitle').value.trim();
    var abstractText = el('stageAbstractText').value.trim();
    if (!title) return showError('Give the project a title.');
    if (!abstractText) return showError('Add an abstract or pitch.');
    // Its compute budget (#226): a whole number of GPU hours, more than none.
    var gpuHours = Math.round(Number(String(el('pfGpuHours').value).replace(/[,\s]/g, '')));
    if (!isFinite(gpuHours) || gpuHours <= 0) return showError('Give its compute budget, in GPU hours.');
    if (gpuHours > 10000000) return showError('That\u2019s more GPU hours than BOLD has.');
    // A project led elsewhere may have its channel in another Slack and its meetings
    // organised by another group: left empty, BOLD.OS makes neither (#169).
    var noChannel = !channelInput.value.trim(), noMeeting = !el('pmTime').value;
    var channel = noChannel ? { name: '' } : normalizeProjectChannel(channelInput.value);
    if (channel.error) return showError(channel.error);
    var meeting = noMeeting ? null : readMeetingEntry();
    if (meeting && meeting.error) return showError(meeting.error);
    var repo = readRepoEntry();
    if (repo && repo.error) return showError(repo.error);
    keywordField.addTyped();
    errorBox.hidden = true;
    // Each can be left out, and done later from the project's page (its workspace's `skipped`).
    var channelEffects = noChannel ? [] : channelField.effects(channel.name);
    // Proposed (#226): the rest happens once a PI or admin approves it.
    var later = function(t){ return 'Once approved: ' + t.charAt(0).toLowerCase() + t.slice(1); };
    BOLD.confirmAlways({ title: 'Propose \u201c' + title + '\u201d?', go: 'Propose', effects: [{ text: 'Send it to the PIs and admins to approve, with its budget of ' + gpuHours.toLocaleString('en-GB') + ' GPU hours' }].concat(channelEffects.map(function(t){ return { key: 'channel', text: later(t) }; })).concat([
      { key: 'announce', text: later('Announce it in #all-active-projects on Slack') },
      meeting ? { key: 'meeting', text: later('Make its meeting on Google Calendar, ' + meetingText(meeting) + ', ' + meetVia(meeting) + ' (Google emails you the invitation)') } : null,
      { key: 'docs', text: later('Make its slides and notes on Google Drive') },
      repo && repo.template ? { key: 'repo', text: later('Make its GitHub repository in bold-lab-ai, from the ' + repo.template + ' template') }
        : repo && repo.name ? { key: 'repo', text: later('Link bold-lab-ai/' + repo.name.replace(/^.*\//, '') + ' and give the project\u2019s people with GitHub write access to it') } : null].filter(Boolean)) }).then(function(ok){
      if (!ok) return;
      var skip = ok.skip || {};
      if (noChannel) skip.channel = true;
      if (noMeeting) skip.meeting = true;
      if (!repo) skip.repo = true;
      register(title, abstractText, channel, meeting, repo, skip, gpuHours);
    });
  });

  function register(title, abstractText, channel, meeting, repo, skip, gpuHours){
    submitBtn.disabled = true;
    // Its channel is made (or linked) once it's approved (projectProposal), under this name.
    Promise.resolve(null).then(function(){
      // A project is a card (card-model.js) \u2014 the same one "+ Register paper" makes.
      // It's kept in `projects` until a venue is set (Projects page).
      var card = makeRegisteredCard({ name: me.displayName, email: me.email }, {
        title: title, abstractText: abstractText, keywords: keywordField.get(), slackChannel: ''
      });
      card.setUpChannel = channel.name && !skip.channel ? '#' + channel.name : '';
      card.proposal = { status: 'proposed', gpuHours: gpuHours, at: Date.now(), by: me.email };
      // The server sets up the meeting, slides, notes and repository from these (onProjectWritten),
      // leaving out what was unticked, and records it.
      card.setUpMeeting = skip.meeting ? null : meeting;
      card.setUpRepo = skip.repo ? null : repo;
      card.setUpDocs = !skip.docs;
      card.announce = !skip.announce;
      card.setUpSkipped = Object.keys(skip);
      var id = card.id; delete card.id; // the id is the document's, as in the board's saveBoard()
      var ref = db.collection('projects').doc(id);
      return ref.set(card);
    }).then(function(){
      // Drop the projects page's cached list so the new project shows at once.
      try { localStorage.removeItem('boldProjects:getAllProjects:' + me.email.toLowerCase()); } catch (err){}
      location.href = 'projects.html#proposed';
    }).catch(function(err){
      console.error('[BOLD Lab] register project failed', err);
      submitBtn.disabled = false;
      channelField.refresh();
      var code = err && err.code;
      showError(code === 'permission-denied'
        ? 'You don\u2019t have permission to do that \u2014 check with a PI or lab admin.'
        : (code === 'functions/failed-precondition' || code === 'functions/invalid-argument') && err.message
          ? err.message
          : 'Could not register the project \u2014 try again.');
    });
  }
})();
