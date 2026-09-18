"use strict";

  // ---------- checklist + gate ----------
  // Two checklists, two different people (2026-09-14, per Eduardo: "We
  // don't want reviewers to check for 'Format'. We want authors to check
  // for it"). `part` on a checklist item ('format'|'science') already
  // grouped the 12 items by content; it now ALSO decides who's allowed to
  // tick it and what shape the tick itself takes — see makeChecklistSnapshot.
  // Format = the authors' checklist: any listed co-author, one
  // `authorChecked` boolean per item, no junior/senior split. Science =
  // the reviewers' checklist: unchanged from before this split — the
  // assigned Junior and Senior each still tick their own independent
  // pass. Both checklists have to be complete for a card to leave Drafted
  // for Reviewed (checklistComplete, below) — "analogous for reviewers",
  // matching how the gate already worked, just now genuinely gated on two
  // different checklists instead of one shared one.

  function checklistItemsFor(card, part){
    return ((card && card.checklist) || []).filter(function(it){ return it.part === part; });
  }

  // { done, total } over the format items only — the authors' checklist.
  function authorChecklistCounts(card){
    var items = checklistItemsFor(card, 'format');
    return { done: items.filter(function(it){ return it.authorChecked; }).length, total: items.length };
  }

  function authorChecklistComplete(card){
    var c = authorChecklistCounts(card);
    return c.total > 0 && c.done === c.total;
  }

  // Science items only now — the reviewers' checklist. Same shape as
  // before the format/science split (junior/senior counts against a
  // total), just scoped to fewer items.
  function checklistCounts(card){
    var items = checklistItemsFor(card, 'science');
    var out = { total: items.length };
    REVIEW_ROLES.forEach(function(role){
      out[role] = items.filter(function(it){ return it[role]; }).length;
    });
    return out;
  }

  // One reviewer's own pass on the Science checklist, not both —
  // reviewerChecklistComplete (below) needs both roles done. This is the
  // single source of truth for that one reviewer's own state (2026-09-14):
  // originally added to gate a manually-clickable "Approved" button (a
  // real bug — that button had no such gate at all, so a reviewer could
  // click Approved with zero boxes ticked, showing a green card that then
  // couldn't actually advance since the advance gate correctly still
  // checked the full checklist); the button itself was then removed
  // entirely as redundant, and this became what jrReviewState/
  // srReviewState are derived from on every write, and what
  // reviewStatePillHtml reads directly for display.
  function roleChecklistComplete(card, role){
    var c = checklistCounts(card);
    return c.total > 0 && c[role] === c.total;
  }

  function reviewerChecklistComplete(card){
    return REVIEW_ROLES.every(function(role){ return roleChecklistComplete(card, role); });
  }

  // The real advance gate: BOTH checklists done, not just one — the
  // authors' Format pass AND the reviewers' Science pass.
  function checklistComplete(card){
    return authorChecklistComplete(card) && reviewerChecklistComplete(card);
  }

  // Any co-author (not just whoever registered the paper) can tick the
  // authors' checklist — per Eduardo, deliberately broader than the
  // single-submitter pattern used elsewhere in this file (onSetReviewer,
  // etc.), since a paper's Format pass is naturally something any of its
  // authors might be the one to actually do.
  function isCardAuthorEmail(card, email){
    if (!email) return false;
    return ((card && card.authors) || []).some(function(a){ return a && a.email === email; });
  }

  // Whether the signed-in viewer counts as "an author" for the inline
  // Submit-the-abstract fields (2026-09-18+11, per Eduardo — those fields
  // should be visible only to authors, the only users who can actually
  // fill them in). isCardAuthorEmail alone isn't enough here: this form's
  // whole job is to ADD the first authors, so card.authors is normally
  // still empty the very first time it has anything to do — whoever
  // registered the paper (card.submittedBy) is treated as an author too,
  // as a bootstrap, until real co-authors exist to take over. Soft,
  // client-side-only gate, same as every other role check in this file
  // (roles aren't readable client-side) — Security Rules stay
  // whole-document, not gated on this.
  function canManageAuthorFields(card){
    var email = state.currentUser && state.currentUser.email;
    if (!email) return false;
    if (isCardAuthorEmail(card, email)) return true;
    return !!(card.submittedBy && card.submittedBy.email === email);
  }

  // The PI isn't a separate field — by convention it's just the last
  // entry in card.authors (same as an author list on the paper itself
  // usually reads). One list, one source of truth. Returns the name only
  // (for display/search — see matchesTextQuery's 'pi' scope); use
  // card.authors[card.authors.length-1] directly if the email is needed too.
  function cardPi(card){
    var authors = (card && card.authors) || [];
    return authors.length ? (authors[authors.length - 1].name || '') : '';
  }

  // Only the submitter or a PI/admin can actually save a reviewer
  // reassignment (see firestore.rules) — but PI/admin status isn't
  // readable client-side (roles/{roleId} is deny-all for clients, same
  // constraint as Rush mode's own permission check), so this can't be
  // greyed out the way the tri-state review buttons and checklist boxes
  // are: doing that would also wrongly block a real PI/admin, who has no
  // other way to prove it to the client. Left enabled for everyone; a
  // non-owner who isn't actually a PI/admin gets the usual
  // permission-denied toast on save (saveErrorMessage), same as any other
  // rejected write — just with a title hint here so it's not a surprise.
  function reviewerInputHtml(card, role){
    var rv = card.reviewers || {};
    var current = rv[role] || '';
    var isOwner = !!(state.currentUser && card.submittedBy && state.currentUser.email === card.submittedBy.email);
    var options = '<option value="">Assign…</option>' + state.people.map(function(p){
      return '<option value="' + escapeHtml(p.email) + '"' + (p.email === current ? ' selected' : '') + '>' +
        escapeHtml(p.name) + '</option>';
    }).join('');
    return '<select class="rv-input" required ' +
      'data-reviewer="' + escapeHtml(card.id) + '" data-reviewer-role="' + role + '" ' +
      (isOwner ? '' : 'title="Only the project owner or a PI/admin can change this" ') +
      'aria-label="' + REVIEW_ROLE_LABELS[role] + ' reviewer for ' + escapeHtml(card.title) + '">' +
      options + '</select>';
  }

  // Resolve a reviewer's stored email back to a display name — falls back
  // to the raw value for legacy data (pre-roster cards stored a free-text
  // name in this field, not an email; see docs/FIREBASE.md).
  function personName(email){
    var p = personByEmail(email);
    return p ? p.name : (email || '');
  }

  // "Proposed by <name> (<email>)" — always both, everywhere a venue
  // proposal's author is shown (the "Pending your approval" list row and
  // the venue detail page alike). A name alone ("A Colleague") isn't
  // enough to actually identify who it was when there's more than one
  // pending proposal to review — email is the one field guaranteed to be
  // unique and unambiguous (it's also what the Security Rules themselves
  // match on for approve/reject).
  function proposerLabel(proposedBy){
    if (!proposedBy) return '';
    var name = proposedBy.name || proposedBy.email || '';
    return proposedBy.email
      ? escapeHtml(name) + ' <span style="color:var(--muted);">(' + escapeHtml(proposedBy.email) + ')</span>'
      : escapeHtml(name);
  }

  // True when a move goes from at-or-before GATE_AFTER_STATUS's position
  // to strictly after it, in `order` (defaults to the canonical
  // STATUS_ORDER when no order is given — every existing call site that
  // never had a rush-aware order to pass keeps working exactly as
  // before). Pass effectiveStatusOrder(board) explicitly wherever the
  // move being checked is a real user-facing navigation (Advance/Revert,
  // the status dropdown) so the gate reflects the sequence actually being
  // navigated, not always the canonical one — see advanceBlockReason.
  // (2026-09-18: onToggleChecklist/onToggleAuthorChecklist used to be two
  // more call sites here, checking a fixed auto-advance target with no
  // order argument — removed along with the auto-advance itself, see
  // their own comments. Checklist completion now just unblocks the
  // Submit-paper button, via advanceBlockReason's own crossesGate call
  // like every other gate.)
  function crossesGate(fromStatus, toStatus, order){
    var ord = order || STATUS_ORDER;
    var gi = ord.indexOf(GATE_AFTER_STATUS);
    var fi = ord.indexOf(fromStatus);
    var ti = ord.indexOf(toStatus);
    return gi !== -1 && fi !== -1 && ti !== -1 && fi <= gi && ti > gi;
  }

  // Authors are fixed as soon as a paper REACHES Abstract — the
  // real venue locks the author list once the abstract's actually gone
  // in, so the app matches that from this point on (changed 2026-09-18,
  // per Eduardo, from locking one column later, only once `paper` was
  // reached — that left authors editable through the whole internal
  // review, which doesn't match how venues actually work). displayStatus
  // resolves "which active column does this card really represent" the
  // same way it does for rendering, so both answers stay consistent.
  // Reverting a card back below `abstract` un-locks it again
  // automatically — a pure function of current status, nothing
  // separately tracked.
  function authorsLocked(card, board){
    var order = effectiveStatusOrder(board);
    var effective = displayStatus(card, board);
    var lockIdx = order.indexOf('abstract');
    var cardIdx = order.indexOf(effective);
    return lockIdx !== -1 && cardIdx !== -1 && cardIdx >= lockIdx;
  }

  function reviewersAssigned(card){
    var rv = (card && card.reviewers) || {};
    return !!(rv.junior && rv.senior);
  }

  // Every hard gate on an Advance, checked in order — the checklist gate
  // (GATE_AFTER_STATUS) plus any other status-specific requirement.
  // Returns the reason to show (title tooltip / toast) or null if the
  // move is allowed. `board` (2026-09-14) is passed through to crossesGate
  // as the active order — required now that Rush mode's own order can
  // genuinely reorder things (see crossesGate/RUSH_STATUS_ORDER), so the
  // gate reflects the sequence actually being navigated.
  function advanceBlockReason(card, toStatus, board){
    var order = effectiveStatusOrder(board);
    // Paper's gate (2026-09-18+18, per Eduardo): the reviewers' explicit
    // approval (card.paperReviewState, set by Approve/Request changes on
    // the Review tab — same shape as abstractReviewState below), not the
    // two checklists any more. The authors' Format checklist already
    // gates Abstract -> Paper; the reviewers' Science checklist stays on
    // the page as their working aid but no longer blocks anything.
    if (crossesGate(card.status, toStatus, order) && card.paperReviewState !== 'approved'){
      return 'Waiting for the reviewers’ approval';
    }
    // Deliverable-per-stage redesign (2026-09-18, per Eduardo): every
    // Submit move requires the real link it's actually submitting, not
    // just a bare confirmed click — see the card fields' own comment in
    // onAddCard. submissionLink/rebuttalDocLink existed already as
    // free-standing informational fields; wired as real gates here for
    // the first time. toStatus 'rebuttal' used to be the one
    // deliberately-ungated arXiv -> Rebuttal transition (2026-09-18+3, see
    // #13) — gone now that arxiv isn't a stage at all; 'rebuttal' is
    // reached from 'paper' instead (2026-09-18+4), gated on submissionLink
    // below, same in both pipelines since RUSH_STATUS_ORDER never
    // reordered anything to begin with.
    if (toStatus === 'pitch' && !card.pitchLink){
      return 'Add your pitch materials first';
    }
    // Authors, the Overleaf link (with a first draft), and reviewer
    // assignment aren't asked for at registration any more (2026-09-18,
    // per Eduardo) — there's no draft yet to point to, no author list
    // worth locking in that early, and nobody to review a paper that
    // hasn't been written. All three become real gates here instead, on
    // whatever transition actually reaches `abstract` (register/pitch ->
    // abstract in the full pipeline, register -> abstract directly in
    // rush mode) — see onAddCard's own comment. Reviewer assignment used
    // to gate `paper` instead (one stage later) — moved up to match: the
    // whole point of sitting at `abstract` is the internal review that
    // needs a junior and senior reviewer to actually happen.
    if (toStatus === 'abstract' && (!card.authors || !card.authors.length)){
      return 'Add your co-authors first';
    }
    if (toStatus === 'abstract' && !card.overleafLink){
      return 'Add the Overleaf link first';
    }
    // Added 2026-09-18+8, per Eduardo — the guide's own instructions for
    // this stage already say to paste the abstract in before submitting
    // (abstractText, free text, added to the Edit-fields modal
    // 2026-09-18+1), but nothing actually enforced it until now.
    if (toStatus === 'abstract' && !card.abstractText){
      return 'Add the abstract text first';
    }
    if (toStatus === 'abstract' && !reviewersAssigned(card)){
      return 'Assign a junior and a senior reviewer first';
    }
    // The per-author cap is checked here, at abstract submission
    // (2026-09-18+19, per Eduardo) — not later, once the paper is already
    // written. Same check that used to run when the paper was submitted.
    if (toStatus === 'abstract'){
      var capReason = abstractAcceptBlockReason(card, board, state.cards);
      if (capReason) return capReason;
    }
    // New lightweight gate (2026-09-18+4, per Eduardo, alongside `paper`
    // coming back as its own stage): leaving `abstract` for `paper` needs
    // the senior reviewer's direct go-ahead — no checklist involved, just
    // card.abstractReviewState, set straight from the two Approve/Request
    // changes buttons on the card (see reviewStateBadgeHtml and
    // abstractApprovalHtml, rendered in the Review section).
    if (toStatus === 'paper' && card.abstractReviewState !== 'approved'){
      return 'Waiting for the senior reviewer’s approval';
    }
    // Second gate on the same transition (2026-09-18+16, per Eduardo —
    // "use the checklist for authors as a gate for submitting [to
    // Paper], move it from the paper stage"): the authors' Format
    // checklist (mandatory sections, length/page limits, anonymity,
    // template, policy compliance — CHECKLIST_TEMPLATE's `part: 'format'`
    // items) is entirely a self-check on the author's own draft, nothing
    // that needs the paper to already be under internal review — so it
    // now renders and is fillable while the card sits at Abstract
    // (authorChecklistTabHtml, called from renderCardDetail's Author
    // section only while `status === 'abstract'`, moved off Paper),
    // finishable in parallel with waiting on the senior reviewer's
    // abstract call above, not after it. Paper itself is no longer a
    // "plain, ungated Advance" the way it used to be described here —
    // both this and the reviewer-approval check above must clear.
    if (toStatus === 'paper' && !authorChecklistComplete(card)){
      return 'Finish the authors’ checklist first';
    }
    // Leaving Abstract is the real venue submission of the paper now
    // (2026-09-18+18, per Eduardo — moved here from Paper -> Rebuttal).
    if (toStatus === 'paper' && !card.submissionLink){
      return 'Add the OpenReview submission link first';
    }
    // Unaffected by `paper` coming back (2026-09-18+4) — this already
    // gated the real transition, `paper -> rebuttal` (the click fires
    // while AT `paper`, per ADVANCE_LABELS.paper), even while `paper` was
    // briefly folded into `abstract` and this fired on `toStatus ===
    // 'rebuttal'` directly (2026-09-18+3) — same real submission click,
    // just addressed by its own status key again now. arXiv stays
    // deliberately ungated regardless — posting to arXiv is concurrent to
    // sitting in Rebuttal, not a prerequisite for reaching it, no
    // arxivLink check anywhere in this function.
    // Paper -> Rebuttal is the REBUTTAL submission now (2026-09-18+18,
    // per Eduardo), gated on the rebuttal document; the venue submission
    // link moved to the transition that actually submits the paper,
    // Abstract -> Paper (just above).
    if (toStatus === 'rebuttal' && !card.rebuttalDocLink){
      return 'Add the rebuttal document link first';
    }
    if (toStatus === 'camera_ready' && !card.rebuttalDocLink){
      return 'Add the rebuttal document link first';
    }
    if (toStatus === 'conference' && !card.cameraReadyLink){
      return 'Add the camera-ready link first';
    }
    return null;
  }
