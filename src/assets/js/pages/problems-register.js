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
    // The research owner: one of the lab's people (people-select.js), you to start with.
    BoldPeopleSelect.load().then(function(people){
      var me = (BOLD.getAuth().currentUser || {}).email, mine = null;
      el('prOwner').innerHTML = BoldPeopleSelect.options(people, null, 'Choose the research owner');
      firebase.firestore(BOLD.getApp()).collection('people').where('email', '==', String(me || '').toLowerCase()).limit(1).get()
        .then(function(s){ mine = s.empty ? null : (s.docs[0].data().slackId || s.docs[0].id); if (mine && !el('prOwner').value) el('prOwner').value = mine; }).catch(function(){});
    }).catch(function(e){ showError('Could not load the lab’s people. ' + (e.message || '')); });
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
      task = el('prTask').value.trim(), owner = el('prOwner').value;
    var missing = !title ? 'Give the problem a title.' : !objective ? 'Say what the research question is.'
      : !task ? 'Say what kind of task it is.' : !project ? 'Choose its project.' : !owner ? 'Choose the research owner.' : '';
    if (missing) { showError(missing); return; }
    showError('');
    project = JSON.parse(project);
    submitBtn.disabled = true; submitBtn.textContent = 'Adding…';
    call({ action: 'create', project_id: project[0], project_board: project[1], title: title, objective: objective, task_kind: task, owner_id: owner })
      .then(function(r){ location.href = 'problems.html?problem=' + encodeURIComponent(r.problem_id); })
      .catch(function(e){ showError('Not added. ' + (e.message || '')); submitBtn.disabled = false; submitBtn.textContent = 'Add'; });
  });
})();
