(function(){
  'use strict';
  var el = function(id){ return document.getElementById(id); };
  var form = el('pbCreate'), fields = el('pbInputs'), status = el('pbStatus');
  var userId = null, epoch = 0, canWrite = false, projects = [], busy = false, submission = null;
  function call(data){ return firebase.app().functions('europe-west2').httpsCallable('benchmarkRegistry')(data).then(function(r){ return r.data; }); }
  function controls(){
    fields.disabled = !canWrite || !projects.length || busy;
    fields.title = canWrite ? '' : BOLD.cannotReason('projects', 'edit');
  }
  BOLD.onAccess(function(){ canWrite = BOLD.can('projects', 'edit'); controls(); });
  BOLD.onUser(function(user){
    var generation = ++epoch;
    userId = user && user.uid; projects = []; submission = null; busy = false; form.reset(); controls();
    el('pbProject').length = 1;
    if (!user) { status.textContent = 'Sign in to add a problem.'; return; }
    call({ action: 'projects' }).then(function(r){
      if (epoch !== generation) return;
      projects = r.items;
      projects.forEach(function(p, i){ el('pbProject').add(new Option(p.title + (p.venue ? ' · ' + p.venue : ''), String(i))); });
      status.textContent = projects.length ? '' : 'Add a BOLD OS project first.';
      controls();
    }).catch(function(e){ if (epoch === generation) status.textContent = e.message; });
  });
  form.addEventListener('submit', async function(event){
    event.preventDefault();
    if (!userId || fields.disabled || !form.reportValidity()) return;
    var generation = epoch, project = projects[Number(el('pbProject').value)];
    var data = { action: 'create', project_id: project.id, project_board: project.board || '',
      title: el('pbTitle').value.trim(), objective: el('pbQuestion').value.trim(),
      significance: el('pbWhy').value.trim(), existing_solutions: el('pbExisting').value.trim() };
    busy = true; controls();
    try {
      var choice = await BOLD.confirmAction({ title: 'Save this open problem?', go: 'Save problem', always: true,
        effects: [{ key: 'reminders', text: 'Remind me on Slack now and every week until this problem has a registered verifier. My notification settings apply.' }] });
      if (!choice || generation !== epoch) return;
      data.reminders = !choice.skip.reminders;
      var signature = JSON.stringify(data);
      if (!submission || submission.signature !== signature) submission = { signature: signature, id: crypto.randomUUID() };
      status.textContent = 'Saving…';
      var result = await call(Object.assign(data, { request_id: submission.id }));
      if (generation === epoch) location.assign('problem.html?problem=' + encodeURIComponent(result.problem_id));
    } catch (e){ if (generation === epoch) status.textContent = e.message || 'Could not save. Try again.'; }
    finally { if (generation === epoch) { busy = false; controls(); } }
  });
})();
