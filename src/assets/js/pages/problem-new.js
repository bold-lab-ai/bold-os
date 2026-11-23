(function(){
  'use strict';
  var el = function(id){ return document.getElementById(id); };
  var form = el('pbCreate'), fields = el('pbInputs'), status = el('pbStatus');
  var userId = null, epoch = 0, canWrite = false, ready = false, projects = [], busy = false, submission = null;
  var familySelection = null;
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
  BOLD.onAccess(function(){ canWrite = BOLD.can('projects', 'edit'); controls(); });
  function loadFamily(generation){
    var feedback = el('pbFamilyStatus'), retry = el('pbFamilyRetry');
    retry.hidden = true; feedback.textContent = 'Loading family links…';
    call({action:'family'}).then(function(graph){
      if (generation !== epoch) return;
      familySelection = BoldProblemFamily.picker(el('pbFamily'), graph, null);
      feedback.textContent = '';
    }).catch(function(){
      if (generation !== epoch) return;
      feedback.textContent = 'Family links could not load. You can add them later. '; retry.hidden = false;
    });
  }
  el('pbFamilyRetry').onclick = function(){ if (userId) loadFamily(epoch); };
  BOLD.onUser(function(user){
    var generation = ++epoch;
    userId = user && user.uid; ready = false; projects = []; submission = null; busy = false; form.reset(); controls();
    showSteps();
    el('pbProjects').replaceChildren();
    familySelection = null; el('pbFamily').replaceChildren(); el('pbFamilyStatus').textContent = ''; el('pbFamilyRetry').hidden = true;
    if (!user) { status.textContent = 'Sign in to add a problem.'; return; }
    loadFamily(generation);
    Promise.all([call({ action:'projects' }), BoldPeopleSelect.load()]).then(function(results){
      if (epoch !== generation) return;
      projects = results[0].items;
      el('pbProjects').innerHTML = BoldProblemProjects.fields(projects,[]) || 'No projects yet.';
      var matches = results[1].filter(function(p){return p.name === user.displayName;});
      el('pbDefiner').innerHTML = BoldPeopleSelect.options(results[1],matches.length === 1 ? matches[0].id : null,'Choose a person');
      ready = true; status.textContent = '';
      controls();
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
