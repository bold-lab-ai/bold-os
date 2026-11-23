// Adding a problem by talking to BOLD (problem-new.html): the home page's conversation (bold.css .ha-*), and beside
// it what the Problem Bank needs, each ticked once BOLD-LLM has it from what they said (problemInterview,
// functions/problem-interview.js). Once it has all it needs, Check and edit shows what it gathered as fields, to
// change and save through benchmarkRegistry's create, with the person as its definer.
(function(){
  'use strict';
  var el = function(id){ return document.getElementById(id); };
  var esc = BOLD.escapeHtml;
  var OPENING = 'Describe the problem you’d like to add: what you want to solve, and why it matters to you.';
  // What the Problem Bank needs, in the order BOLD asks for it.
  var NEEDS = [
    ['title', 'A title'],
    ['significance', 'Why it matters'],
    ['difficulties', 'What makes it hard'],
    ['existing_solutions', 'Where the frontier is'],
    ['benchmark', 'Whether it builds a benchmark'],
    ['links', 'What it’s part of <small>(optional)</small>']
  ];
  var EMPTY = { title: '', significance: '', difficulties: '', existing_solutions: '', builds_benchmark: false, benchmark_known: false,
    collaborators: '', project_ids: [], parent_ids: [], related_ids: [] };
  var log = el('pbLog'), form = el('pbChatForm'), input = el('pbChatInput'), send = el('pbSend'), status = el('pbStatus');
  var review = el('pbReview'), save = el('pbReviewSave'), familyGraph = null, familySelection = null;
  var still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var userId = null, epoch = 0, canWrite = false, ready = false, talking = false, saving = false;
  var turns = [], draft = Object.assign({}, EMPTY), done = false, me = null, projects = [], submission = null;

  function call(name, data){ return firebase.app().functions('europe-west2').httpsCallable(name, { timeout: 130000 })(data).then(function(r){ return r.data; }); }
  function md(t){ return window.BoldMarkdown ? BoldMarkdown.render(t, { breaks: true }) : '<p>' + esc(t) + '</p>'; }
  function item(who, text, fresh){
    return '<li class="ha-msg ha-' + who + (fresh ? ' is-new' : '') + '"><p class="ha-who">' + (who === 'you' ? 'You' : 'BOLD') + '</p><div class="ha-text md-desc">' + md(text) + '</div></li>';
  }
  // BOLD's answer writes itself out, word by word, as on the home page.
  function stream(full){
    log.insertAdjacentHTML('beforeend', item('bold', '', true));
    var t = log.lastElementChild.querySelector('.ha-text'), parts = full.split(/(\s+)/), n = 0;
    if (still) { t.innerHTML = md(full); return; }
    t.classList.add('is-streaming');
    var tick = setInterval(function(){
      n += 2; t.innerHTML = md(parts.slice(0, n).join(''));
      if (n >= parts.length) { clearInterval(tick); t.classList.remove('is-streaming'); t.innerHTML = md(full); }
    }, 35);
  }

  // What it has so far, ticked; Save problem once BOLD says it's complete.
  function has(k){
    if (k === 'benchmark') return draft.benchmark_known;
    if (k === 'links') return !!(draft.parent_ids.length || draft.related_ids.length || draft.project_ids.length);
    return !!draft[k];
  }
  function drawNeeds(){
    el('pbChecks').innerHTML = NEEDS.map(function(n){
      return '<li class="' + (has(n[0]) ? 'is-done' : '') + '"><span>' + n[1] + '</span></li>';
    }).join('');
    el('pbVerifierStep').textContent = draft.builds_benchmark ? 'Verifier not required' : 'Add a verifier';
    el('pbBaselineStep').hidden = draft.builds_benchmark;
    el('pbToReview').hidden = review.hidden;
  }

  /* ---------- Check and edit: what BOLD gathered, as fields ---------- */
  // Projects to link: stepping stones (northstars and moonshots are in the family tree).
  function stones(){
    var objectives = familyGraph ? familyGraph.objectives.map(function(o){ return o.id; }) : [];
    return projects.filter(function(p){ return objectives.indexOf(p.id) < 0; });
  }
  function showReview(first){
    el('pbTitle').value = draft.title; el('pbWhy').value = draft.significance; el('pbDifficulties').value = draft.difficulties;
    el('pbExisting').value = draft.existing_solutions; el('pbCollaborators').value = draft.collaborators;
    el('pbBuildsBenchmark').checked = draft.builds_benchmark;
    var chosen = stones().filter(function(p){ return draft.project_ids.indexOf(p.id) >= 0; });
    el('pbProjects').innerHTML = BoldProblemProjects.fields(stones(), chosen) || 'No projects yet.';
    el('pbProjectsBox').open = chosen.length > 0;
    familySelection = familyGraph ? BoldProblemFamily.picker(el('pbFamily'), familyGraph, null, { parents: draft.parent_ids, related: draft.related_ids }) : null;
    if (!familyGraph) el('pbFamily').innerHTML = '<p class="field-hint">Couldn\u2019t load the family tree: add links later, on the problem\u2019s page.</p>';
    review.hidden = false; drawNeeds();
    if (first) review.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
  }
  // The fields as they stand, as a draft: what's sent with the next message, and what's saved.
  function readReview(){
    var family = familySelection ? familySelection() : { parents: draft.parent_ids, related: draft.related_ids };
    return { title: el('pbTitle').value.trim(), significance: el('pbWhy').value.trim(), difficulties: el('pbDifficulties').value.trim(),
      existing_solutions: el('pbExisting').value.trim(), builds_benchmark: el('pbBuildsBenchmark').checked, benchmark_known: true,
      collaborators: el('pbCollaborators').value.trim(),
      project_ids: BoldProblemProjects.selected(el('pbProjects'), stones()).map(function(p){ return p.id; }),
      parent_ids: family.parents.slice(), related_ids: family.related.slice() };
  }
  review.addEventListener('input', function(){ draft = readReview(); drawNeeds(); });
  review.addEventListener('change', function(){ draft = readReview(); drawNeeds(); });
  el('pbToReview').addEventListener('click', function(){ review.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' }); el('pbTitle').focus({ preventScroll: true }); });
  function controls(){
    var on = !!userId && canWrite && ready && !talking && !saving;
    input.disabled = send.disabled = !on;
    input.title = canWrite ? '' : BOLD.cannotReason('projects', 'edit');
    save.disabled = !on || !me;
    save.title = me ? '' : 'You’re not in the BOLD Slack roster yet, so you can’t be its definer.';
    el('pbRestart').hidden = turns.length < 2;
  }
  function start(){
    turns = [{ role: 'assistant', content: OPENING }];
    draft = Object.assign({}, EMPTY); done = false; submission = null; review.hidden = true; familySelection = null;
    log.innerHTML = item('bold', OPENING);
    drawNeeds(); controls();
  }

  form.addEventListener('submit', function(e){
    e.preventDefault();
    var q = input.value.trim();
    if (!q || talking || !userId) return;
    var generation = epoch;
    if (!review.hidden) draft = readReview();
    turns.push({ role: 'user', content: q });
    log.insertAdjacentHTML('beforeend', item('you', q, true));
    input.value = ''; input.dispatchEvent(new Event('input'));
    log.insertAdjacentHTML('beforeend', '<li class="ha-msg ha-bold ha-pending"><p class="ha-who">BOLD</p><div class="ha-text"><p>Thinking…</p></div></li>');
    talking = true; controls();
    call('problemInterview', { turns: turns, draft: draft }).then(function(r){
      if (generation !== epoch) return;
      if (r.me) me = r.me;
      var first = !done && !!r.ready;
      draft = r.draft; done = done || !!r.ready;
      turns.push({ role: 'assistant', content: r.reply });
      var p = log.querySelector('.ha-pending'); if (p) p.remove();
      stream(r.reply); drawNeeds();
      if (done) showReview(first);
    }).catch(function(err){
      if (generation !== epoch) return;
      turns.pop();
      var p = log.querySelector('.ha-pending'); if (p) p.remove();
      log.insertAdjacentHTML('beforeend', item('bold', (err && err.message && err.code !== 'functions/internal') ? err.message : 'BOLD couldn’t answer just now — try again.', true));
      input.value = q;
    }).then(function(){
      if (generation !== epoch) return;
      talking = false; controls(); input.focus();
    });
  });
  // Enter sends; Shift+Enter is a new line.
  input.addEventListener('keydown', function(e){ if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  el('pbRestart').addEventListener('click', function(){ if (!talking && !saving) { start(); input.focus(); } });

  // Saving: what BOLD gathered, as the form saved it, the person as its definer.
  review.addEventListener('submit', async function(e){
    e.preventDefault();
    if (!done || saving || !me) return;
    if (!review.reportValidity()) return;
    draft = readReview();
    var generation = epoch;
    var data = { action: 'create', builds_benchmark: draft.builds_benchmark, title: draft.title, owner_id: me.id, collaborators: draft.collaborators,
      significance: draft.significance, difficulties: draft.difficulties, existing_solutions: draft.existing_solutions,
      projects: projects.filter(function(p){ return draft.project_ids.indexOf(p.id) >= 0; }).map(function(p){ return { id: p.id, board: p.board || '' }; }) };
    if (draft.parent_ids.length || draft.related_ids.length) data.family = { parents: draft.parent_ids.slice(), related: draft.related_ids.slice() };
    saving = true; controls();
    try {
      var choice = await BOLD.confirmAction({ title: 'Save “' + draft.title + '”?', go: 'Save problem', always: true,
        effects: ['Add it to the Problem Bank, with you as its definer.'].concat(data.builds_benchmark ? ['It builds a benchmark, so it needs no separate verifier.'] :
          [{ key: 'reminders', text: 'Remind me on Slack now and every week until this problem has a registered verifier. My notification settings apply.' }]) });
      if (!choice || generation !== epoch) return;
      data.reminders = !data.builds_benchmark && !(choice.skip && choice.skip.reminders);
      var signature = JSON.stringify(data);
      if (!submission || submission.signature !== signature) submission = { signature: signature, id: crypto.randomUUID() };
      status.textContent = 'Saving…';
      var result = await call('benchmarkRegistry', Object.assign(data, { request_id: submission.id }));
      if (generation !== epoch) return;
      // Let an open project proposal reload its choices. Keep the problem data out of browser storage.
      try { localStorage.setItem('boldOpenProblemsChanged', submission.id); } catch (ignored) {}
      location.assign('problem.html?problem=' + encodeURIComponent(result.problem_id));
    } catch (e){ if (generation === epoch) status.textContent = (e && e.message) || 'Could not save. Try again.'; }
    finally { if (generation === epoch) { saving = false; controls(); } }
  });

  BOLD.onAccess(function(){ canWrite = BOLD.can('projects', 'edit'); controls(); });
  BOLD.onUser(function(user){
    var generation = ++epoch;
    userId = user && user.uid; ready = false; talking = false; saving = false; me = null; projects = [];
    start();
    if (!user) { status.textContent = 'Sign in to add a problem.'; return; }
    status.textContent = 'Loading…';
    call('benchmarkRegistry', { action: 'projects' }).then(function(r){
      if (generation !== epoch) return;
      projects = r.items || []; ready = true; status.textContent = ''; controls(); input.focus();
      return call('benchmarkRegistry', { action: 'family' }).then(function(g){ if (generation === epoch) familyGraph = g; }).catch(function(){});
    }).catch(function(e){ if (generation === epoch) status.textContent = e.message; });
  });
})();
