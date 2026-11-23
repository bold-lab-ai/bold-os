(function(){
  // The masthead, gate and sidebar are bold.js's; this page is just the form.
  if (!BOLD.getAuth()) return;

  var el = function(id){ return document.getElementById(id); };
  var form = el('projectForm'), errorBox = el('projectError'), submitBtn = el('submitBtn');
  var me, lastProposal;
  function registry(data){
    return firebase.app().functions('europe-west2').httpsCallable('benchmarkRegistry')(data).then(function(r){return r.data;});
  }
  var verifier = BoldProjectVerifiers.mount(function(cursor){ return registry({action:'benchmark_catalogue',cursor:cursor}); });
  function syncProblem(){
    var option = el('pfProblem').selectedOptions[0];
    verifier.selectProblem(option ? option.value : '', !!(option && option.dataset.buildsBenchmark === 'true'));
  }
  el('pfProblem').addEventListener('change', syncProblem);
  var problemGeneration = 0, returningFromBank = false;
  async function loadProblems(){
    var generation = ++problemGeneration, select = el('pfProblem'), status = el('pfProblemStatus');
    select.disabled = true;
    if (!me) {
      select.replaceChildren(new Option('Choose an open problem', ''));
      status.textContent = 'Sign in to choose a problem.';
      return false;
    }
    status.textContent = 'Loading open problems…';
    try {
      var result = await registry({action:'open_choices'});
      if (generation !== problemGeneration) return false;
      var previous = select.value;
      select.replaceChildren(new Option('Choose an open problem', ''));
      result.items.forEach(function(p){
        var option = new Option(p.title, p.id);
        if (p.builds_benchmark) option.dataset.buildsBenchmark = 'true';
        select.add(option);
      });
      select.value = previous;
      if (!select.value) select.selectedIndex = 0;
      syncProblem();
      select.disabled = !result.items.length;
      status.textContent = select.disabled ? 'Add an open problem before proposing a project.' :
        previous && !select.value ? 'The selected problem is no longer open. Choose another problem.' : '';
      return true;
    } catch (e) {
      if (generation === problemGeneration) status.textContent = 'Could not load open problems. Refresh to try again.';
      return false;
    }
  }
  el('refreshProblems').onclick = loadProblems;
  el('pfProblemBank').addEventListener('click', function(){ returningFromBank = true; });
  window.addEventListener('storage', function(event){
    if (event.key === 'boldOpenProblemsChanged' && me) {
      returningFromBank = false;
      loadProblems();
    }
  });
  window.addEventListener('focus', function(){
    if (returningFromBank) { returningFromBank = false; loadProblems(); }
  });
  BOLD.onUser(function(user){
    if (!me || !user || me.uid !== user.uid) { verifier.reset(!!user); lastProposal = null; el('pfProblem').value = ''; }
    me = user; loadProblems();
  });

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

  // Its compute (2026-11-19): within the BOLDiquette's standard allowance, or more (then its GPU hours).
  // BOLD-internal and above: within it, approved at once; more, PIs and admins have 7 days to decide, then
  // it's approved by itself. Below BOLD-internal: a PI or admin always approves it.
  var INTERNAL = ['internal', 'staff', 'exec'];
  var internal = function(){ return INTERNAL.indexOf(BOLD.myGroup && BOLD.myGroup()) >= 0; };
  function moreHint(){
    var more = el('pfMore').checked;
    el('pfHoursField').hidden = !more;
    el('pfMoreHint').textContent = !internal() ? 'A PI or admin approves it either way.'
      : more ? 'PIs and admins have 7 days to approve or decline it; after that, it\u2019s approved by itself.'
      : 'It\u2019s approved at once.';
  }
  el('pfMore').addEventListener('change', moreHint);
  BOLD.onAccess(moreHint);
  moreHint();

  form.addEventListener('submit', function(e){
    e.preventDefault();
    if (!me || !me.email) return showError('Sign in to propose a project.');
    var submitter = me.uid;
    var title = el('pfTitle').value.trim();
    var abstractText = el('stageAbstractText').value.trim();
    var problem=el('pfProblem').value;
    if(el('pfProblem').disabled || !problem){el('pfProblem').focus();return showError('Choose an open problem for this project.');}
    if (!title) return showError('Give the project a title.');
    if (!abstractText) return showError('Add an abstract or pitch.');
    var decision = verifier.read();
    if (decision.error){ el(decision.field).focus(); return showError(decision.error); }
    // More than the standard allowance: a whole number of GPU hours, more than none.
    var more = el('pfMore').checked, gpuHours = 0;
    if (more) {
      gpuHours = Math.round(Number(String(el('pfGpuHours').value).replace(/[,\s]/g, '')));
      if (!isFinite(gpuHours) || gpuHours <= 0) return showError('Give the GPU hours it needs.');
      if (gpuHours > 10000000) return showError('That\u2019s more GPU hours than BOLD has.');
    }
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
    // Approved at once, or once a PI or admin approves it (or 7 days pass): the rest happens then.
    var now = internal() && !more, asks = more ? gpuHours.toLocaleString('en-GB') + ' GPU hours' : 'the standard compute allowance';
    var later = function(t){ return now ? t : 'Once approved: ' + t.charAt(0).toLowerCase() + t.slice(1); };
    var first = now ? 'Register it, with the standard compute allowance: it\u2019s approved at once'
      : internal() ? 'Send it to the PIs and admins, asking for ' + asks + ': approved by itself if nobody decides within 7 days'
      : 'Send it to the PIs and admins to approve, asking for ' + asks;
    var plan = decision.plan;
    var verifierSummary = plan.mode === 'linked'
      ? 'Link ' + plan.releaseIds.length + (plan.releaseIds.length === 1 ? ' verifier release' : ' verifier releases') + ' to this project'
      : plan.mode === 'benchmark' ? 'Record that this project is building a benchmark and needs no separate verifier'
      : 'Record the reason for deferral and the expected verifier onboarding time (' + plan.expectedOnboarding + ')';
    BOLD.confirmAlways({ title: (now ? 'Register' : 'Propose') + ' \u201c' + title + '\u201d?', go: now ? 'Register' : 'Propose', effects: [{ text: first }, {text:verifierSummary}].concat(channelEffects.map(function(t){ return { key: 'channel', text: later(t) }; })).concat([
      { key: 'announce', text: later('Announce it in #all-active-projects on Slack') },
      meeting ? { key: 'meeting', text: later('Make its meeting on Google Calendar, ' + meetingText(meeting) + ', ' + meetVia(meeting) + ' (Google emails you the invitation)') } : null,
      { key: 'docs', text: later('Make its slides and notes on Google Drive') },
      repo && repo.template ? { key: 'repo', text: later('Make its GitHub repository in bold-lab-ai, from the ' + repo.template + ' template') }
        : repo && repo.name ? { key: 'repo', text: later('Link bold-lab-ai/' + repo.name.replace(/^.*\//, '') + ' and give the project\u2019s people with GitHub write access to it') } : null].filter(Boolean)) }).then(function(ok){
      if (!ok || !me || me.uid !== submitter) return;
      var skip = ok.skip || {};
      if (noChannel) skip.channel = true;
      if (noMeeting) skip.meeting = true;
      if (!repo) skip.repo = true;
      register(title, abstractText, channel, meeting, repo, skip, more, gpuHours, problem, plan);
    });
  });

  function register(title, abstractText, channel, meeting, repo, skip, more, gpuHours, problem, plan){
    submitBtn.disabled = true;
    var keywords = keywordField.get();
    var key = JSON.stringify([me.uid, title, abstractText, keywords, channel.name, meeting, repo, skip, more, gpuHours, problem, plan]);
    // Its channel is made (or linked) once it's approved (projectProposal), under this name.
    Promise.resolve(null).then(function(){
      // A project is a card (card-model.js) \u2014 the same one "+ Register paper" makes.
      // It's kept in `projects` until a venue is set (Projects page).
      var card = makeRegisteredCard({ name: me.displayName, email: me.email }, {
        title: title, abstractText: abstractText, keywords: keywords, slackChannel: ''
      });
      card.openProblemId=problem;
      card.verificationPlan=plan;
      card.setUpChannel = channel.name && !skip.channel ? '#' + channel.name : '';
      card.proposal = { status: 'proposed', more: more, at: Date.now(), by: me.email };
      if (more) card.proposal.gpuHours = gpuHours;
      // The server sets up the meeting, slides, notes and repository from these (onProjectWritten),
      // leaving out what was unticked, and records it.
      card.setUpMeeting = skip.meeting ? null : meeting;
      card.setUpRepo = skip.repo ? null : repo;
      card.setUpDocs = !skip.docs;
      card.announce = !skip.announce;
      card.setUpSkipped = Object.keys(skip);
      var id = card.id; delete card.id;
      // Keep the same request after a lost reply. A change to the form starts a new proposal.
      if (!lastProposal || lastProposal.key !== key) lastProposal = {key:key,id:id,card:card};
      return registry({action:'create_project_proposal', project_id:lastProposal.id, card:lastProposal.card}).then(function(result){ return result.project_id; });
    }).then(function(id){
      // Drop the projects page's cached list so the new project shows at once.
      try { localStorage.removeItem('boldProjects:getAllProjects:' + me.email.toLowerCase()); } catch (err){}
      // Approved at once (BOLD-internal, the standard allowance): its own page, being set up; else the proposed ones.
      location.href = internal() && !more ? 'project.html#id=' + encodeURIComponent(id) : 'projects.html#proposed';
    }).catch(async function(err){
      console.error('[BOLD Lab] register project failed', err);
      channelField.refresh();
      var code = err && err.code;
      var recovery = '';
      if (code === 'functions/failed-precondition') {
        var updated = await Promise.all([loadProblems(), plan.mode === 'linked' ? verifier.refresh() : null]);
        recovery = updated[1];
        if (updated[0] && !Array.from(el('pfProblem').options).some(function(option){ return option.value === problem; })) {
          recovery = 'The selected problem is no longer open. Choose another problem.';
        }
      }
      submitBtn.disabled = false;
      if (recovery) return showError(recovery);
      showError(code === 'functions/permission-denied'
        ? 'You don\u2019t have permission to do that \u2014 check with a PI or lab admin.'
        : (code === 'functions/failed-precondition' || code === 'functions/invalid-argument') && err.message
          ? err.message
          : 'Could not register the project \u2014 try again.');
    });
  }
})();
