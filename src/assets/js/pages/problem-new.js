(function(){
  'use strict';
  var el = function(id){ return document.getElementById(id); };
  var form = el('pbCreate'), fields = el('pbInputs'), status = el('pbStatus');
  var userId = null, epoch = 0, canWrite = false, ready = false, projects = [], busy = false, submission = null;
  var familySelection = null, familyGraph = null;
  // The conversation with BOLD-LLM (problemInterview): it asks, and fills in the draft (this form) as it goes.
  var OPENING = 'Describe the problem you\u2019d like to add: what you want to solve, and why it matters to you.';
  var turns = [], talking = false;
  function call(data){ return firebase.app().functions('europe-west2').httpsCallable('benchmarkRegistry')(data).then(function(r){ return r.data; }); }
  function controls(){
    fields.disabled = !canWrite || !ready || busy;
    fields.title = canWrite ? '' : BOLD.cannotReason('projects', 'edit');
  }
  var purpose = el('pbBuildsBenchmark');
  function showSteps(){
    el('pbVerifierStep').textContent = purpose.checked ? 'Verifier not required' : 'Add a verifier';
    el('pbBaselineStep').hidden = purpose.checked;
  }
  purpose.addEventListener('change', showSteps);
  BOLD.onAccess(function(){ canWrite = BOLD.can('projects', 'edit'); controls(); if (window.BoldMarkdown) chatControls(); });
  function loadFamily(generation){
    var feedback = el('pbFamilyStatus'), retry = el('pbFamilyRetry');
    retry.hidden = true; feedback.textContent = 'Loading family links…';
    call({action:'family'}).then(function(graph){
      if (generation !== epoch) return;
      familyGraph = graph;
      familySelection = BoldProblemFamily.picker(el('pbFamily'), graph, null);
      feedback.textContent = '';
    }).catch(function(){
      if (generation !== epoch) return;
      feedback.textContent = 'Family links could not load. You can add them later. '; retry.hidden = false;
    });
  }
  el('pbFamilyRetry').onclick = function(){ if (userId) loadFamily(epoch); };
  /* ---------- the conversation ---------- */
  function say(role, text, pending){
    var d = document.createElement('div');
    d.className = 'pb-chat-msg ' + (role === 'user' ? 'from-me' : 'from-llm') + (pending ? ' pending' : '');
    if (role === 'user' || pending) d.textContent = text;
    else d.innerHTML = BoldMarkdown.render(text);
    el('pbChatLog').append(d);
    return d;
  }
  function chatControls(){
    var on = !!userId && canWrite && ready && !talking;
    el('pbChatInput').disabled = el('pbChatSend').disabled = !on;
    el('pbChatInput').title = canWrite ? '' : BOLD.cannotReason('projects', 'edit');
    el('pbChatRestart').hidden = turns.length < 2;
  }
  function startChat(){
    turns = [{ role: 'assistant', content: OPENING }];
    el('pbChatLog').replaceChildren(); say('assistant', OPENING); chatControls();
  }
  function showDraft(){ form.hidden = false; }
  // The draft as it stands on the page, sent with each turn so BOLD-LLM keeps what the person edited.
  function currentDraft(){
    var family = familySelection ? familySelection() : { parents: [], related: [] };
    return { title: el('pbTitle').value.trim(), significance: el('pbWhy').value.trim(), difficulties: el('pbDifficulties').value.trim(),
      existing_solutions: el('pbExisting').value.trim(), builds_benchmark: purpose.checked, collaborators: el('pbCollaborators').value.trim(),
      project_ids: BoldProblemProjects.selected(el('pbProjects'), projects).map(function(p){ return p.id; }),
      parent_ids: family.parents, related_ids: family.related };
  }
  function fill(id, value){
    var box = el(id);
    if (box.value === value) return;
    box.value = value; box.classList.remove('pb-filled'); void box.offsetWidth; box.classList.add('pb-filled');
  }
  function applyDraft(d){
    fill('pbTitle', d.title); fill('pbWhy', d.significance); fill('pbDifficulties', d.difficulties);
    fill('pbExisting', d.existing_solutions); fill('pbCollaborators', d.collaborators);
    if (purpose.checked !== d.builds_benchmark) { purpose.checked = d.builds_benchmark; showSteps(); }
    var chosen = projects.filter(function(p){ return d.project_ids.indexOf(p.id) >= 0; });
    el('pbProjects').innerHTML = BoldProblemProjects.fields(projects, chosen) || 'No projects yet.';
    if (chosen.length) el('pbProjects').closest('details').open = true;
    if (familyGraph) familySelection = BoldProblemFamily.picker(el('pbFamily'), familyGraph, null, { parents: d.parent_ids, related: d.related_ids });
    if (d.title || d.significance || d.difficulties || d.existing_solutions) showDraft();
  }
  el('pbChatForm').addEventListener('submit', async function(event){
    event.preventDefault();
    var input = el('pbChatInput'), text = input.value.trim();
    if (!text || talking || !userId) return;
    var generation = epoch;
    turns.push({ role: 'user', content: text }); say('user', text); input.value = '';
    talking = true; chatControls();
    var wait = say('assistant', 'Thinking\u2026', true);
    try {
      var r = await firebase.app().functions('europe-west2').httpsCallable('problemInterview')({ turns: turns, draft: currentDraft() });
      if (generation !== epoch) return;
      wait.remove();
      turns.push({ role: 'assistant', content: r.data.reply }); say('assistant', r.data.reply);
      applyDraft(r.data.draft);
      if (r.data.ready) el('pbSave').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e){
      if (generation !== epoch) return;
      wait.remove(); turns.pop();
      say('assistant', (e && e.message) || 'BOLD-LLM didn\u2019t answer. Try again, or fill in the form yourself.', true);
      input.value = text;
    } finally {
      if (generation === epoch) { talking = false; chatControls(); input.focus(); }
    }
  });
  el('pbChatInput').addEventListener('keydown', function(e){
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); el('pbChatForm').requestSubmit(); }
  });
  el('pbChatRestart').onclick = function(){ if (!talking) startChat(); };
  el('pbManual').onclick = function(){ showDraft(); el('pbTitle').focus(); };

  BOLD.onUser(function(user){
    var generation = ++epoch;
    userId = user && user.uid; ready = false; projects = []; submission = null; busy = false; form.reset(); controls();
    showSteps();
    el('pbProjects').replaceChildren();
    familySelection = null; familyGraph = null; form.hidden = true; talking = false; startChat(); el('pbFamily').replaceChildren(); el('pbFamilyStatus').textContent = ''; el('pbFamilyRetry').hidden = true;
    if (!user) { status.textContent = 'Sign in to add a problem.'; return; }
    loadFamily(generation);
    Promise.all([call({ action:'projects' }), BoldPeopleSelect.load()]).then(function(results){
      if (epoch !== generation) return;
      projects = results[0].items;
      el('pbProjects').innerHTML = BoldProblemProjects.fields(projects,[]) || 'No projects yet.';
      var matches = results[1].filter(function(p){return p.name === user.displayName;});
      el('pbDefiner').innerHTML = BoldPeopleSelect.options(results[1],matches.length === 1 ? matches[0].id : null,'Choose a person');
      ready = true; status.textContent = '';
      controls(); chatControls();
    }).catch(function(e){ if (epoch === generation) status.textContent = e.message; });
  });
  form.addEventListener('submit', async function(event){
    event.preventDefault();
    if (!userId || fields.disabled || !form.reportValidity()) return;
    var generation = epoch;
    var data = { action:'create', builds_benchmark:purpose.checked, projects:BoldProblemProjects.selected(el('pbProjects'),projects),
      title:el('pbTitle').value.trim(), owner_id:el('pbDefiner').value, collaborators:el('pbCollaborators').value.trim(),
      significance:el('pbWhy').value.trim(), difficulties:el('pbDifficulties').value.trim(), existing_solutions:el('pbExisting').value.trim() };
    if (familySelection) {
      var family = familySelection();
      if (family.parents.length || family.related.length) data.family = family;
    }
    busy = true; controls();
    try {
      var choice = await BOLD.confirmAction({ title: 'Save this open problem?', go: 'Save problem', always: true,
        effects: data.builds_benchmark ? ['Save this as a benchmark-building problem. No separate verifier is required.'] :
          [{ key: 'reminders', text: 'Remind me on Slack now and every week until this problem has a registered verifier. My notification settings apply.' }] });
      if (!choice || generation !== epoch) return;
      data.reminders = !data.builds_benchmark && !choice.skip.reminders;
      var signature = JSON.stringify(data);
      if (!submission || submission.signature !== signature) submission = { signature: signature, id: crypto.randomUUID() };
      status.textContent = 'Saving…';
      var result = await call(Object.assign(data, { request_id: submission.id }));
      if (generation === epoch) {
        // Let an open project proposal reload its choices. Keep the problem data out of browser storage.
        try { localStorage.setItem('boldOpenProblemsChanged', submission.id); } catch (ignored) {}
        location.assign('problem.html?problem=' + encodeURIComponent(result.problem_id));
      }
    } catch (e){ if (generation === epoch) status.textContent = e.message || 'Could not save. Try again.'; }
    finally { if (generation === epoch) { busy = false; controls(); } }
  });
})();
