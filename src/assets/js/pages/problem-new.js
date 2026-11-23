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
  // Two ways compared (functions/problem-trial.js): talking with BOLD ('chat') or the form ('form'), one per person,
  // either can switch. Each attempt sends only signals: started, switched, a turn, BOLD failing, saved.
  var mode = 'chat', attempt = null, lastBold = null, SOFYA_WAIT = 45000;
  function trial(data){
    if (!attempt) return Promise.resolve(null);
    return call('problemTrial', Object.assign({ attempt: attempt }, data)).catch(function(err){ console.error('[BOLD Lab] problem trial', err); return null; });
  }
  var turns = [], draft = Object.assign({}, EMPTY), done = false, me = null, projects = [], submission = null;
  // The conversation is kept as a draft only they see (problemDrafts/{id}, firestore.rules), saved after each answer
  // and edit, to pick up later from Your drafts; deleted once the problem is saved. ?draft=<id> opens one.
  var draftId = null, myEmail = '', drafts = [], persistTimer = null;
  function store(){ return firebase.firestore().collection('problemDrafts'); }

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
  // Everything the Problem Bank needs is there (as the server's problem-interview.js complete()).
  function complete(d){ return !!(d.title && d.significance && d.difficulties && d.existing_solutions && d.benchmark_known); }
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
  review.addEventListener('input', function(){ draft = readReview(); drawNeeds(); persistSoon(); });
  review.addEventListener('change', function(){ draft = readReview(); drawNeeds(); persistSoon(); });
  el('pbToReview').addEventListener('click', function(){ review.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' }); el('pbTitle').focus({ preventScroll: true }); });
  // The way they're on: the conversation with its checklist, or the fields alone.
  function applyMode(){
    var form = mode === 'form';
    el('pbChatPart').hidden = form; el('pbNeedsPart').hidden = form;
    document.querySelector('.pb-talk').classList.toggle('is-form', form);
    el('pbReviewHead').textContent = form ? 'Describe the problem' : 'Check and edit';
    el('pbReviewHint').textContent = form ? 'Fill in each field; the optional ones can wait.' : 'What BOLD gathered from the conversation. Change anything, or keep talking to BOLD above.';
    el('pbSwitch').textContent = form ? 'Talk it through with BOLD instead' : 'Fill in the form instead';
    el('pbSwitch').hidden = !userId;
    if (form && review.hidden) showReview(false);
    if (!form && !done) review.hidden = true;
    el('pbBusy').hidden = true;
    drawNeeds(); drawDrafts();
  }
  function switchTo(to, reason){
    if (to === mode || talking || saving) return;
    if (!review.hidden) draft = readReview();
    mode = to; applyMode();
    trial({ event: 'switch', to: to, reason: reason || 'choice' });
    if (to === 'form') el('pbTitle').focus(); else input.focus();
  }
  el('pbSwitch').addEventListener('click', function(){ switchTo(mode === 'form' ? 'chat' : 'form'); });
  el('pbBusyForm').addEventListener('click', function(){ switchTo('form', 'sofya'); });
  // A new attempt: which way they get (fixed for them), and who they are (the problem's definer).
  function begin(generation){
    attempt = crypto.randomUUID(); lastBold = null;
    return trial({ event: 'start' }).then(function(r){
      if (generation !== epoch || !r) return;
      if (r.me) me = r.me;
      var asked = (location.search.match(/[?&]mode=(chat|form)/) || [])[1];
      mode = r.way || r.variant || 'chat'; applyMode();
      if (asked && asked !== mode) switchTo(asked, 'choice');
      controls();
    });
  }
  function controls(){
    var on = !!userId && canWrite && ready && !talking && !saving;
    input.disabled = send.disabled = !on;
    input.title = canWrite ? '' : BOLD.cannotReason('projects', 'edit');
    save.disabled = !on || !me || (mode === 'chat' && !done);
    save.title = me ? '' : 'You’re not in the BOLD Slack roster yet, so you can’t be its definer.';
    el('pbRestart').hidden = turns.length < 2;
  }
  function start(){
    if (userId && attempt && turns.length > 1) begin(epoch);
    turns = [{ role: 'assistant', content: OPENING }];
    draft = Object.assign({}, EMPTY); done = false; submission = null; review.hidden = true; familySelection = null;
    draftId = null; el('pbSavedNote').hidden = true; setAddress();
    log.innerHTML = item('bold', OPENING);
    if (mode === 'form') showReview(false);
    el('pbBusy').hidden = true;
    drawNeeds(); controls(); drawDrafts();
  }

  /* ---------- drafts: kept, listed, picked up ---------- */
  function setAddress(){
    try { history.replaceState(null, '', draftId ? '?draft=' + encodeURIComponent(draftId) : location.pathname); } catch (e){}
  }
  function persist(){
    clearTimeout(persistTimer);
    if (!myEmail || turns.length < 2) return Promise.resolve();
    var now = Date.now(), fresh = !draftId;
    if (fresh) { draftId = store().doc().id; setAddress(); }
    var firstSaid = (turns.filter(function(t){ return t.role === 'user'; })[0] || {}).content || '';
    var row = { email: myEmail, turns: turns, draft: draft, done: done, title: (draft.title || firstSaid).slice(0, 200), me: me, updatedAt: now };
    if (fresh) row.createdAt = now;
    return store().doc(draftId).set(row, { merge: true }).then(function(){
      el('pbSavedNote').hidden = false;
      var known = drafts.filter(function(d){ return d.id === draftId; })[0];
      if (known) Object.assign(known, row); else drafts.unshift(Object.assign({ id: draftId }, row));
      drawDrafts();
    }).catch(function(err){ console.error('[BOLD Lab] saving the problem draft failed', err); });
  }
  function persistSoon(){ clearTimeout(persistTimer); persistTimer = setTimeout(persist, 800); }
  function ago(t){
    var m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  function drawDrafts(){
    drafts.sort(function(a, b){ return (b.updatedAt || 0) - (a.updatedAt || 0); });
    el('pbDrafts').hidden = !drafts.length || mode === 'form';
    el('pbNew').hidden = !draftId;
    el('pbDraftList').innerHTML = drafts.map(function(d){
      return '<li' + (d.id === draftId ? ' class="is-current"' : '') + '><a href="?draft=' + encodeURIComponent(d.id) + '" data-open="' + esc(d.id) + '" title="' + esc(d.title || 'Untitled') + '">' +
        esc(d.title || 'Untitled') + '</a><small>' + esc(ago(d.updatedAt || 0)) + '</small><button type="button" class="btn-text" data-drop="' + esc(d.id) + '" aria-label="Delete this draft">\u00d7</button></li>';
    }).join('');
  }
  function loadDrafts(generation){
    return store().where('email', '==', myEmail).limit(30).get().then(function(snap){
      if (generation !== epoch) return;
      drafts = snap.docs.map(function(doc){ return Object.assign({ id: doc.id }, doc.data()); });
      drawDrafts();
    }).catch(function(err){ console.error('[BOLD Lab] loading problem drafts failed', err); });
  }
  // Picking one up: the conversation as it was, what BOLD had gathered, and Check and edit if it was done.
  function open(d){
    if (!d || talking || saving) return;
    start();
    if (mode !== 'chat') switchTo('chat', 'choice');
    draftId = d.id; turns = (d.turns || []).slice(); draft = Object.assign({}, EMPTY, d.draft || {}); done = !!d.done || complete(draft); me = d.me || me;
    log.innerHTML = turns.map(function(t){ return item(t.role === 'user' ? 'you' : 'bold', t.content); }).join('');
    el('pbSavedNote').hidden = false; setAddress();
    drawNeeds(); controls(); drawDrafts();
    if (done) showReview(false);
  }
  el('pbDraftList').addEventListener('click', async function(e){
    var a = e.target.closest('[data-open]'), x = e.target.closest('[data-drop]');
    if (a) { e.preventDefault(); open(drafts.filter(function(d){ return d.id === a.getAttribute('data-open'); })[0]); input.focus(); return; }
    if (!x) return;
    var id = x.getAttribute('data-drop'), d = drafts.filter(function(y){ return y.id === id; })[0];
    var ok = await BOLD.confirmAction({ title: 'Delete this draft?', go: 'Delete', effects: ['Delete \u201c' + ((d && d.title) || 'Untitled') + '\u201d and its conversation with BOLD. This can\u2019t be undone.'] });
    if (!ok) return;
    store().doc(id).delete().then(function(){
      drafts = drafts.filter(function(y){ return y.id !== id; });
      if (id === draftId) start(); else drawDrafts();
    }).catch(function(err){ status.textContent = 'Couldn\u2019t delete it: ' + ((err && err.message) || 'try again.'); });
  });
  el('pbNew').addEventListener('click', function(){ if (!talking && !saving) { start(); input.focus(); } });

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
    el('pbBusy').hidden = true;
    firebase.app().functions('europe-west2').httpsCallable('problemInterview', { timeout: SOFYA_WAIT })({ turns: turns, draft: draft }).then(function(x){ return x.data; }).then(function(r){
      if (generation !== epoch) return;
      if (r.me) me = r.me;
      lastBold = r.draft; trial({ event: 'turn' });
      var now = !!r.ready || complete(r.draft), first = !done && now;
      draft = r.draft; done = done || now;
      turns.push({ role: 'assistant', content: r.reply });
      var p = log.querySelector('.ha-pending'); if (p) p.remove();
      stream(r.reply); drawNeeds();
      if (done) showReview(first);
      persist();
    }).catch(function(err){
      if (generation !== epoch) return;
      turns.pop();
      var p = log.querySelector('.ha-pending'); if (p) p.remove();
      // BOLD failing or slow: the form, with what it has gathered so far, is one click away.
      var mine = err && (err.code === 'functions/invalid-argument');
      if (mine) log.insertAdjacentHTML('beforeend', item('bold', err.message, true));
      else { el('pbBusy').hidden = false; trial({ event: 'sofya_error' }); }
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
    if ((mode === 'chat' && !done) || saving || !me) return;
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
      await trial({ event: 'saved', problem_id: result.problem_id, bold: lastBold, saved: draft });
      // Let an open project proposal reload its choices. Keep the problem data out of browser storage.
      try { localStorage.setItem('boldOpenProblemsChanged', submission.id); } catch (ignored) {}
      // Saved: its draft goes.
      clearTimeout(persistTimer);
      if (draftId) await store().doc(draftId).delete().catch(function(){});
      location.assign('problem.html?problem=' + encodeURIComponent(result.problem_id));
    } catch (e){ if (generation === epoch) status.textContent = (e && e.message) || 'Could not save. Try again.'; }
    finally { if (generation === epoch) { saving = false; controls(); } }
  });

  BOLD.onAccess(function(){ canWrite = BOLD.can('projects', 'edit'); controls(); });
  BOLD.onUser(function(user){
    var generation = ++epoch;
    userId = user && user.uid; ready = false; talking = false; saving = false; me = null; projects = []; attempt = null; mode = 'chat';
    myEmail = user && user.email ? String(user.email).toLowerCase() : ''; drafts = [];
    var want = (location.search.match(/[?&]draft=([A-Za-z0-9]+)/) || [])[1];
    start();
    if (!user) { status.textContent = 'Sign in to add a problem.'; return; }
    status.textContent = 'Loading…';
    call('benchmarkRegistry', { action: 'projects' }).then(function(r){
      if (generation !== epoch) return;
      projects = r.items || []; ready = true; status.textContent = ''; controls(); input.focus();
      // The family tree first: the form way opens straight on the fields, its links included.
      return call('benchmarkRegistry', { action: 'family' }).then(function(g){ if (generation === epoch) familyGraph = g; }).catch(function(){})
        .then(function(){ return Promise.all([begin(generation), loadDrafts(generation)]); }).then(function(){
        if (generation !== epoch || !want) return;
        var d = drafts.filter(function(x){ return x.id === want; })[0];
        if (d) open(d); else status.textContent = 'That draft isn\u2019t there any more.';
      });
    }).catch(function(e){ if (generation === epoch) status.textContent = e.message; });
  });
})();
