"use strict";

  // ---------- modal ----------

  // ---------- dynamic author rows (Edit fields) ----------
  // Array of in-progress { name, email, isNew } rows, reset each time the
  // Edit-fields modal opens. A project's authors can be updated before
  // submitting the abstract. Authors resolve to a real person's email via
  // the roster picker (2026-09-12) — same as reviewers (reviewerInputHtml)
  // — with a "+ New author" escape hatch (typed Name + Email) for someone
  // genuinely outside the Slack workspace. Used to be free text; every
  // feature that needs a real identity to act on (notifications chief
  // among them) needs a real email to reach someone, which a free-text
  // name can never reliably give. `isNew` is UI-only (which control this
  // row shows) — stripped before the row is ever saved, see onSaveEdit.
  var eAuthorsState = [{ name: '', email: '', isNew: false }];

  // Max papers per author (board.maxPapersPerAuthor) is deliberately NOT
  // a client-side save-blocking gate (reverted 2026-09-14, was briefly a
  // hard block the same day) — per Eduardo: still let the paper be
  // registered/saved either way. Two separate, complementary surfaces for
  // it instead: a one-time Slack DM the moment someone's newly added over
  // the limit (a Cloud Function's job — it needs to DM someone, which
  // only a server-side credential can do — see notifyAuthorsOverCap in
  // functions/index.js, triggered off the same onCardWritten write this
  // save already produces via authorEmails), and a standing banner at the
  // top of the venue board (currentUserPaperCapWarning, right below) for
  // whoever's signed in and currently over it — a DM is easy to miss or
  // scroll past; this is visible every time they open the board itself,
  // for as long as it's still true.

  // Non-withdrawn papers on this venue that an author (by email) is on —
  // the one counting rule shared by currentUserPaperCapWarning and
  // abstractAcceptBlockReason below (both client-side, both off the same
  // already-loaded state.cards, so sharing this one is worth it — unlike
  // notifyAuthorsOverCap's own copy of the same idea server-side, in
  // functions/index.js, which stays independent since it runs off a
  // Firestore query in a different runtime entirely).
  function paperCountForAuthor(email, cards){
    return (cards || []).filter(function(c){
      return c.outcome !== 'withdrawn' && (c.authorEmails || []).indexOf(email) !== -1;
    }).length;
  }

  // The board-banner half — read-only, no save involved at all, just
  // "is the person looking at this board, right now, over the venue's
  // cap." Returns null (render nothing) if there's no cap set, nobody
  // signed in, or they're at-or-under it.
  function currentUserPaperCapWarning(board, cards, userEmail){
    var max = board && board.maxPapersPerAuthor;
    if (!max || !userEmail) return null;
    var count = paperCountForAuthor(userEmail, cards);
    if (count <= max) return null;
    return { count: count, max: max };
  }

  // Abstract-submission gate (2026-09-14, per Eduardo; moved from paper
  // submission to abstract submission 2026-09-18+19, per Eduardo — the
  // cap has to bite before the paper is written, not after). Applies in
  // both pipelines. Moving a card into Abstract is where the two things
  // this checkpoint exists to check get enforced: the authors list is
  // actually filled in, and nobody on the paper is over the venue's
  // max-papers-per-author cap. A real hard block on THIS specific
  // transition — unlike currentUserPaperCapWarning/notifyAuthorsOverCap
  // above, which stay deliberately non-blocking (a save-time hard block
  // at registration was tried and reverted the same day — see the comment
  // above currentUserPaperCapWarning). Called from advanceBlockReason and
  // mirrored in onChangeStatus for the status dropdown.
  function abstractAcceptBlockReason(card, board, cards){
    if (!card.authors || !card.authors.length) return 'Add the authors before submitting the abstract';
    var max = board && board.maxPapersPerAuthor;
    if (!max) return null;
    var overCount = authorEmailsOf(card.authors).filter(function(email){
      return paperCountForAuthor(email, cards) > max;
    }).length;
    if (!overCount) return null;
    return (overCount === 1 ? 'An author is' : overCount + ' authors are') + ' over the ' + max + '-per-author limit for this venue';
  }

  // Registering a paper requires being signed in \u2014 submittedBy and the
  // corresponding author email are both derived from state.currentUser, not
  // typed in (see docs/FIREBASE.md's write-gating decision). Call this before
  // showing the register button/modal; it also guards openModal() itself
  // as a defense-in-depth check, not just the trigger button.
  function requireSignedIn(){
    if (state.currentUser) return true;
    showToast('Sign in with Slack to register a paper.', 'error');
    return false;
  }

  function paperRegistrationReason(){
    if (!state.currentUser) return 'Sign in with Slack to register a paper.';
    if (BOLD.can('ml-cycle', 'edit') || BOLD.can('projects', 'edit')) return '';
    return 'Registering a paper requires edit access to Internal Review or Projects.';
  }

  function paperDraftKey(board, email){
    return 'airb-draft-register:' + board + ':' + email;
  }

  function readPaperDraft(key){
    try { return JSON.parse(localStorage.getItem(key)) || {}; }
    catch (e){ return {}; }
  }

  function savePaperDraft(key, draft){
    try {
      if ([draft.title, draft.computeEstimate, draft.note, draft.problemId].some(function(value){ return value.trim(); })) {
        localStorage.setItem(key, JSON.stringify(draft));
      } else {
        localStorage.removeItem(key);
      }
    } catch (e){ /* The form still works if browser storage is unavailable. */ }
  }

  var pendingPaperCard = null;

  function openRegisteredPaper(){
    if (!pendingPaperCard) return;
    var target = pendingPaperCard;
    if (state.currentBoardId !== target.board || state.view !== 'venue' || !state.currentUser || state.currentUser.email !== target.email){
      pendingPaperCard = null;
      return;
    }
    if (state.cards.some(function(card){ return card.id === target.id; })){
      pendingPaperCard = null;
      openCard(target.id);
    }
  }

  function openModal(){
    var reason = paperRegistrationReason();
    if (reason) { showToast(reason, 'error'); return; }
    var current = getCurrentBoard();
    if (!current || current.status === 'pending') { showToast('Choose an approved venue first.', 'error'); return; }
    var email = state.currentUser.email;
    var key = paperDraftKey(current.id, email);
    var draft = readPaperDraft(key);
    var problemId = draft.problemId || '';
    var requestId = draft.requestId || crypto.randomUUID();
    var registry = firebase.app().functions('europe-west2').httpsCallable('benchmarkRegistry');
    var busy = false;
    var canDefine = BOLD.can('projects', 'view') && BOLD.can('projects', 'edit');
    els.modalRegion.innerHTML =
      '<div class="modal-overlay" id="modalOverlay"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">' +
      '<h2 id="modalTitle">Register paper for review</h2>' +
      '<form id="paperForm"><p>Registering as ' + escapeHtml(state.currentUser.name || email) + ' for ' + escapeHtml(current.label || current.id) + '.</p>' +
      (draft.savedAt ? '<p id="draftNotice">Restored your unsent draft. <button class="btn-text" type="button" id="discardDraft">Discard</button></p>' : '') +
      '<div class="field"><label for="pTitle">Paper title</label><input id="pTitle" type="text" maxlength="300" required></div>' +
      '<div class="field"><label for="pProblem">Open problem</label><select id="pProblem" required disabled aria-describedby="paperProblemStatus">' +
        '<option value="">Choose an open problem</option></select>' +
        '<span id="paperProblemStatus" role="status">Loading open problems…</span> ' +
        '<button id="retryPaperProblems" class="btn-text" type="button" hidden>Refresh list</button>' +
        (canDefine ? '<div>Can’t find the appropriate problem? Define one <a href="problems.html" target="_blank" rel="noopener" aria-label="here, in the Problem Bank (opens in a new tab)">here</a>.</div>' : '<div>Ask a collaborator to add any missing problem to the Problem Bank.</div>') + '</div>' +
      '<div class="field"><label for="pCompute">Compute estimate</label><input id="pCompute" type="text" maxlength="500" placeholder="e.g. 8 A100-hours"></div>' +
      '<div class="field"><label for="pNote">Note for the reviewers (optional)</label><textarea id="pNote" maxlength="4000"></textarea></div>' +
      '<div class="field-error" id="paperFormError" role="alert" hidden></div>' +
      '<div class="modal-actions"><button class="btn" type="button" id="cancelModal">Cancel</button>' +
        '<button class="btn btn-primary" type="submit" id="submitCardBtn" disabled>Register paper</button></div></form></div></div>';
    var form = document.getElementById('paperForm');
    var title = form.elements.pTitle, select = form.elements.pProblem, compute = form.elements.pCompute, note = form.elements.pNote;
    var submit = form.elements.submitCardBtn, cancel = form.elements.cancelModal, refresh = form.elements.retryPaperProblems;
    var error = document.getElementById('paperFormError'), status = document.getElementById('paperProblemStatus');
    title.value = draft.title || '';
    compute.value = draft.computeEstimate || '';
    note.value = draft.note || '';

    function visible(){
      return form.isConnected && state.currentUser && state.currentUser.email === email && state.currentBoardId === current.id;
    }
    function remember(){
      savePaperDraft(key, {title:title.value, computeEstimate:compute.value, note:note.value, problemId:problemId, requestId:requestId, savedAt:Date.now()});
    }
    function updateSubmit(){
      submit.disabled = busy || !title.value.trim() || select.disabled || !select.value;
    }
    async function loadProblems(){
      select.disabled = true;
      refresh.hidden = true;
      status.textContent = 'Loading open problems…';
      updateSubmit();
      try {
        var result = await registry({action:'past_paper_problem_choices'});
        if (!visible()) return;
        var items = result.data.items;
        select.length = 1;
        items.forEach(function(problem){ select.add(new Option(problem.title, problem.id)); });
        select.value = problemId;
        select.disabled = !items.length;
        if (!items.length) status.textContent = 'There are no active open problems. Refresh this list after a problem is added.';
        else if (problemId && !select.value) status.textContent = 'The saved problem is no longer available. Choose another open problem.';
        else status.textContent = '';
      } catch (e){
        if (visible()) status.textContent = 'Could not load the open problems. Refresh the list to try again.';
      } finally {
        if (visible()) { refresh.hidden = false; updateSubmit(); }
      }
    }
    form.addEventListener('input', function(){
      error.hidden = true;
      remember();
      updateSubmit();
    });
    select.addEventListener('change', function(){ problemId = select.value; remember(); updateSubmit(); });
    refresh.addEventListener('click', loadProblems);
    if (form.elements.discardDraft) form.elements.discardDraft.addEventListener('click', function(){
      try { localStorage.removeItem(key); } catch (e){}
      openModal();
    });
    function dismiss(){
      if (busy) return;
      closeModal();
      var trigger = document.getElementById('submitPaperBtn');
      if (trigger) trigger.focus();
    }
    cancel.addEventListener('click', dismiss);
    document.getElementById('modalOverlay').addEventListener('click', function(event){ if (event.target.id === 'modalOverlay') dismiss(); });
    form.addEventListener('keydown', function(event){ if (event.key === 'Escape') dismiss(); });
    form.addEventListener('submit', async function(event){
      event.preventDefault();
      if (!visible() || submit.disabled) return;
      busy = true;
      remember();
      var payload = {action:'register_past_paper', request_id:requestId, board:current.id, problem_id:select.value,
        title:title.value.trim(), compute_estimate:compute.value.trim(), note:note.value.trim()};
      var controls = Array.from(form.elements).filter(function(control){ return !control.disabled; });
      controls.forEach(function(control){ control.disabled = true; });
      error.hidden = true;
      submit.textContent = 'Registering…';
      try {
        var result = (await registry(payload)).data;
        if (result.board !== current.id || !result.card_id) throw new Error('Could not confirm registration. Retry to check this paper.');
        if (readPaperDraft(key).requestId === requestId) {
          try { localStorage.removeItem(key); } catch (e){}
        }
        if (!visible()) return;
        closeModal();
        pendingPaperCard = {board:result.board, id:result.card_id, email:email};
        openRegisteredPaper();
        showToast('Registered for review.', 'ok');
      } catch (e){
        if (!visible()) return;
        busy = false;
        controls.forEach(function(control){ control.disabled = false; });
        submit.textContent = 'Register paper';
        error.hidden = false;
        error.textContent = e.code === 'functions/already-exists'
          ? 'This draft has already been registered. Check the venue board. To register another paper, reopen this form and discard the saved draft.'
          : e.message || 'Could not register this paper. Try again.';
        if (e.code === 'functions/failed-precondition' || e.code === 'functions/not-found') loadProblems();
        else updateSubmit();
      }
    });
    title.focus();
    loadProblems();
  }

  function closeModal(){ els.modalRegion.innerHTML = ''; }

  function openEditModal(cardId){
    var card = state.cards.filter(function(c){ return c.id === cardId; })[0];
    if (!card) return;
    // Only the paper's authors can edit its fields (2026-09-18+27, per Eduardo).
    if (!canManageAuthorFields(card)){
      showToast('Only the paper’s authors can edit its fields.', 'error');
      return;
    }
    startEditing('edit', cardId, true);
    var editBoard = getCurrentBoard();
    var authorsLock = authorsLocked(card, editBoard);
    els.modalRegion.innerHTML =
      '<div class="modal-overlay" id="modalOverlay">' +
        '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="editModalTitle">' +
          '<h2 id="editModalTitle">Edit &ldquo;' + escapeHtml(card.title) + '&rdquo;</h2>' +
          '<div id="editForm">' +
            '<div class="field"><label for="eTitle">Paper title</label><input type="text" id="eTitle" value="' + escapeHtml(card.title || '') + '"></div>' +
            '<div class="field"><label for="eAuthorsWrap">Authors</label><div id="eAuthorsWrap"></div>' +
              (authorsLock
                ? '<div style="font-size:12px;color:var(--danger-text);margin-top:4px;">Locked — authors are fixed once the abstract is submitted, matching the venue’s own submission.</div>'
                : '<button class="btn-text" type="button" id="eAddAuthor">+ Add author</button>' +
                  '<div style="font-size:12px;color:var(--muted);margin-top:4px;">In author order &mdash; the last one is the PI.</div>') +
            '</div>' +
            '<div class="field"><label for="eOverleaf">Overleaf link</label><input type="url" id="eOverleaf" value="' + escapeHtml(card.overleafLink || '') + '" placeholder="https://www.overleaf.com/project/..."></div>' +
            '<div class="field"><label for="eAbstract">Abstract</label><textarea id="eAbstract" class="no-tags" maxlength="' + ABSTRACT_MAX_CHARS + '" placeholder="Paste the abstract text. LaTeX is fine, typed as plain text: $inline formula$ or $$block formula$$.">' + escapeHtml(card.abstractText || '') + '</textarea></div>' +
            '<div class="field"><label for="eEmail">Corresponding author email</label><input type="email" id="eEmail" value="' + escapeHtml(card.correspondingAuthorEmail || '') + '"></div>' +
            '<div class="field"><label for="eCompute">Compute estimate</label><input type="text" id="eCompute" value="' + escapeHtml(card.computeEstimate || '') + '" placeholder="e.g. ~2000 A100-hours"></div>' +
            '<div class="field"><label for="ePitchLink">Pitch materials</label><input type="url" id="ePitchLink" value="' + escapeHtml(card.pitchLink || '') + '" placeholder="https://docs.google.com/presentation/..."><div style="font-size:12px;color:var(--muted);margin-top:4px;">Required to leave Registered.</div></div>' +
            '<div class="field"><label for="eSubmissionLink">OpenReview submission link</label><input type="url" id="eSubmissionLink" value="' + escapeHtml(card.submissionLink || '') + '" placeholder="https://openreview.net/forum?id=aK7xQp2LrZ"><div style="font-size:12px;color:var(--muted);margin-top:4px;">Required to leave Paper.</div></div>' +
            '<div class="field"><label for="eArxivLink">arXiv link</label><input type="url" id="eArxivLink" value="' + escapeHtml(card.arxivLink || '') + '" placeholder="https://arxiv.org/abs/..."><div style="font-size:12px;color:var(--muted);margin-top:4px;">Optional — post whenever it’s ready, not required to advance.</div></div>' +
            '<div class="field"><label for="eRebuttalDeadline">Rebuttal deadline</label><input type="date" id="eRebuttalDeadline" value="' + escapeHtml(card.rebuttalDeadline || '') + '"></div>' +
            '<div class="field"><label for="eRebuttalDoc">Rebuttal document</label><input type="url" id="eRebuttalDoc" value="' + escapeHtml(card.rebuttalDocLink || '') + '" placeholder="https://docs.google.com/..."><div style="font-size:12px;color:var(--muted);margin-top:4px;">Required to leave Rebuttal.</div></div>' +
            '<div class="field"><label for="eCameraReadyLink">Camera-ready link</label><input type="url" id="eCameraReadyLink" value="' + escapeHtml(card.cameraReadyLink || '') + '" placeholder="https://..."><div style="font-size:12px;color:var(--muted);margin-top:4px;">Required to leave Camera-ready Submitted.</div></div>' +
            '<div class="field"><label for="eReviewNotes">Review notes</label><textarea id="eReviewNotes" placeholder="Scores, summary, anything worth remembering">' + escapeHtml(card.reviewNotes || '') + '</textarea></div>' +
            '<div class="field"><label for="eOutcome">Outcome</label><select id="eOutcome">' +
              '<option value=""' + (!card.outcome ? ' selected' : '') + '>No outcome yet</option>' +
              '<option value="accepted"' + (card.outcome === 'accepted' ? ' selected' : '') + '>Accepted</option>' +
              '<option value="rejected"' + (card.outcome === 'rejected' ? ' selected' : '') + '>Rejected</option>' +
              '<option value="withdrawn"' + (card.outcome === 'withdrawn' ? ' selected' : '') + '>Withdrawn</option>' +
            '</select></div>' +
            '<div class="field-error" id="editFormError" hidden></div>' +
            '<div class="modal-actions">' +
              '<button class="btn" type="button" id="cancelEditModal">Cancel</button>' +
              '<button class="btn btn-primary" type="button" id="saveEditBtn">Save</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.getElementById('cancelEditModal').addEventListener('click', closeModal);
    document.getElementById('modalOverlay').addEventListener('click', function(e){
      if (e.target.id === 'modalOverlay') closeModal();
    });
    document.getElementById('saveEditBtn').addEventListener('click', function(){ onSaveEdit(cardId); });
    var submitOnEnter = function(ev){ onSaveEdit(cardId); };
    ['eTitle', 'eOverleaf', 'eEmail', 'eCompute'].forEach(function(id){
      document.getElementById(id).addEventListener('keydown', function(ev){
        if (ev.key === 'Enter'){ ev.preventDefault(); onSaveEdit(cardId); }
      });
    });
    // isNew must reflect whether this person is actually IN the roster
    // (2026-09-18+21, found by Eduardo — "the dialog for authors doesn't
    // show their names, only 'Choose a person...'"), not unconditionally
    // false: authorRowsHtml's roster-picker mode can only ever show a
    // name if state.people has a matching email — an author saved as
    // "+ New author (not in the workspace)" (or anyone simply not yet
    // Slack-synced) has no such match, so the <select> silently fell
    // back to its own first, unselected option every time the row was
    // reconstructed from saved data, even though name/email were both
    // there all along. Also covers a blank email specifically
    // (2026-09-18+22, found by Eduardo testing an older card whose
    // authors came from the plain-string-author migration — see
    // normalizeCard's own comment, email unrecoverable for that old
    // data): `a.email && personByEmail(a.email)` is false either way a
    // row can't resolve to a real picker option, whether that's because
    // the email plain doesn't match anyone, or because there's no email
    // at all — both need "+ New author" text-input mode to show the
    // name, which the picker has no way to display for either case.
    eAuthorsState = card.authors && card.authors.length
      ? card.authors.map(function(a){ return { name: (a && a.name) || '', email: (a && a.email) || '', isNew: !(a && a.email && personByEmail(a.email)) }; })
      : [{ name: '', email: '', isNew: false }];
    renderAuthorRows('eAuthorsWrap', eAuthorsState, submitOnEnter, authorsLock);
    // #eAddAuthor doesn't exist in the markup at all when locked (see
    // above) — nothing to wire up.
    var addAuthorBtn = document.getElementById('eAddAuthor');
    if (addAuthorBtn) addAuthorBtn.addEventListener('click', function(){
      eAuthorsState.splice(Math.max(eAuthorsState.length - 1, 0), 0, { name: '', email: '', isNew: false });
      renderAuthorRows('eAuthorsWrap', eAuthorsState, submitOnEnter, authorsLock);
    });
    document.getElementById('eTitle').focus();
  }

  function onSaveEdit(cardId){
    var boardId = state.currentBoardId;
    var now = Date.now();
    var card = state.cards.filter(function(c){ return c.id === cardId; })[0];
    if (!card) return;
    var errorEl = document.getElementById('editFormError');

    var title = document.getElementById('eTitle').value.trim();
    var authors = authorsForSave(eAuthorsState);
    var overleafLink = document.getElementById('eOverleaf').value.trim();
    var email = document.getElementById('eEmail').value.trim();

    var authorsIssue = authorRowsIssue(eAuthorsState);
    if (!title || authorsIssue || !overleafLink || !email){
      errorEl.textContent = authorsIssue || 'Please fill in the required fields above.';
      errorEl.hidden = false;
      return;
    }
    if (document.getElementById('eAbstract').value.trim().length > ABSTRACT_MAX_CHARS){
      errorEl.textContent = 'The abstract can be at most ' + ABSTRACT_MAX_CHARS + ' characters.';
      errorEl.hidden = false;
      return;
    }
    var overleafIssue = overleafLinkIssue(overleafLink);
    if (overleafIssue){
      errorEl.textContent = overleafIssue;
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;
    // submittedBy is deliberately not editable here — it's who registered
    // the paper (used by Security Rules for card authorization), not a
    // free-text field to reassign after the fact. Not included in updates,
    // so it stays whatever it already was on the card. authors/
    // authorEmails follow the same pattern once authorsLocked(card) is
    // true (2026-09-14) — the UI already disables every author control at
    // that point (openEditModal), this is the belt-and-braces backstop:
    // even if `authors` somehow computed to something else, omitting the
    // keys entirely means the write literally can't touch them, same
    // shape as every other "field simply isn't in updates" lock in this
    // file.
    var locked = authorsLocked(card, getCurrentBoard());
    var updates = {
      title: title,
      overleafLink: overleafLink,
      abstractText: document.getElementById('eAbstract').value.trim(),
      correspondingAuthorEmail: email,
      computeEstimate: document.getElementById('eCompute').value.trim(),
      pitchLink: document.getElementById('ePitchLink').value.trim(),
      submissionLink: document.getElementById('eSubmissionLink').value.trim(),
      arxivLink: document.getElementById('eArxivLink').value.trim(),
      rebuttalDeadline: document.getElementById('eRebuttalDeadline').value || null,
      rebuttalDocLink: document.getElementById('eRebuttalDoc').value.trim(),
      cameraReadyLink: document.getElementById('eCameraReadyLink').value.trim(),
      reviewNotes: document.getElementById('eReviewNotes').value.trim(),
      outcome: document.getElementById('eOutcome').value,
      updatedAt: now
    };
    if (!locked){
      updates.authors = authors;
      updates.authorEmails = authorEmailsOf(authors);
      // Senior reviewer defaults to the PI (the last author) the first
      // time authors are actually saved — deferred here from onAddCard
      // (2026-09-18, per Eduardo), since authors don't exist yet at
      // registration any more. Only fires while nothing's been assigned
      // yet, same as the old onAddCard default: once a senior reviewer
      // is picked (here or via reviewerInputHtml), saving authors again
      // never overwrites that choice.
      if (!card.reviewers || !card.reviewers.senior){
        var prevReviewers = card.reviewers || { junior: '', senior: '' };
        updates.reviewers = { junior: prevReviewers.junior || '', senior: (authors.length ? authors[authors.length - 1].email : '') || '' };
      }
    }
    // Only what they changed; asks first if someone else changed it too meanwhile.
    var change = formChange('edit', cardId, updates);
    if (!change) return;
    var prev = change.prev;
    state.cards = change.next;
    closeModal();
    renderBoard();
    saveBoard(boardId, { cards: change.mine }, change.base).then(function(ok){
      if (!ok){
        state.cards = prev;
        renderBoard();
        showToast(saveErrorMessage('Could not save changes \u2014 try again.'), 'error');
      } else {
        showToast('Saved.', 'ok');
      }
    });
  }

