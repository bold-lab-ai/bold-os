"use strict";

  // ---------- modal ----------

  // ---------- dynamic author rows (Edit fields) ----------
  // Array of in-progress { name, email, isNew } rows, reset each time the
  // Edit-fields modal opens (authors aren't collected at registration any
  // more — see onAddCard's own comment; they're added here instead, at
  // Submit the abstract). Authors resolve to a real person's email via
  // the roster picker (2026-09-12) — same as reviewers (reviewerInputHtml)
  // — with a "+ New author" escape hatch (typed Name + Email) for someone
  // genuinely outside the Slack workspace. Used to be free text; every
  // feature that needs a real identity to act on (notifications chief
  // among them) needs a real email to reach someone, which a free-text
  // name can never reliably give. `isNew` is UI-only (which control this
  // row shows) — stripped before the row is ever saved, see onSaveEdit.
  var eAuthorsState = [{ name: '', email: '', isNew: false }];

  // `locked` (2026-09-14, see authorsLocked) disables every control and
  // drops Remove/"Pick from list instead" entirely rather than just
  // greying them out — nothing about this row is actionable once
  // authors are fixed, so there's no half-interactive state to represent.
  function authorRowsHtml(rows, locked){
    return rows.map(function(row, i){
      var isPi = i === rows.length - 1;
      var label = isPi ? 'PI' : ('Author ' + (i + 1));
      var html = '<div class="author-row">' +
        '<span class="author-pi-tag' + (isPi ? '' : ' author-pi-tag--hidden') + '">PI</span>';
      // Wording corrected 2026-09-14+1 — stale since the "locked strictly
      // AFTER abstract review, not during" fix: this used to say "once
      // Abstract Reviewed is reached", which stopped being true the
      // moment that fix shipped. Kept label-agnostic (not "once past
      // Abstract Reviewed"/"Abstract Submitted") rather than threading
      // `board` all the way through renderAuthorRows just to pick the
      // right one via statusLabelFor.
      var lockAttr = locked ? ' disabled title="Authors are locked once the abstract is submitted"' : '';
      if (row.isNew){
        html +=
          '<input type="text" class="author-input author-new-name" data-author-idx="' + i + '" value="' + escapeHtml(row.name) + '" placeholder="Name" aria-label="' + label + ' name"' + lockAttr + '>' +
          '<input type="email" class="author-input author-new-email" data-author-idx="' + i + '" value="' + escapeHtml(row.email) + '" placeholder="Email" aria-label="' + label + ' email"' + lockAttr + '>' +
          (locked ? '' : '<button type="button" class="btn-text author-use-roster" data-author-idx="' + i + '">Pick from list instead</button>');
      } else {
        var options = '<option value="">Choose a person…</option>' + state.people.map(function(p){
          return '<option value="' + escapeHtml(p.email) + '"' + (p.email === row.email ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>';
        }).join('') + '<option value="__new__">+ New author (not in the workspace)…</option>';
        html += '<select class="author-input author-select" data-author-idx="' + i + '" aria-label="' + label + '"' + lockAttr + '>' + options + '</select>';
      }
      html += (!locked && rows.length > 1 ? '<button type="button" class="btn-text danger author-remove" data-remove-author-idx="' + i + '">Remove</button>' : '') +
      '</div>';
      return html;
    }).join('');
  }

  // Used by the Edit-fields modal (eAuthorsState / #eAuthorsWrap) — the
  // registration modal doesn't collect authors any more (see onAddCard).
  // `locked`: see authorRowsHtml — when true, the rows render read-only
  // and nothing below is worth wiring up at all (every listener target
  // is disabled or simply absent from the markup). `onChange` (2026-09-14
  // +1, optional): called every time this function actually (re)renders —
  // i.e. after any structural change to `rows` (add/remove/select/"use
  // roster"), since every one of those funnels through a call back into
  // this same function.
  function renderAuthorRows(wrapId, rows, onEnter, locked, onChange){
    var wrap = document.getElementById(wrapId);
    if (!wrap) return;
    wrap.innerHTML = authorRowsHtml(rows, locked);
    if (onChange) onChange();
    if (locked) return;
    Array.prototype.forEach.call(wrap.querySelectorAll('.author-select'), function(sel){
      sel.addEventListener('change', function(){
        var idx = Number(sel.getAttribute('data-author-idx'));
        if (sel.value === '__new__'){
          rows[idx] = { name: '', email: '', isNew: true };
        } else {
          var p = personByEmail(sel.value);
          rows[idx] = { name: p ? p.name : '', email: sel.value, isNew: false };
        }
        renderAuthorRows(wrapId, rows, onEnter, locked, onChange);
      });
    });
    Array.prototype.forEach.call(wrap.querySelectorAll('.author-new-name'), function(inp){
      inp.addEventListener('input', function(){
        rows[Number(inp.getAttribute('data-author-idx'))].name = inp.value;
      });
      if (onEnter) inp.addEventListener('keydown', function(ev){ if (ev.key === 'Enter'){ ev.preventDefault(); onEnter(ev); } });
    });
    Array.prototype.forEach.call(wrap.querySelectorAll('.author-new-email'), function(inp){
      inp.addEventListener('input', function(){
        rows[Number(inp.getAttribute('data-author-idx'))].email = inp.value;
      });
      if (onEnter) inp.addEventListener('keydown', function(ev){ if (ev.key === 'Enter'){ ev.preventDefault(); onEnter(ev); } });
    });
    Array.prototype.forEach.call(wrap.querySelectorAll('.author-use-roster'), function(btn){
      btn.addEventListener('click', function(){
        rows[Number(btn.getAttribute('data-author-idx'))] = { name: '', email: '', isNew: false };
        renderAuthorRows(wrapId, rows, onEnter, locked, onChange);
      });
    });
    Array.prototype.forEach.call(wrap.querySelectorAll('.author-remove'), function(btn){
      btn.addEventListener('click', function(){
        rows.splice(Number(btn.getAttribute('data-remove-author-idx')), 1);
        renderAuthorRows(wrapId, rows, onEnter, locked, onChange);
      });
    });
  }

  // Strip the row's UI-only isNew flag and drop wholly-empty rows before
  // saving — mirrors the old rawAuthors.filter(Boolean) behavior for the
  // new object shape. The last row (the PI) still has to be filled in;
  // callers check that separately before this runs.
  function authorsForSave(rows){
    return rows
      .map(function(r){ return { name: (r.name || '').trim(), email: (r.email || '').trim() }; })
      .filter(function(r){ return r.name || r.email; });
  }

  // Denormalized alongside `authors` (2026-09-12, see bold-os#3)
  // purely so a Cloud Function can query "papers this person is an author
  // on" across every venue — Firestore's array-contains can only match a
  // primitive value, not a partial match inside {name,email} objects, so
  // authors itself can't be queried directly. Client-side rendering never
  // reads this field; it exists only for that one server-side query.
  function authorEmailsOf(authors){
    return authors.map(function(a){ return a.email; }).filter(Boolean);
  }

  // Shared validation for both the registration and Edit-fields author
  // rows — same two checks either way: the last row (the PI slot) has to
  // be a real, complete entry, not just non-blank, and no OTHER row can be
  // half-filled (a name typed with no email, or vice versa — only
  // possible in "+ New author" mode, since picking from the roster always
  // sets both fields together). Returns a reason string to show, or null
  // if the rows are good to save.
  function authorRowsIssue(rows){
    function complete(r){ return !!(r && r.name && r.name.trim()) && !!(r && r.email && r.email.trim()); }
    function blank(r){ return !(r && r.name && r.name.trim()) && !(r && r.email && r.email.trim()); }
    var piRow = rows[rows.length - 1];
    if (!complete(piRow)) return 'The last author (the PI) needs both a name and an email.';
    if (rows.some(function(r){ return !blank(r) && !complete(r); })) return 'Each author needs both a name and an email — finish or remove any half-filled row.';
    return null;
  }

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

  // Registration-form draft autosave (2026-09-14+1) \u2014 reported by a user:
  // "I lose the fields I've filled out if the page refreshes... I already
  // had to fill it out a couple of times." Nothing in this app ever
  // reloads the page itself (loadInitialData/onAuthStateChanged re-render
  // in place, they never navigate \u2014 see their own comments), so losing an
  // in-progress form has to be the BROWSER reloading the tab out from
  // under it (a backgrounded tab is exactly when mobile browsers do that \u2014
  // "double checking the title, coauthors emails, etc." reads as switching
  // away and back). Nothing client-side can stop that outright, but the
  // form's contents don't have to die with it: every change is mirrored to
  // localStorage (not sessionStorage \u2014 a real reload, or even fully
  // closing and reopening the tab, should still find it) under a key
  // scoped to this venue AND this signed-in person, so switching venues or
  // accounts on the same browser never surfaces someone else's stray
  // draft. Cleared only on a successful Submit (onAddCard) \u2014 closing the
  // modal any other way (Cancel, clicking outside, a real reload) leaves
  // it in place, restored next time "Register a paper" is opened.
  function registerDraftKey(boardId){
    var email = state.currentUser && state.currentUser.email;
    return 'airb-draft-register:' + boardId + ':' + (email || '');
  }
  function saveRegisterDraft(boardId){
    try {
      var titleEl = document.getElementById('pTitle');
      if (!titleEl) return; // modal already closed \u2014 nothing to save
      var title = titleEl.value;
      var computeEstimate = document.getElementById('pCompute').value;
      var note = document.getElementById('pNote').value;
      // Nothing typed yet (including the very first render of a brand-new
      // modal) \u2014 don't create a draft out of thin air, and if a real
      // draft was just emptied back out by hand, clear it rather than
      // leaving a stale entry no longer reflected on screen.
      if (!title.trim() && !computeEstimate.trim() && !note.trim()){
        clearRegisterDraft(boardId);
        return;
      }
      var draft = {
        title: title,
        computeEstimate: computeEstimate,
        note: note,
        savedAt: Date.now()
      };
      localStorage.setItem(registerDraftKey(boardId), JSON.stringify(draft));
    } catch (e){ /* private-mode/quota errors \u2014 losing autosave silently beats crashing the form */ }
  }
  function loadRegisterDraft(boardId){
    try {
      var raw = localStorage.getItem(registerDraftKey(boardId));
      return raw ? JSON.parse(raw) : null;
    } catch (e){ return null; }
  }
  function clearRegisterDraft(boardId){
    try { localStorage.removeItem(registerDraftKey(boardId)); } catch (e){}
  }

  function openModal(){
    if (!requireSignedIn()) return;
    var current = getCurrentBoard();
    var draft = loadRegisterDraft(current && current.id);
    if (current && current.status === 'pending'){
      showToast('This venue hasn’t been approved yet.', 'error');
      return;
    }
    els.modalRegion.innerHTML =
      '<div class="modal-overlay" id="modalOverlay">' +
        '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">' +
          '<h2 id="modalTitle">Register paper for review</h2>' +
          '<div id="paperForm">' +
            '<div style="font-size:12px;color:var(--muted);margin-bottom:14px;">Registering as ' +
              escapeHtml(state.currentUser.name || state.currentUser.email) + ' (' + escapeHtml(state.currentUser.email) + ') \u2014 used as the submitter and corresponding author.</div>' +
            (draft ? '<div id="draftNotice" style="font-size:12px;color:var(--accent);background:var(--accent-dim);padding:6px 10px;border-radius:var(--radius);margin-bottom:14px;">Restored your unsaved draft from ' + formatTimestamp(draft.savedAt) + ' \u2014 <button type="button" class="btn-text" id="discardDraft" style="font-size:inherit;">Discard</button></div>' : '') +
            '<div class="field"><label for="pTitle">Paper title</label><input type="text" id="pTitle" value="' + escapeHtml((draft && draft.title) || '') + '"></div>' +
            '<div class="field"><label for="pCompute">Compute estimate</label><input type="text" id="pCompute" placeholder="e.g. ~2000 A100-hours" value="' + escapeHtml((draft && draft.computeEstimate) || '') + '">' +
              '<div style="font-size:12px;color:var(--muted);margin-top:4px;">Required at registration (8 weeks out)</div></div>' +
            '<div class="field"><label for="pNote">Note for the reviewers (optional)</label><textarea id="pNote" placeholder="Anything they should know">' + escapeHtml((draft && draft.note) || '') + '</textarea></div>' +
            '<div style="font-size:12px;color:var(--muted);margin-bottom:14px;">Authors and the Overleaf link come later, at Submit the abstract &mdash; there’s no first draft yet to point to.</div>' +
            '<div class="field-error" id="paperFormError" hidden>Please fill in the required fields above.</div>' +
            '<div class="modal-actions">' +
              '<button class="btn" type="button" id="cancelModal">Cancel</button>' +
              '<button class="btn btn-primary" type="button" id="submitCardBtn">Submit</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.getElementById('cancelModal').addEventListener('click', closeModal);
    document.getElementById('modalOverlay').addEventListener('click', function(e){
      if (e.target.id === 'modalOverlay') closeModal();
    });
    document.getElementById('submitCardBtn').addEventListener('click', onAddCard);
    ['pTitle', 'pCompute'].forEach(function(id){
      document.getElementById(id).addEventListener('keydown', function(ev){
        if (ev.key === 'Enter'){ ev.preventDefault(); onAddCard(ev); }
      });
    });
    // Draft autosave (2026-09-14+1) — see saveRegisterDraft's own comment.
    // One delegated listener covers every text field on the form.
    document.getElementById('paperForm').addEventListener('input', function(){ saveRegisterDraft(current.id); });
    var discardBtn = document.getElementById('discardDraft');
    if (discardBtn) discardBtn.addEventListener('click', function(){
      clearRegisterDraft(current.id);
      openModal(); // cheapest way to reset every field back to blank
    });
    document.getElementById('pTitle').focus();
  }

  function closeModal(){ els.modalRegion.innerHTML = ''; }

  function openEditModal(cardId){
    var card = state.cards.filter(function(c){ return c.id === cardId; })[0];
    if (!card) return;
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
            '<div class="field"><label for="eAbstract">Abstract</label><textarea id="eAbstract" placeholder="Paste the abstract text. LaTeX is fine, typed as plain text: $inline formula$ or $$block formula$$.">' + escapeHtml(card.abstractText || '') + '</textarea></div>' +
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
    var next = state.cards.map(function(c){
      if (c.id !== cardId) return c;
      return Object.assign({}, c, updates);
    });
    var prev = state.cards;
    state.cards = next;
    closeModal();
    renderBoard();
    saveBoard(boardId, { cards: next }).then(function(ok){
      if (!ok){
        state.cards = prev;
        renderBoard();
        showToast(saveErrorMessage('Could not save changes \u2014 try again.'), 'error');
      } else {
        showToast('Saved.', 'ok');
      }
    });
  }

