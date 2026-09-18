"use strict";


  // Every real Submit moment in the pipeline — external, irreversible
  // self-reports (see SUBMIT_CONFIRM_MESSAGES below), so all get the
  // confirm-before-click prompt and the green accept-styled button.
  // Expanded 2026-09-18 from just the two (Submit abstract/paper) to one
  // per stage that has a real deliverable — see advanceBlockReason's own
  // comment for the matching link-required gate each of these pairs
  // with. Keyed by the CURRENT status (the one being left, i.e. the one
  // whose deliverable this button submits), not the target. Mostly one
  // shared map for both pipelines — Rush mode visits the same stages in
  // the same relative order (see RUSH_STATUS_ORDER), nothing Rush-specific
  // to override here — EXCEPT `register`, the one stage whose immediate
  // next column actually differs by pipeline (Pitch in full, Abstract in
  // Rush, which skips Pitch entirely): that key is intentionally left out
  // of this map and resolved dynamically in moveButtonsInnerHtml instead
  // (2026-09-18+6, per Eduardo — fixing a real bug where Rush mode's
  // Registered column always said "Submit pitch" even though the button
  // actually submitted straight into Abstract). No `abstract` entry here
  // either, same reason as `register` — its button reads "Submit paper"
  // too now (2026-09-18+7), but it's still not a real Submit (no confirm
  // dialog, no green styling — it's a plain move gated only by the senior
  // reviewer's approval, advanceBlockReason's abstractReviewState check)
  // and that label must not collide with THIS map's own `paper` entry
  // below, a completely different action (the real external venue
  // submission) that happens to want the same three words — see
  // moveButtonsInnerHtml's rgtLabel/rgtConfirmKey for how the two stay
  // independent. `paper` itself was reinstated in its place (2026-09-18+4,
  // moved from `abstract`) — same "Submit paper" action as always, just
  // addressed by its own status key again now that `paper` is its own
  // stage.
  var ADVANCE_LABELS = {
    pitch: 'Submit abstract',
    paper: 'Submit paper',
    rebuttal: 'Submit rebuttal',
    camera_ready: 'Submit camera-ready'
  };

  // Confirmation copy for the move buttons that actually submit something
  // (as opposed to a plain internal-pipeline Advance) — these are the ones
  // worth a second thought before the click registers. Keyed by the exact
  // button label from ADVANCE_LABELS above; a label with no entry here
  // skips confirmation.
  var SUBMIT_CONFIRM_MESSAGES = {
    'Submit pitch': 'Are you sure you want to submit your pitch materials? This action cannot be undone.',
    'Submit abstract': 'Are you sure you want to submit your abstract for internal review? This action cannot be undone.',
    'Submit paper': 'Are you sure you want to submit your paper to the venue? This action cannot be undone.',
    'Submit rebuttal': 'Are you sure you want to submit your rebuttal? This action cannot be undone.',
    'Submit camera-ready': 'Are you sure you want to submit the camera-ready version? This action cannot be undone.'
  };

  // Shared gate for every [data-move] click handler below — returns false
  // (and blocks the move) only if the button is a submit move the user
  // just declined via the confirm() prompt; anything else passes through.
  function confirmMoveIfSubmit(label){
    var msg = SUBMIT_CONFIRM_MESSAGES[label];
    return !msg || window.confirm(msg);
  }

  // The Revert / Advance-or-Submit button pair shown wherever a card can
  // be moved — the compact kanban card, the detail page, and the
  // checklist partial re-render each rendered this same pair independently
  // until now (2026-09-14) — exactly how the onChangeStatus
  // order-awareness bug slipped into only some of them and not others (see
  // its own commit). One shared function now, used everywhere.
  //
  // The rgt (Advance/Submit) gate always runs advanceBlockReason first,
  // unchanged — that still carries e.g. the "assign a junior and a senior
  // reviewer first" check on entering `abstract` either way. Submit paper
  // (leaving `paper`, for `rebuttal`) ALSO checks abstractAcceptBlockReason
  // on top of that (authors present + nobody over the per-author cap) —
  // now applies in both pipelines (2026-09-18: used to be Rush-mode-only,
  // but nothing in that check was ever actually Rush-specific — a
  // canonical paper shouldn't blow the venue's per-author cap either).
  // Every plain Advance is unaffected, still just advanceBlockReason.
  // Just the two <button> elements, no wrapping .card-move div — for the
  // one call site (onToggleChecklist's partial re-render) that already has
  // its hands on that div directly and only needs to replace what's inside
  // it. moveButtonsHtml below is the version everyone else wants.
  function moveButtonsInnerHtml(card, board){
    var effective = displayStatus(card, board);
    var order = effectiveStatusOrder(board);
    var lft = statusAt(effective, -1, order);
    var rgt = statusAt(effective, 1, order);
    // register isn't in ADVANCE_LABELS — its label depends on which
    // pipeline is active (see that map's own comment): "Submit pitch" in
    // the full pipeline, but "Submit abstract" in Rush mode, since Rush
    // skips Pitch and goes straight from Register to Abstract.
    var rgtLabel = effective === 'register'
      ? (rgt === 'pitch' ? 'Submit pitch' : 'Submit abstract')
      // Leaving `abstract` now reads "Submit paper" too (2026-09-18+7,
      // per Eduardo — urgent: make it obvious, right on the project page,
      // that this is the button an author clicks once the senior
      // reviewer has approved the abstract). Still the same plain move
      // it always was otherwise, gated only by advanceBlockReason's own
      // abstractReviewState check just below — see rgtConfirmKey right
      // after for how it avoids colliding with the OTHER "Submit paper"
      // button (leaving `paper`, the real external venue submission).
      : effective === 'abstract' ? 'Submit paper'
      : (ADVANCE_LABELS[effective] || 'Advance');
    // Normally identical to rgtLabel — what SUBMIT_CONFIRM_MESSAGES (and
    // so the confirm-before-click prompt and green accept styling) is
    // keyed by. Leaving `abstract` is the one exception: its button reads
    // "Submit paper" too now, but must NOT pick up the confirm dialog
    // that belongs to the OTHER "Submit paper" button (leaving `paper`,
    // about submitting externally to the venue) just because the two
    // happen to share display text. A key with no SUBMIT_CONFIRM_MESSAGES
    // entry keeps this one unconfirmed, same as before.
    var rgtConfirmKey = effective === 'abstract' ? 'abstract-approved-advance' : rgtLabel;
    var rgtBlockReason = rgt && (advanceBlockReason(card, rgt, board) ||
      (effective === 'paper' ? abstractAcceptBlockReason(card, board, state.cards) : null));
    // Green treatment covers every real Submit (SUBMIT_CONFIRM_MESSAGES' keys).
    var acceptClass = SUBMIT_CONFIRM_MESSAGES[rgtConfirmKey] ? ' card-move-btn-accept' : '';
    // Revert button experimentally removed (2026-09-16, per Eduardo) — lft
    // is still computed above since advanceBlockReason/statusAt etc. don't
    // need to change, and reinstating the button is a one-line add-back.
    var html = '<button class="card-move-btn' + acceptClass + '" type="button" data-move="' + escapeHtml(card.id) + '" data-move-to="' + (rgt || '') + '" data-move-label="' + escapeHtml(rgtConfirmKey) + '"' + (rgt && !rgtBlockReason ? '' : ' disabled') + (rgtBlockReason ? ' title="' + escapeHtml(rgtBlockReason) + '"' : (rgt ? ' title="Move to ' + escapeHtml(statusLabelFor(rgt, board)) + '"' : '')) + '>' + escapeHtml(rgtLabel) + ' &rarr;</button>';
    return html;
  }

  function moveButtonsHtml(card, board){
    return '<div class="card-move">' + moveButtonsInnerHtml(card, board) + '</div>';
  }

  // Inline "Submit the abstract" state — the project page's own copy of
  // author rows, separate from the Edit-fields modal's eAuthorsState (so
  // both could in principle be live at once without clobbering each
  // other), reset fresh every time abstractSubmissionFieldsHtml's markup
  // is (re)rendered — see renderCardDetail's own init right after it sets
  // els.boardRegion.innerHTML, same pattern openEditModal uses for
  // eAuthorsState/#eAuthorsWrap.
  var stageAuthorsState = [];

  // The project page's own inline "Submit the abstract" form
  // (2026-09-18+9/+10, per Eduardo) — shown only while that's genuinely
  // the next thing to do (rgt === 'abstract': Register in Rush mode, or
  // Pitch in the full pipeline) and something's still missing, so an
  // author can fill in every real requirement for it without leaving this
  // page for the Edit-fields modal. A plain section, not a checklist and
  // not the warning-coloured .gate-banner treatment — this isn't telling
  // the author they did something wrong, just showing the form.
  //
  // Co-authors reuse the Edit-fields modal's own authorRowsHtml/
  // renderAuthorRows (roster picker, "+ New author" toggle, PI tagging)
  // via stageAuthorsState/#stageAuthorsWrap rather than a bare input —
  // that UI is real product surface worth keeping, not something to
  // crudely re-implement here. Overleaf link and the abstract text are
  // plain fields, same `.field` markup and sizing the modal already uses
  // (global input/textarea styling, not scoped to `.modal`). Reviewers
  // aren't part of this form — a working inline picker for them already
  // exists further down this same page (reviewerInputHtml, guideline 7).
  // Stays visible even once authors/Overleaf link/abstract text are all
  // present (2026-09-18+12, per Eduardo — was previously hidden at that
  // point, but that meant Submit, below, could never actually be reached
  // in its enabled state) — only actually disappears once the card
  // genuinely leaves this transition (rgt !== 'abstract' any more, i.e.
  // the move has really happened). Also hidden entirely from a viewer who
  // isn't an author on this card (2026-09-18+11, per Eduardo — these are
  // the only users who can actually fill them in) — see
  // canManageAuthorFields for the bootstrap case (nobody's a listed
  // author yet the very first time this form has anything to do).
  //
  // Two separate actions (2026-09-18+12, per Eduardo — Save must not
  // itself submit the abstract): Save (data-stage-fields-save,
  // onSaveAbstractFields) only writes the three fields to the card, never
  // touches status. Submit is the REAL "Submit pitch"/"Submit abstract"
  // move — same data-move/data-move-to/data-move-label attributes the top
  // .detail-controls move button uses, so it's picked up by that same
  // existing [data-move] click listener (confirmMoveIfSubmit, then
  // onChangeStatus) rather than needing its own handler, and gets the
  // identical confirm-dialog/gating behavior. Always exactly "Submit
  // abstract" here (never "Submit pitch"): this function only renders
  // while rgt === 'abstract', and moveButtonsInnerHtml's own branching
  // shows that whenever THAT'S true — whether the card is actually at
  // `register` in Rush mode (which skips Pitch) or at `pitch` in the full
  // pipeline — the real label is always "Submit abstract", never "Submit
  // pitch" (that label only appears when rgt is 'pitch' instead). Disabled
  // (with the real reason as its tooltip) until advanceBlockReason clears
  // every requirement for entering Abstract — not just these three fields,
  // also reviewer assignment (Review section) — the same single source of
  // truth the top button's own disabled state already uses, so "all
  // fields have been completed" can't drift out of sync with what
  // actually gates the move.
  function abstractSubmissionFieldsHtml(card, board){
    var effective = displayStatus(card, board);
    var rgt = statusAt(effective, 1, effectiveStatusOrder(board));
    if (rgt !== 'abstract') return '';
    if (!canManageAuthorFields(card)) return '';
    var blockReason = advanceBlockReason(card, 'abstract', board);
    return '<div class="stage-fields" id="stageAbstractFields">' +
      '<h3 class="detail-subhead">Submit the abstract</h3>' +
      '<div class="field"><label for="stageAuthorsWrap">Co-authors</label><div id="stageAuthorsWrap"></div>' +
        '<button class="btn-text" type="button" id="stageAddAuthor">+ Add author</button>' +
        '<div style="font-size:12px;color:var(--muted);margin-top:4px;">In author order — the last one is the PI.</div>' +
      '</div>' +
      '<div class="field"><label for="stageOverleaf">Overleaf link</label><input type="url" id="stageOverleaf" value="' + escapeHtml(card.overleafLink || '') + '" placeholder="https://www.overleaf.com/project/… — must allow edit access, not just view"></div>' +
      '<div class="field"><label for="stageAbstractText">Abstract</label><textarea id="stageAbstractText" placeholder="Paste the abstract text. LaTeX is fine, typed as plain text: $inline formula$ or $$block formula$$.">' + escapeHtml(card.abstractText || '') + '</textarea></div>' +
      '<div class="field-error" id="stageFieldsError" hidden></div>' +
      '<div class="stage-fields-actions">' +
        '<button class="btn" type="button" data-stage-fields-save="' + escapeHtml(card.id) + '">Save</button>' +
        '<button class="btn btn-primary" type="button" data-move="' + escapeHtml(card.id) + '" data-move-to="abstract" data-move-label="Submit abstract"' +
          (blockReason ? ' disabled title="' + escapeHtml(blockReason) + '"' : ' title="Move to ' + escapeHtml(statusLabelFor('abstract', board)) + '"') + '>Submit</button>' +
        // The button's own `title` above isn't a reliable way to see why
        // it's disabled — browsers generally don't fire hover/title
        // tooltips on disabled elements — so the same reason is repeated
        // here as plain visible text (2026-09-18+15, found by Eduardo:
        // clicking a disabled Submit here did nothing with no visible
        // explanation at all, since .btn/.btn-primary also had no
        // :disabled styling until this same fix — see audit-board.css).
        (blockReason ? '<span class="stage-fields-hint">' + escapeHtml(blockReason) + '</span>' : '') +
      '</div>' +
    '</div>';
  }

  // Saves the whole inline "Submit the abstract" form in one go
  // (2026-09-18+9/+10) — same fields, same validation (authorRowsIssue,
  // overleafLinkIssue, a plain non-empty check on the abstract) and the
  // same optimistic-update/rollback shape onSaveEdit uses for the
  // Edit-fields modal, just scoped to these three fields and this page's
  // own inputs/state instead of the modal's.
  function onSaveAbstractFields(cardId){
    var boardId = state.currentBoardId;
    var card = state.cards.filter(function(c){ return c.id === cardId; })[0];
    if (!card) return;
    var errorEl = document.getElementById('stageFieldsError');
    var authors = authorsForSave(stageAuthorsState);
    var overleafLink = document.getElementById('stageOverleaf').value.trim();
    var abstractText = document.getElementById('stageAbstractText').value.trim();

    var authorsIssue = authorRowsIssue(stageAuthorsState);
    if (authorsIssue || !overleafLink || !abstractText){
      errorEl.textContent = authorsIssue || 'Please fill in every field above.';
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
    var prev = state.cards;
    var patch = {
      authors: authors,
      authorEmails: authorEmailsOf(authors),
      overleafLink: overleafLink,
      abstractText: abstractText,
      updatedAt: Date.now()
    };
    // Senior reviewer defaults to the PI the first time authors are
    // actually saved — same behavior/rationale as onSaveEdit.
    if (!card.reviewers || !card.reviewers.senior){
      var prevReviewers = card.reviewers || { junior: '', senior: '' };
      patch.reviewers = { junior: prevReviewers.junior || '', senior: (authors.length ? authors[authors.length - 1].email : '') || '' };
    }
    var next = state.cards.map(function(c){ return c.id === cardId ? Object.assign({}, c, patch) : c; });
    state.cards = next;
    renderCardDetail();
    saveBoard(boardId, { cards: next }).then(function(ok){
      if (!ok){
        state.cards = prev;
        renderCardDetail();
        showToast(saveErrorMessage('Could not save — try again.'), 'error');
      } else {
        showToast('Saved.', 'ok');
      }
    });
  }

  // The project page's own inline "Submit the paper" control
  // (2026-09-18+14, per Eduardo — same pattern as Submit the abstract
  // above, extended to the Paper stage). The Format checklist itself
  // (ticked by any co-author) already renders right above this in the
  // Author section (authorChecklistTabHtml, see renderCardDetail) — the
  // one author-side requirement for leaving Paper that never had an
  // inline field anywhere on this page is the venue submission link
  // (card.submissionLink), previously only settable via the Edit-fields
  // modal. This adds that field plus the real Submit control, right next
  // to the checklist that has to be finished before it can actually be
  // used.
  //
  // Shown only at the Paper stage, only to an author (canManageAuthorFields
  // — same helper/reasoning as abstractSubmissionFieldsHtml: this is a
  // field only an author usefully fills in). Stays visible for as long as
  // the card sits at Paper — not hidden once submissionLink is filled in
  // — same reasoning as the abstract form: hiding it the moment the field
  // is complete would make Submit unreachable in its enabled state; it
  // only disappears once the card actually leaves Paper. Submit reuses
  // the same data-move/data-move-to/data-move-label attributes and shared
  // [data-move] click handler the top .detail-controls button already
  // uses — identical confirm dialog (SUBMIT_CONFIRM_MESSAGES['Submit
  // paper']) and green accept styling, and the identical gate
  // moveButtonsInnerHtml's own rgtBlockReason already computes for that
  // top button (advanceBlockReason PLUS abstractAcceptBlockReason, the
  // per-author-cap check) — so "ready to submit" can't drift out of sync
  // between the two buttons.
  function paperSubmissionFieldsHtml(card, board){
    if (card.status !== 'paper') return '';
    if (!canManageAuthorFields(card)) return '';
    var blockReason = advanceBlockReason(card, 'rebuttal', board) || abstractAcceptBlockReason(card, board, state.cards);
    return '<div class="stage-fields" id="stagePaperFields">' +
      '<h3 class="detail-subhead">Submit the paper</h3>' +
      '<div class="field"><label for="stageSubmissionLink">Submission link</label><input type="url" id="stageSubmissionLink" value="' + escapeHtml(card.submissionLink || '') + '" placeholder="Link to your venue submission (e.g. OpenReview)"></div>' +
      '<div class="field-error" id="stagePaperFieldsError" hidden></div>' +
      '<div class="stage-fields-actions">' +
        '<button class="btn" type="button" data-stage-paper-save="' + escapeHtml(card.id) + '">Save</button>' +
        '<button class="btn btn-primary" type="button" data-move="' + escapeHtml(card.id) + '" data-move-to="rebuttal" data-move-label="Submit paper"' +
          (blockReason ? ' disabled title="' + escapeHtml(blockReason) + '"' : ' title="Move to ' + escapeHtml(statusLabelFor('rebuttal', board)) + '"') + '>Submit</button>' +
        // Same visible-text fallback as abstractSubmissionFieldsHtml —
        // see its own comment (2026-09-18+15): a disabled button's title
        // isn't a reliable tooltip.
        (blockReason ? '<span class="stage-fields-hint">' + escapeHtml(blockReason) + '</span>' : '') +
      '</div>' +
    '</div>';
  }

  // Saves just the submission link (2026-09-18+14) — same
  // optimistic-update/rollback shape as onSaveAbstractFields/
  // onSetAbstractReview, scoped to this one field. Rejects a blank save,
  // same as onSaveAbstractFields — a requirement can't be satisfied by an
  // empty string.
  function onSavePaperSubmissionLink(cardId){
    var boardId = state.currentBoardId;
    var card = state.cards.filter(function(c){ return c.id === cardId; })[0];
    if (!card) return;
    var errorEl = document.getElementById('stagePaperFieldsError');
    var value = document.getElementById('stageSubmissionLink').value.trim();
    if (!value){
      if (errorEl){ errorEl.textContent = 'Can’t be blank.'; errorEl.hidden = false; }
      return;
    }
    if (errorEl) errorEl.hidden = true;
    var prev = state.cards;
    var next = state.cards.map(function(c){ return c.id === cardId ? Object.assign({}, c, { submissionLink: value, updatedAt: Date.now() }) : c; });
    state.cards = next;
    renderCardDetail();
    saveBoard(boardId, { cards: next }).then(function(ok){
      if (!ok){
        state.cards = prev;
        renderCardDetail();
        showToast(saveErrorMessage('Could not save — try again.'), 'error');
      } else {
        showToast('Saved.', 'ok');
      }
    });
  }

  // Forward-migrate a stored card: since-split status keys; older checklist
  // shapes (single `checked`, `author`/`auditor` pair, or the dropped
  // author/junior/senior triple) into the junior/senior pair — old `auditor`
  // maps to `senior`, the old `author` pass is discarded. Also ensure the
  // `reviewers` field exists (migrating a legacy single `assignedTo`).
  // Old statuses that named a review sub-state or an outcome directly —
  // both are now separate fields (changesRequested, outcome) rather than a
  // column, so a card saved under one of these needs that field set, not
  // just its status remapped. Board columns used to run all the way to
  // 'accepted'/'rejected'/'withdrawn'; those are now outcomes on whatever
  // column the migration above lands the card in.
  var STATUS_OUTCOME_MIGRATIONS = { accepted: 'accepted', rejected: 'rejected', withdrawn: 'withdrawn' };

  function normalizeCard(c){
    if (!c) return c;
    var out = c;
    var oldStatus = c.status;
    var movedStatus = oldStatus && STATUS_MIGRATIONS[oldStatus];
    if (movedStatus) out = Object.assign({}, out, { status: movedStatus });
    var cl = out.checklist;
    var template = makeChecklistSnapshot();
    if (!Array.isArray(cl) || cl.length === 0){
      out = Object.assign({}, out, { checklist: template });
    } else if (cl.length !== template.length || cl.some(function(it, i){ return !template[i] || it.label !== template[i].label; })){
      // The checklist was consolidated (34 items -> 14, labels rewritten).
      // No id-stable mapping back, so rebuild from the current template;
      // carry a tick forward only when the whole part was already done
      // (a reasonable "this pass was finished" signal — anything partial
      // starts fresh against the new, shorter list). Format's carry-
      // forward (2026-09-14, see authorChecklistComplete) has no role to
      // key off any more — "was format already done" is read off whatever
      // per-role data the old shape happened to have (both roles ticking
      // every format item, back when format was still part of the
      // reviewers' pass), a one-time best-effort signal only.
      var doneByPartRole = {};
      REVIEW_ROLES.forEach(function(role){
        ['format', 'science'].forEach(function(part){
          var partItems = cl.filter(function(it){ return it.part === part; });
          doneByPartRole[part + ':' + role] = partItems.length > 0 && partItems.every(function(it){ return !!it[role]; });
        });
      });
      out = Object.assign({}, out, { checklist: template.map(function(it){
        var base = { id: it.id, part: it.part, category: it.category, label: it.label, comments: [] };
        return it.part === 'format'
          ? Object.assign(base, { authorChecked: !!(doneByPartRole['format:junior'] && doneByPartRole['format:senior']) })
          : Object.assign(base, { junior: !!doneByPartRole['science:junior'], senior: !!doneByPartRole['science:senior'] });
      }) });
    } else if (cl.some(function(it){
      return it.part === 'format'
        ? (typeof it.authorChecked === 'undefined' || !Array.isArray(it.comments))
        : (typeof it.junior === 'undefined' || typeof it.senior === 'undefined' || typeof it.author !== 'undefined' || !Array.isArray(it.comments));
    })){
      // Covers both a stray pre-2026-09-14 shape (format items still
      // carrying junior/senior from when format was part of the
      // reviewers' pass — carried forward as authorChecked exactly like
      // the branch above, "both reviewers already had it ticked") and any
      // other stray legacy field (author/auditor from an even older
      // design).
      out = Object.assign({}, out, { checklist: cl.map(function(it){
        var base = { id: it.id, part: it.part, category: it.category, label: it.label, comments: Array.isArray(it.comments) ? it.comments : [] };
        return it.part === 'format'
          ? Object.assign(base, { authorChecked: !!it.authorChecked || !!(it.junior && it.senior) })
          : Object.assign(base, { junior: !!it.junior, senior: !!it.senior || !!it.auditor });
      }) });
    }
    if (!out.reviewers || typeof out.reviewers !== 'object'){
      out = Object.assign({}, out, { reviewers: { junior: (out.assignedTo || ''), senior: '' } });
    }
    // jrReviewState/srReviewState (2026-09-11, redesigned 2026-09-14):
    // each reviewer's own state, purely derived from their checklist pass
    // — 'in_review' | 'approved' (see onToggleChecklist/
    // roleChecklistComplete; there was briefly also a manually-clickable
    // 'changes_requested', removed as redundant with the checklist and a
    // source of a real bug — see roleChecklistComplete's comment). This
    // migration only ever fires once, for a card that predates even the
    // original 2026-09-11 shape (a shared changesRequested flag plus
    // independent jrApproved/srApproved booleans) — any historical
    // "changes requested" signal just resolves to 'in_review' now (i.e.
    // "not yet approved"), same as it would today; the very next tick on
    // that card brings it fully in line with its real checklist state
    // regardless. New cards never write changesRequested/jrApproved/
    // srApproved (see onAddCard) — the fields are only read here.
    if (typeof out.jrReviewState !== 'string' || typeof out.srReviewState !== 'string'){
      var deriveState = function(approved){ return approved ? 'approved' : 'in_review'; };
      out = Object.assign({}, out, {
        jrReviewState: deriveState(out.jrApproved),
        srReviewState: deriveState(out.srApproved)
      });
    }
    if (typeof out.outcome !== 'string'){
      out = Object.assign({}, out, { outcome: (oldStatus && STATUS_OUTCOME_MIGRATIONS[oldStatus]) || '' });
    }
    // Authors are required on every new card (see onAddCard), but older
    // cards predate the field — default in empty rather than break. A
    // still-older shape had a separate `pi` field before the PI-is-the-
    // last-author convention; fold it into authors (as the last entry) so
    // there's one source of truth going forward.
    if (typeof out.pi === 'string'){
      var authorsWithoutOldPi = (Array.isArray(out.authors) ? out.authors : []).slice();
      if (out.pi) authorsWithoutOldPi = authorsWithoutOldPi.filter(function(a){ return a !== out.pi; }).concat([out.pi]);
      out = Object.assign({}, out, { authors: authorsWithoutOldPi });
      delete out.pi;
    }
    if (!Array.isArray(out.authors)){
      out = Object.assign({}, out, { authors: [] });
    }
    // authors: {name, email}[] (2026-09-12) — replaces free-text names so
    // a paper's authors (and the PI, its last entry) resolve to a real
    // person the same way reviewers/submittedBy/proposedBy already do;
    // needed so e.g. a PI-approval notification has somewhere to send.
    // Existing cards (including ones just pi-folded above) stored plain
    // name strings — migrate each to {name, email: ''} rather than break;
    // email stays blank for old data (there's no way to retroactively know
    // it) until someone re-saves the author list through the roster picker.
    if (out.authors.some(function(a){ return typeof a === 'string'; })){
      out = Object.assign({}, out, { authors: out.authors.map(function(a){
        return (typeof a === 'string') ? { name: a, email: '' } : a;
      }) });
    }
    // authorEmails: string[] (2026-09-12, see bold-os#3) — a
    // denormalized copy of authors[].email, purely so a Cloud Function can
    // query "papers this person is an author on" across every venue (an
    // array-contains match on authorEmails, since Firestore can't
    // array-contains-match a partial {name,email} object inside authors
    // itself). Derived here so it's always present and correct on read
    // regardless of when a card was last saved — but this alone doesn't
    // help a *query* run against already-stored data: any card saved
    // before this existed only gets a real authorEmails field in Firestore
    // once it's next saved through onAddCard/onSaveEdit (both of which now
    // write it directly). A one-time backfill (same shape as the venue
    // status:'approved' backfill from 2026-09-11) is needed before the
    // App Home dashboard's "Authoring" section can find older papers.
    out = Object.assign({}, out, { authorEmails: authorEmailsOf(out.authors) });
    if (!Array.isArray(out.discussion)){
      out = Object.assign({}, out, { discussion: [] });
    }
    return out;
  }

  // Draft & Review has no sub-columns any more — this is what the card's
  // colour + badge in that column are driven by. Reads jrReviewState/
  // srReviewState, not raw ticks directly — those two fields are now
  // purely derived from each reviewer's own checklist pass (see
  // onToggleChecklist/roleChecklistComplete, 2026-09-14; originally these
  // were an independent manual sign-off, changed after a reviewer could
  // click "Approved" with nothing ticked). Kept as a separate read here,
  // rather than calling roleChecklistComplete twice more, mainly so a
  // legacy pre-2026-09-14 card's stale 'changes_requested' value still
  // renders correctly until it's next touched — see its own handling
  // below. Once both reviewers reach 'approved', onToggleChecklist
  // auto-advances the card to Reviewed itself (still held to the same
  // checklist gate) — see its comment.
  //
  // Three buckets for the card's overall colour (rv-* on the card itself,
  // see renderCard/renderCardDetail) + the board filter — a
  // partially-approved card (only one reviewer signed off) still counts as
  // in_review here, since it isn't done yet; each reviewer's own pill (see
  // reviewStatePillHtml) shows that partial state, per reviewer, not the
  // card as a whole (2026-09-14+1, per Eduardo — removed the card-level
  // "JR approved"/"SR approved" badges that used to duplicate the pills;
  // reviewBadges/badge-rv-jr_approved/badge-rv-sr_approved no longer
  // exist). Either reviewer requesting changes always wins the overall
  // bucket, even if the other has approved.
  function reviewFilterState(card){
    if (card.jrReviewState === 'changes_requested' || card.srReviewState === 'changes_requested') return 'changes_requested';
    if (card.jrReviewState === 'approved' && card.srReviewState === 'approved') return 'approved';
    return 'in_review';
  }

  // Only what reviewStatePillHtml needs now (2026-09-14+1) — 'approved'/
  // 'in_review' are the only two states a reviewer's own pill ever shows.
  // REVIEW_FILTER_LABELS below is the separate map for the board's search
  // filter dropdown, which still has its own 'changes_requested' option.
  var REVIEW_STATE_LABELS = { in_review: 'In review', approved: 'Approved' };
  var REVIEW_FILTER_LABELS = { all: 'Any review status', in_review: 'In review', changes_requested: 'Changes requested', approved: 'Approved' };

  // A read-only label, not a button (2026-09-14, simplified per Eduardo —
  // see onToggleChecklist's comment for why). One reviewer's own state,
  // derived purely from their own checklist pass: nothing to click, so no
  // access check needed here either — it just reports what's true.
  function reviewStatePillHtml(card, role){
    var v = roleChecklistComplete(card, role) ? 'approved' : 'in_review';
    return '<span class="rv-state-pill rv-state-' + v + '">' + REVIEW_STATE_LABELS[v] + '</span>';
  }

  // The Rebuttal column's own 3-state badge (2026-09-18+3), shared between
  // renderCard and renderCardDetail. reviewsOutNotifiedAt is set exactly
  // once, by the scheduled notifyReviewsOut function (functions/index.js),
  // the moment the venue's reviews-release date passes — that single flag
  // is what separates "still waiting" from "reviews are out." Once
  // rebuttalDocLink exists the rebuttal itself has been written, same
  // meaning as before this redesign.
  function rebuttalBadgeHtml(card){
    if (card.rebuttalDocLink) return '<span class="badge badge-rebuttal-sent">Rebuttal sent</span>';
    if (card.reviewsOutNotifiedAt) return '<span class="badge badge-rebuttal-writing">In Rebuttal</span>';
    return '<span class="badge badge-rebuttal-waiting">Waiting for reviews</span>';
  }

  // A bare tri-state review value ('in_review'/'changes_requested'/
  // 'approved') as a badge chip (2026-09-18+4) — shared by both Abstract
  // (card.abstractReviewState, a direct field, no checklist behind it)
  // and Paper (reviewFilterState(card), still derived from the 12-item
  // checklist exactly as before). Same vocabulary, same three labels,
  // just two different sources depending which stage the card is in —
  // see renderCard's own call sites.
  var REVIEW_BADGE_LABELS = { in_review: 'In review', changes_requested: 'Changes requested', approved: 'Approved' };
  function reviewStateBadgeHtml(state){
    var v = REVIEW_BADGE_LABELS[state] ? state : 'in_review';
    return '<span class="badge badge-review-' + v + '">' + REVIEW_BADGE_LABELS[v] + '</span>';
  }

  function renderCard(card, board){
    var overdue = isOverdue(card, board);
    // Abstract's lightweight go/no-go and Paper's checklist-derived state
    // share the same rv- left-border treatment (2026-09-18+4) — whichever
    // of the two stages the card is actually in picks its own source.
    var inPaperStage = card.status === 'paper';
    var rv = card.status === 'abstract' ? (card.abstractReviewState || 'in_review')
      : inPaperStage ? reviewFilterState(card) : null;
    var rushOverdue = isRushColumnPastCutoff(displayStatus(card, board), board);
    var cardClass = 'card' + (rv ? ' rv-' + rv : '') + (rushOverdue ? ' rush-deadline-passed' : '');
    var html = '<div class="' + cardClass + '" data-card-id="' + escapeHtml(card.id) + '">';
    html += '<button class="card-title-btn" type="button" data-open-card="' + escapeHtml(card.id) + '">' + escapeHtml(card.title) + '</button>';
    // Badges only; Overleaf link / edit + remove live on the detail page
    // now, to keep the board card short and easy to scan.
    var badges = '';
    if (card.status === 'abstract') badges += reviewStateBadgeHtml(card.abstractReviewState || 'in_review');
    if (inPaperStage) badges += reviewStateBadgeHtml(reviewFilterState(card));
    if (card.status === 'rebuttal') badges += rebuttalBadgeHtml(card);
    if (shouldShowOutcomeBadge(card)) badges += '<span class="badge badge-outcome-' + card.outcome + '">' + OUTCOME_LABELS[card.outcome] + '</span>';
    if (overdue || rushOverdue) badges += '<span class="badge badge-overdue">Overdue</span>';
    if (badges) html += '<div class="card-meta-row">' + badges + '</div>';
    if (card.pitchLink) html += '<a class="card-link" href="' + escapeHtml(card.pitchLink) + '" target="_blank" rel="noopener">Pitch materials</a><br>';
    if (card.submissionLink) html += '<a class="card-link" href="' + escapeHtml(card.submissionLink) + '" target="_blank" rel="noopener">' + submissionLinkLabel(card.submissionLink) + '</a><br>';
    if (card.arxivLink) html += '<a class="card-link" href="' + escapeHtml(card.arxivLink) + '" target="_blank" rel="noopener">arXiv</a><br>';
    if (card.rebuttalDocLink) html += '<a class="card-link" href="' + escapeHtml(card.rebuttalDocLink) + '" target="_blank" rel="noopener">Rebuttal doc</a><br>';
    if (card.cameraReadyLink) html += '<a class="card-link" href="' + escapeHtml(card.cameraReadyLink) + '" target="_blank" rel="noopener">Camera-ready</a><br>';
    html += '<div class="card-reviewers">' +
      '<div class="rv-row"><span class="rv-role junior">Jr</span>' + reviewerInputHtml(card, 'junior') + '</div>' +
      (inPaperStage ? reviewStatePillHtml(card, 'junior') : '') +
      '<div class="rv-row"><span class="rv-role senior">Sr</span>' + reviewerInputHtml(card, 'senior') + '</div>' +
      (inPaperStage ? reviewStatePillHtml(card, 'senior') : '') +
    '</div>';
    if (card.reviewNotes) html += '<div class="card-notes">' + escapeHtml(card.reviewNotes) + '</div>';
    var counts = checklistCounts(card); // science checklist — reviewers
    var authorCounts = authorChecklistCounts(card); // format checklist — authors
    html += '<div class="card-progress">Checklist &middot; authors ' + authorCounts.done + '/' + authorCounts.total +
      ' &middot; junior ' + counts.junior + '/' + counts.total + ' &middot; senior ' + counts.senior + '/' + counts.total + '</div>';
    if (!STATUS_LABELS[card.status]) html += '<div style="font-size:11px;color:var(--warn-text);background:var(--warn-bg);padding:4px 7px;margin-bottom:8px;">Status &ldquo;' + escapeHtml(card.status) + '&rdquo; isn\u2019t a column anymore &mdash; pick a new one below</div>';
    // No move/advance button on the tile itself any more (2026-09-18+6,
    // per Eduardo \u2014 "remove the buttons from the card") \u2014 open the card
    // to advance it; .detail-controls there still has its own
    // moveButtonsHtml. Only the orphaned-status rescue select needs a
    // footer now; edit / remove moved to the detail page.
    if (!STATUS_LABELS[card.status]) html += '<div class="card-footer"><select aria-label="Status for ' + escapeHtml(card.title) + '" data-status-for="' + escapeHtml(card.id) + '" style="flex:1 1 auto;min-width:0;font-size:12px;padding:5px 6px;">' + statusOptionsHtml(card.status, effectiveStatusOrder(board), board) + '</select></div>';
    html += '</div>';
    return html;
  }

  // Free-text board search, scoped by state.search.field. 'all' also
  // checks submitted-by and both reviewers, so typing your own name finds
  // your papers even if you're not listed as PI or an author. Combined
  // (AND) with the review-status filter below — a card has to match both
  // to show.
  function matchesTextQuery(card){
    var q = (state.search && state.search.query || '').trim().toLowerCase();
    if (!q) return true;
    var authorsStr = (card.authors || []).map(function(a){ return [a.name, a.email].filter(Boolean).join(' '); }).join(' ');
    var field = (state.search && state.search.field) || 'all';
    var hay;
    if (field === 'title') hay = card.title || '';
    else if (field === 'pi') hay = cardPi(card);
    else if (field === 'authors') hay = authorsStr;
    else hay = [
      card.title, authorsStr,
      card.submittedBy && card.submittedBy.name,
      card.reviewers && personName(card.reviewers.junior),
      card.reviewers && personName(card.reviewers.senior)
    ].filter(Boolean).join(' ');
    return hay.toLowerCase().indexOf(q) !== -1;
  }

  // Only meaningful for a card actually at Paper (the only status
  // reviewFilterState applies to, moved here from `abstract` 2026-09-18+4
  // alongside the checklist itself) — a card elsewhere always matches,
  // same as an empty text query always matching, so the filter only
  // narrows down the column it actually applies to.
  function matchesReviewFilter(card){
    var f = (state.search && state.search.reviewState) || 'all';
    if (f === 'all') return true;
    return card.status === 'paper' && reviewFilterState(card) === f;
  }

  function matchesSearch(card){
    return matchesTextQuery(card) && matchesReviewFilter(card);
  }

  var SEARCH_FIELD_LABELS = { all: 'Everything', title: 'Title', pi: 'PI', authors: 'Authors' };

  function boardSearchHtml(){
    var q = (state.search && state.search.query) || '';
    var field = (state.search && state.search.field) || 'all';
    var reviewFilter = (state.search && state.search.reviewState) || 'all';
    var total = state.cards.length;
    var filterActive = !!q.trim() || reviewFilter !== 'all';
    var matched = filterActive ? state.cards.filter(matchesSearch).length : total;
    var countText = filterActive ? (matched + ' of ' + total + ' paper' + (total === 1 ? '' : 's')) : (total + ' paper' + (total === 1 ? '' : 's'));
    return '<div class="board-search">' +
      '<input type="search" id="boardSearchInput" placeholder="Search by title, PI, author…" value="' + escapeHtml(q) + '" aria-label="Search papers">' +
      '<select id="boardSearchField" aria-label="Search in">' +
        Object.keys(SEARCH_FIELD_LABELS).map(function(k){
          return '<option value="' + k + '"' + (k === field ? ' selected' : '') + '>' + SEARCH_FIELD_LABELS[k] + '</option>';
        }).join('') +
      '</select>' +
      '<select id="boardReviewFilter" aria-label="Filter by review status">' +
        Object.keys(REVIEW_FILTER_LABELS).map(function(k){
          return '<option value="' + k + '"' + (k === reviewFilter ? ' selected' : '') + '>' + REVIEW_FILTER_LABELS[k] + '</option>';
        }).join('') +
      '</select>' +
      '<span class="board-search-count">' + countText + '</span>' +
    '</div>';
  }

  function onSearchInput(value){
    state.search.query = value;
    var active = document.activeElement;
    var hadFocus = active && active.id === 'boardSearchInput';
    var selStart = hadFocus ? active.selectionStart : null;
    var selEnd = hadFocus ? active.selectionEnd : null;
    renderBoard();
    if (hadFocus){
      var input = document.getElementById('boardSearchInput');
      if (input){
        input.focus();
        if (selStart != null) input.setSelectionRange(selStart, selEnd);
      }
    }
  }

  function renderColumns(board){
    var searching = !!(state.search && ((state.search.query && state.search.query.trim()) || (state.search.reviewState && state.search.reviewState !== 'all')));
    var order = effectiveStatusOrder(board);
    var hasOrphaned = state.cards.some(function(c){ return !STATUS_LABELS[c.status]; });
    // .columns' CSS min-width is calibrated for the full 9-column board
    // (240px × columns + 1px × gaps + 2px border — see docs/AGENTS.md
    // guideline 6); rush mode's 4 columns need the same formula applied to
    // the actual column count, or they'd render stretched across 9
    // columns' worth of empty space.
    var columnCount = order.length + (hasOrphaned ? 1 : 0);
    var html = '<div class="columns" style="min-width:' + (240 * columnCount + (columnCount - 1) + 2) + 'px">';
    order.forEach(function(status){
      var allForStatus = state.cards.filter(function(c){ return displayStatus(c, board) === status; });
      var cardsForStatus = allForStatus.filter(matchesSearch);
      html += '<div class="column">';
      var hint = columnHintFor(status, board);
      // Only the two-row grid case (an actual venue deadline to show)
      // wants ch-hint-deadlines — the "No deadline set" fallback inside
      // columnHintFor is plain text and should keep ch-hint's own layout.
      var isDeadlineHint = !!(board && board.rushMode && (status === 'register' || status === 'abstract' || status === 'paper') && rushColumnRealDeadline(status, board));
      html += '<div class="column-head">' +
        '<div class="ch-top"><span>' + statusLabelFor(status, board) + '</span><span class="count">' + cardsForStatus.length + '</span></div>' +
        '<div class="ch-hint' + (isDeadlineHint ? ' ch-hint-deadlines' : '') + '">' + hint + '</div>' +
      '</div>';
      html += '<div class="column-body">';
      if (cardsForStatus.length === 0){
        html += '<div class="column-empty">' + (searching && allForStatus.length > 0 ? 'No matches' : 'Nothing here') + '</div>';
      } else {
        cardsForStatus.forEach(function(c){ html += renderCard(c, board); });
      }
      html += '</div></div>';
    });

    var orphanedAll = state.cards.filter(function(c){ return !STATUS_LABELS[c.status]; });
    var orphaned = orphanedAll.filter(matchesSearch);
    if (orphanedAll.length > 0){
      html += '<div class="column">';
      html += '<div class="column-head">' +
        '<div class="ch-top"><span>Other</span><span class="count">' + orphaned.length + '</span></div>' +
        '<div class="ch-hint">Status no longer maps to a column</div>' +
      '</div>';
      html += '<div class="column-body">';
      if (orphaned.length === 0){
        html += '<div class="column-empty">' + (searching ? 'No matches' : 'Nothing here') + '</div>';
      } else {
        orphaned.forEach(function(c){ html += renderCard(c, board); });
      }
      html += '</div></div>';
    }

    html += '</div>';
    return html;
  }

  // Keeps every column-head the same height (2026-09-18+6, per Eduardo).
  // ch-hint's own CSS is min-height/auto now — no fixed height, so a
  // wrapped date never gets clipped — but left alone that means each
  // column-head naturally sizes to its own content, so the head/body
  // divider no longer lines up across the board the way it used to when
  // every ch-hint shared one fixed height. Measures each rendered
  // .ch-hint's natural height, then pins all of them to the tallest one
  // via an explicit style.height. Called after every renderBoard() (fresh
  // DOM, needs remeasuring) and on window resize (column width — and so
  // how much a hint wraps — changes with viewport width; a height pinned
  // at one width would either clip again or waste space at another).
  function equalizeColumnHeadHints(){
    var hints = Array.prototype.slice.call(document.querySelectorAll('.column-head .ch-hint'));
    if (hints.length < 2) return;
    hints.forEach(function(el){ el.style.height = ''; });
    var max = hints.reduce(function(m, el){ return Math.max(m, el.offsetHeight); }, 0);
    hints.forEach(function(el){ el.style.height = max + 'px'; });
  }
  var equalizeResizeTimer = null;
  window.addEventListener('resize', function(){
    clearTimeout(equalizeResizeTimer);
    equalizeResizeTimer = setTimeout(equalizeColumnHeadHints, 120);
  });

  function renderBoard(){
    if (state.view === 'card'){
      renderCardDetail();
      return;
    }
    if (state.view !== 'venue'){
      els.boardRegion.innerHTML = '';
      return;
    }
    if (state.loadingCards){
      els.boardRegion.innerHTML =
        '<div class="board-meta"><a href="#" id="backToList" style="font-size:13.5px;color:var(--muted);text-decoration:none;">&larr; All venues</a></div>' +
        '<p class="board-empty">Loading&hellip;</p>';
      var b = document.getElementById('backToList');
      if (b) b.addEventListener('click', function(e){ e.preventDefault(); backToVenuesList(); });
      return;
    }
    var current = getCurrentBoard();
    // Every card move (and most other board actions) does a full re-render,
    // which — since it's a fresh innerHTML, not a patch — would otherwise
    // reset this scroll position to 0 every time, even though nothing
    // about which columns are visible actually changed. Columns run wider
    // than the viewport, so that meant re-scrolling back to wherever you
    // were after every single move.
    var prevScroll = els.boardRegion.querySelector('.board-scroll');
    var scrollLeft = prevScroll ? prevScroll.scrollLeft : 0;
    var html = '';
    var capWarning = currentUserPaperCapWarning(current, state.cards, state.currentUser && state.currentUser.email);
    if (capWarning){
      html += '<div class="author-cap-alert">You’re an author on ' + capWarning.count +
        ' papers for this venue — over its ' + capWarning.max + '-per-author limit.</div>';
    }
    html += '<div class="board-meta" style="display:block;">' +
      '<a href="#" id="backToList" style="font-size:13.5px;color:var(--muted);text-decoration:none;">&larr; All venues</a>' +
      '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:10px;">' +
        '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">' +
          '<h2>' + (current ? escapeHtml(current.label) : '') + '</h2>' +
          (current && current.status === 'pending' ? '<span class="badge badge-pending">Pending approval</span>' : '') +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:16px;">' +
          (!current || current.status !== 'pending'
            ? '<button class="btn btn-primary" id="submitPaperBtn" type="button"' +
                (!state.currentUser ? ' disabled title="Sign in with Slack to register a paper"' : '') +
                '>+ Register paper</button>'
            : '') +
          (current && current.status === 'pending' && state.canApproveVenues
            ? '<button class="btn btn-approve" id="approveVenueBtn" type="button">Approve venue</button>' +
              '<button class="btn btn-reject" id="rejectVenueBtn" type="button">Reject</button>'
            : '') +
          '<button class="btn-text' + (current && current.rushMode ? ' rush-on' : '') + '" id="rushModeBtn" type="button" title="' +
            (current && current.rushMode
              ? 'Rush mode is on — board is Registered / Drafted / Reviewed / Submitted only. Click to turn off.'
              : 'Turn on Rush mode — collapses this venue to Registered / Drafted / Reviewed / Submitted only, for a fast-moving deadline.') +
            '">' + (current && current.rushMode ? '⚡ Rush mode: On' : 'Rush mode: Off') + '</button>' +
          '<button class="btn-text edit" id="editBoardBtn" type="button">Edit venue</button>' +
          (!current || current.status !== 'pending'
            ? '<button class="btn-text" id="deleteBoardBtn" type="button">Delete this venue</button>'
            : '') +
        '</div>' +
      '</div>' +
      (current && current.status === 'pending' && current.proposedBy
        ? '<div class="venue-meta">Proposed by ' + proposerLabel(current.proposedBy) +
            ' — awaiting a PI or admin’s approval before it’s visible to everyone and open for paper registration.</div>'
        : '') +
      venueMetaHtml(current) +
      (current && current.notes ? '<div class="venue-meta" style="white-space:pre-wrap;">' + escapeHtml(current.notes) + '</div>' : '') +
      venueScheduleHtml(current) +
    '</div>';
    html += boardSearchHtml();
    html += '<div class="board-scroll">' + renderColumns(current) + '</div>';
    els.boardRegion.innerHTML = html;
    if (scrollLeft){
      var newScroll = els.boardRegion.querySelector('.board-scroll');
      if (newScroll) newScroll.scrollLeft = scrollLeft;
    }

    document.getElementById('backToList').addEventListener('click', function(e){ e.preventDefault(); backToVenuesList(); });
    var sp = document.getElementById('submitPaperBtn');
    if (sp) sp.addEventListener('click', openModal);

    var del = document.getElementById('deleteBoardBtn');
    if (del) del.addEventListener('click', onDeleteBoard);
    var ev = document.getElementById('editBoardBtn');
    if (ev) ev.addEventListener('click', openEditVenueModal);
    var rm = document.getElementById('rushModeBtn');
    if (rm) rm.addEventListener('click', onToggleRushMode);
    var av = document.getElementById('approveVenueBtn');
    if (av) av.addEventListener('click', function(){ onApproveVenue(current.id); });
    var rv = document.getElementById('rejectVenueBtn');
    if (rv) rv.addEventListener('click', function(){ onRejectVenue(current.id); });
    var ics = document.getElementById('downloadIcs');
    if (ics) ics.addEventListener('click', function(){ downloadIcs(getCurrentBoard()); });
    var subscribeIcs = document.getElementById('subscribeIcs');
    var subscribeIcsTip = document.getElementById('subscribeIcsTip');
    if (subscribeIcs) subscribeIcs.addEventListener('click', function(){
      copyText(subscribeIcs.getAttribute('data-url'), function(){
        if (!subscribeIcsTip) return;
        subscribeIcsTip.classList.add('is-shown');
        clearTimeout(subscribeIcsTip._hideTimer);
        subscribeIcsTip._hideTimer = setTimeout(function(){
          subscribeIcsTip.classList.remove('is-shown');
        }, 4500);
      });
    });

    var searchInput = document.getElementById('boardSearchInput');
    if (searchInput) searchInput.addEventListener('input', function(){ onSearchInput(searchInput.value); });
    var searchField = document.getElementById('boardSearchField');
    if (searchField) searchField.addEventListener('change', function(){ state.search.field = searchField.value; renderBoard(); });
    var reviewFilterSel = document.getElementById('boardReviewFilter');
    if (reviewFilterSel) reviewFilterSel.addEventListener('change', function(){ state.search.reviewState = reviewFilterSel.value; renderBoard(); });

    Array.prototype.forEach.call(document.querySelectorAll('[data-status-for]'), function(sel){
      sel.addEventListener('change', function(){
        onChangeStatus(sel.getAttribute('data-status-for'), sel.value);
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-reviewer-role]'), function(inp){
      inp.addEventListener('change', function(){
        onSetReviewer(inp.getAttribute('data-reviewer'), inp.getAttribute('data-reviewer-role'), inp.value.trim());
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-move]'), function(btn){
      btn.addEventListener('click', function(){
        var to = btn.getAttribute('data-move-to');
        if (to && confirmMoveIfSubmit(btn.getAttribute('data-move-label'))) onChangeStatus(btn.getAttribute('data-move'), to);
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-open-card]'), function(btn){
      btn.addEventListener('click', function(){
        openCard(btn.getAttribute('data-open-card'));
      });
    });

    equalizeColumnHeadHints();
  }

