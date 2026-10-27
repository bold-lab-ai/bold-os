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
  el('repoEntry').innerHTML = repoEntryHtml();
  wireRepoEntry();

  form.addEventListener('submit', function(e){
    e.preventDefault();
    if (!me || !me.email || !db) return showError('Could not connect — reload, or check back shortly.');
    var title = el('pfTitle').value.trim();
    var abstractText = el('stageAbstractText').value.trim();
    if (!title) return showError('Give the project a title.');
    if (!abstractText) return showError('Add an abstract or pitch.');
    var channel = normalizeProjectChannel(channelInput.value);
    if (channel.error) return showError(channel.error);
    var meeting = readMeetingEntry();
    if (meeting.error) return showError(meeting.error);
    var repo = readRepoEntry();
    if (repo.error) return showError(repo.error);
    keywordField.addTyped();
    errorBox.hidden = true;
    // Each can be left out, and done later from the project's page (its workspace's `skipped`).
    var channelEffects = channelField.effects(channel.name);
    BOLD.confirmAction({ title: 'Register \u201c' + title + '\u201d?', go: 'Register', effects: channelEffects.map(function(t){ return { key: 'channel', text: t }; }).concat([
      { key: 'announce', text: 'Announce it in #all-active-projects on Slack' },
      { key: 'meeting', text: 'Make its meeting on Google Calendar, ' + meetingText(meeting) + ', ' + meetVia(meeting) + ' (Google emails you the invitation)' },
      { key: 'docs', text: 'Make its slides and notes on Google Drive' },
      repo && repo.template ? { key: 'repo', text: 'Make its GitHub repository in bold-lab-ai, from the ' + repo.template + ' template' }
        : repo && repo.name ? { key: 'repo', text: 'Link bold-lab-ai/' + repo.name.replace(/^.*\//, '') + ' and give the project\u2019s people with GitHub write access to it' } : null].filter(Boolean)) }).then(function(ok){
      if (ok) register(title, abstractText, channel, meeting, repo, ok.skip || {}, channelEffects.length > 0);
    });
  });

  function register(title, abstractText, channel, meeting, repo, skip, makesChannel){
    submitBtn.disabled = true;
    var ensure = skip.channel && makesChannel ? Promise.resolve(null) : channelField.ensure(channel.name);
    ensure.then(function(r){
      // A project is a card (card-model.js) \u2014 the same one "+ Register paper" makes.
      // It's kept in `projects` until a venue is set (Projects page).
      var card = makeRegisteredCard({ name: me.displayName, email: me.email }, {
        title: title, abstractText: abstractText, keywords: keywordField.get(), slackChannel: r ? '#' + r.name : ''
      });
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
      location.href = 'projects.html#planned';
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
