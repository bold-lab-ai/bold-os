// Adding an open problem to the Problem Bank (problems-register.html), as proposing a
// project (projects-register.html): the question, its task, its project and owner. Saved
// through benchmarkRegistry 'create' (functions/benchmark-registry.js), then its page opens.
(function(){
  'use strict';
  var el = function(id){ return document.getElementById(id); };
  var form = el('problemForm'), errorBox = el('problemError'), submitBtn = el('submitBtn');
  if (!form || !BOLD.getAuth()) return;
  var call = function(data){ return firebase.app().functions('europe-west2').httpsCallable('benchmarkRegistry')(data).then(function(r){ return r.data; }); };
  var esc = BOLD.escapeHtml, may = false, loaded = false;

  function showError(text){ errorBox.textContent = text; errorBox.hidden = !text; }
  function ready(){
    submitBtn.disabled = !(may && loaded);
    submitBtn.title = may ? '' : BOLD.cannotReason('projects', 'edit');
  }

  BOLD.onUser(function(user){
    if (!user) return;
    BOLD.onAccess(function(){ may = BOLD.can('projects', 'edit'); ready(); });
    // One row per project, as Projects lists them; ?project=<id>&board=<venue> picks one.
    var want = new URLSearchParams(location.search);
    call({ action: 'projects' }).then(function(r){
      el('prProject').innerHTML = '<option value="">Choose a project</option>' + r.items.map(function(x){
        var on = want.get('project') === x.id && (want.get('board') || '') === (x.board || '');
        return '<option value="' + esc(JSON.stringify([x.id, x.board])) + '"' + (on ? ' selected' : '') + '>' + esc(x.title + (x.venue ? ' · ' + x.venue : '')) + '</option>';
      }).join('');
      loaded = true; ready();
    }).catch(function(e){ showError('Could not load the projects. ' + (e.message || '')); });
  });

  form.addEventListener('submit', function(event){
    event.preventDefault();
    var project = el('prProject').value, title = el('prTitle').value.trim(), objective = el('prObjective').value.trim(),
      task = el('prTask').value.trim(), owner = el('prOwner').value.trim();
    var missing = !title ? 'Give the problem a title.' : !objective ? 'Say what the research question is.'
      : !task ? 'Say what kind of task it is.' : !project ? 'Choose its project.' : !owner ? 'Say who leads the work on it.' : '';
    if (missing) { showError(missing); return; }
    showError('');
    project = JSON.parse(project);
    submitBtn.disabled = true; submitBtn.textContent = 'Adding…';
    call({ action: 'create', project_id: project[0], project_board: project[1], title: title, objective: objective, task_kind: task, details: { owner: owner } })
      .then(function(r){ location.href = 'problems.html?problem=' + encodeURIComponent(r.problem_id); })
      .catch(function(e){ showError('Not added. ' + (e.message || '')); submitBtn.disabled = false; submitBtn.textContent = 'Add'; });
  });
})();
