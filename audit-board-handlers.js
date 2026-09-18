"use strict";

  // ---------- handlers ----------

  // Venue proposals (2026-09-11): the form and validation are identical
  // whether or not the signed-in user is a PI/admin \u2014 always attempt the
  // direct create first (status 'approved', same as always), and only fall
  // back to a pending proposal on the specific failure that means "you're
  // not PI/admin" (a permission-denied write), never on any other error.
  // This is deliberately not decided up front from a client-side "am I
  // admin" guess \u2014 there isn't a reliable one (see fetchVisibleBoards) \u2014 it
  // just reacts to whichever way the real, authoritative write actually
  // goes. A pending proposal is self-attributed (`proposedBy`) and only
  // visible to its proposer and a PI/admin (firestore.rules) until approved
  // (onApproveVenue) flips it to 'approved', at which point it's a normal
  // venue, indistinguishable from one an admin created directly.
  function onCreateBoard(e){
    if (e && e.preventDefault) e.preventDefault();
    var f = readVenueFields();
    var errEl = document.getElementById('venueFormError');
    if (!f.venue || !f.year){ if (errEl) errEl.hidden = false; return; }
    if (errEl) errEl.hidden = true;
    var id = slugify(f.venue + '-' + f.year);
    var existing = state.boards.filter(function(b){ return b.id === id; })[0];
    if (existing){
      showToast('That venue already exists \u2014 opening it.', 'ok');
      closeModal();
      openVenue(id);
      return;
    }
    var base = Object.assign({ id: id, label: f.venue + ' ' + f.year, createdAt: Date.now() }, f);
    var approvedEntry = Object.assign({}, base, { status: 'approved' });
    var approvedNext = state.boards.concat([approvedEntry]);
    saveBoard(id, { cards: [] }).then(function(ok){
      if (!ok){ showToast(saveErrorMessage('Could not create the venue \u2014 try again.'), 'error'); return; }
      return saveBoardsIndex(approvedNext).then(function(ok2){
        if (ok2){
          state.boards = approvedNext;
          showToast('Created ' + approvedEntry.label + '.', 'ok');
          closeModal();
          openVenue(id);
          syncVenueIcs(approvedEntry);
          return;
        }
        var wasPermissionDenied = lastWriteErrorCode === 'permission-denied';
        lastWriteErrorCode = null;
        if (!wasPermissionDenied){
          showToast(saveErrorMessage('Could not save the venue list \u2014 try again.'), 'error');
          return;
        }
        var pendingEntry = Object.assign({}, base, {
          status: 'pending',
          proposedBy: { name: state.currentUser.name || state.currentUser.email, email: state.currentUser.email }
        });
        var pendingNext = state.boards.concat([pendingEntry]);
        saveBoardsIndex(pendingNext).then(function(ok3){
          if (!ok3){ showToast(saveErrorMessage('Could not submit the venue proposal \u2014 try again.'), 'error'); return; }
          state.boards = pendingNext;
          showToast('Proposed ' + pendingEntry.label + ' \u2014 a PI or admin will review it.', 'ok');
          closeModal();
          renderAll();
        });
      });
    });
  }

  function onSaveVenue(id){
    var f = readVenueFields();
    var errEl = document.getElementById('venueFormError');
    if (!f.venue || !f.year){ if (errEl) errEl.hidden = false; return; }
    if (errEl) errEl.hidden = true;
    var prev = state.boards;
    var next = state.boards.map(function(b){
      return b.id === id ? Object.assign({}, b, f, { label: f.venue + ' ' + f.year }) : b;
    });
    state.boards = next;
    closeModal();
    renderAll();
    saveBoardsIndex(next).then(function(ok){
      if (!ok){ state.boards = prev; renderAll(); showToast(saveErrorMessage('Could not save the venue \u2014 try again.'), 'error'); }
      else {
        showToast('Saved.', 'ok');
        syncVenueIcs(next.filter(function(b){ return b.id === id; })[0]);
      }
    });
  }

  // Approving a proposal is just flipping status to 'approved' \u2014 same
  // saveBoardsIndex write path as any other venue edit, gated the same way
  // (hasFullWrite() only; see firestore.rules). No separate "reject": a
  // PI/admin who doesn't want a proposal just deletes it the normal way
  // (the existing delete-venue button/confirm, unchanged).
  function onApproveVenue(id){
    var prev = state.boards;
    var next = state.boards.map(function(b){
      return b.id === id ? Object.assign({}, b, { status: 'approved' }) : b;
    });
    state.boards = next;
    renderAll();
    saveBoardsIndex(next).then(function(ok){
      if (!ok){
        state.boards = prev;
        renderAll();
        showToast(saveErrorMessage('Could not approve that venue \u2014 try again.'), 'error');
      } else {
        showToast('Approved.', 'ok');
        syncVenueIcs(next.filter(function(b){ return b.id === id; })[0]);
      }
    });
  }

  // Reject a pending proposal \u2014 same underlying write as onDeleteBoard()
  // (there's nothing to keep once rejected: no cards can exist yet on an
  // unapproved venue, and there's no rejection-reason/audit field in the
  // schema), but its own confirm/toast wording and its own button, kept
  // separate from "Delete this venue" \u2014 that one only shows for an
  // already-approved venue, since deleting a live venue with real
  // registered papers is a materially different, scarier action than
  // declining someone's proposal before it's gone anywhere.
  function onRejectVenue(id){
    var current = state.boards.filter(function(b){ return b.id === id; })[0];
    if (!current || current.status !== 'pending') return;
    if (!window.confirm('Reject the proposal for "' + current.label + '"? This can\u2019t be undone.')) return;
    var next = state.boards.filter(function(b){ return b.id !== id; });
    saveBoardsIndex(next).then(function(ok){
      if (!ok){ showToast(saveErrorMessage('Could not reject that proposal \u2014 try again.'), 'error'); return; }
      deleteBoardData(id).then(function(){
        state.boards = next;
        showToast('Rejected ' + current.label + '.', 'ok');
        backToVenuesList();
      });
    });
  }

  // A one-click toggle rather than a field in the Edit-venue form \u2014 this is
  // meant for "we need to move fast right now", not a considered edit.
  // Never rewrites any card's status; only which columns render and which
  // status Left/Right/the dropdown treat as adjacent change \u2014 see
  // effectiveStatusOrder()/displayStatus() near STATUS_ORDER.
  function onToggleRushMode(){
    var current = getCurrentBoard();
    if (!current) return;
    var id = current.id;
    var turningOn = !current.rushMode;
    var next = state.boards.map(function(b){
      return b.id === id ? Object.assign({}, b, { rushMode: turningOn }) : b;
    });
    var prev = state.boards;
    state.boards = next;
    renderBoard();
    saveBoardsIndex(next).then(function(ok){
      if (!ok){
        state.boards = prev;
        renderBoard();
        showToast(saveErrorMessage('Could not update Rush mode \u2014 try again.'), 'error');
      } else {
        showToast('Rush mode ' + (turningOn ? 'on' : 'off') + '.', 'ok');
      }
    });
  }

  function onDeleteBoard(){
    var current = state.boards.filter(function(b){ return b.id === state.currentBoardId; })[0];
    if (!current) return;
    if (!window.confirm('Delete "' + current.label + '" and every paper on it? This can\u2019t be undone.')) return;
    var id = current.id;
    var next = state.boards.filter(function(b){ return b.id !== id; });
    saveBoardsIndex(next).then(function(ok){
      if (!ok){ showToast(saveErrorMessage('Could not delete the venue \u2014 try again.'), 'error'); return; }
      deleteBoardData(id).then(function(){
        state.boards = next;
        showToast('Deleted ' + current.label + '.', 'ok');
        backToVenuesList();
        if (storage) storage.ref().child(icsStoragePath(id)).delete().catch(function(){});
      });
    });
  }

  function onAddCard(e){
    if (e && e.preventDefault) e.preventDefault();
    if (!requireSignedIn()) return;
    var title = document.getElementById('pTitle').value.trim();
    var errorEl = document.getElementById('paperFormError');

    if (!title){
      errorEl.textContent = 'Please fill in the required fields above.';
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;

    var now = Date.now();
    var noteText = document.getElementById('pNote').value.trim();
    var submittedByName = state.currentUser.name || state.currentUser.email;

    var card = {
      id: 'card-' + now + '-' + Math.random().toString(36).slice(2, 8),
      title: title,
      // Authors and the Overleaf link aren't known yet at registration —
      // there's no first draft to point to and no locked-in author list
      // this early (2026-09-18, per Eduardo). Both get filled in via Edit
      // fields once the abstract itself is ready, at Submit the abstract;
      // see onSaveEdit for where the PI-defaults-to-senior-reviewer
      // assignment actually happens now, deferred from here for the same
      // reason.
      authors: [],
      authorEmails: [],
      overleafLink: '',
      correspondingAuthorEmail: state.currentUser.email,
      computeEstimate: document.getElementById('pCompute').value.trim(),
      // Free text, filled in later (Edit fields) once the abstract itself
      // is written — not required at registration, not a deliverable gate
      // (unlike pitchLink/submissionLink/etc. below). May contain LaTeX,
      // typed as plain $inline$/$$block$$ — see renderAbstractHtml.
      abstractText: '',
      status: 'register',
      submittedBy: { name: submittedByName, email: state.currentUser.email, slackId: null },
      // Senior reviewer defaults to the PI once authors actually exist —
      // see onSaveEdit, which sets this the first time authors are saved,
      // since there's no author list yet at registration to default from.
      reviewers: { junior: '', senior: '' },
      jrReviewState: 'in_review',
      srReviewState: 'in_review',
      // Abstract's own lightweight go/no-go (2026-09-18+4) — a direct
      // tri-state set by the senior reviewer's Approve/Request changes
      // buttons, not derived from a checklist at all (unlike
      // jrReviewState/srReviewState above, which drive the Paper stage's
      // checklist-based reviewFilterState instead). See
      // advanceBlockReason's abstract->paper gate and reviewStateBadgeHtml.
      abstractReviewState: 'in_review',
      outcome: '',
      // Deliverable-per-stage redesign (2026-09-18, per Eduardo): each
      // link below is what its stage's own advance gate requires before
      // the Submit-X button unblocks — see advanceBlockReason and
      // ADVANCE_LABELS. pitchLink (Register -> Pitch), submissionLink
      // (Paper -> Rebuttal — moved 2026-09-18+3 to Abstract -> Rebuttal
      // while `paper` was briefly folded into `abstract`, moved back here
      // 2026-09-18+4 now that `paper` is its own stage again),
      // rebuttalDocLink (Rebuttal -> Camera-ready), cameraReadyLink
      // (Camera-ready -> Conference). arxivLink is deliberately NOT a gate
      // (2026-09-18+3) — arXiv posting is concurrent to sitting in
      // Rebuttal, addable any time, not required to leave anywhere.
      // reviewsOutNotifiedAt: null until the scheduled notifyReviewsOut
      // function (functions/index.js) sets it, once the venue's own
      // reviews-release date passes — drives the Rebuttal badge's
      // Waiting-for-reviews -> In-Rebuttal flip and the one-time Slack DM
      // that goes with it (see renderCard's rebuttal badge).
      pitchLink: null,
      submissionLink: null,
      arxivLink: null,
      rebuttalDeadline: null,
      rebuttalDocLink: null,
      cameraReadyLink: null,
      reviewsOutNotifiedAt: null,
      reviewNotes: '',
      checklist: makeChecklistSnapshot(),
      discussion: [],
      history: [{ timestamp: now, actor: submittedByName, action: 'registered', note: noteText }],
      createdAt: now,
      updatedAt: now
    };
    var next = state.cards.concat([card]);
    var boardId = state.currentBoardId;
    saveBoard(boardId, { cards: next }).then(function(ok){
      if (!ok){ showToast(saveErrorMessage('Could not save the paper \u2014 try again.'), 'error'); return; }
      if (state.currentBoardId !== boardId) return;
      state.cards = next;
      clearRegisterDraft(boardId);
      closeModal();
      renderBoard();
      showToast('Registered for review.', 'ok');
    });
  }

  function onChangeStatus(cardId, newStatus){
    var boardId = state.currentBoardId;
    var board = getCurrentBoard();
    var order = effectiveStatusOrder(board);
    var card = state.cards.filter(function(c){ return c.id === cardId; })[0];
    if (!card || card.status === newStatus) return;

    // This is real user-facing navigation (the Advance/Revert buttons, the
    // status dropdown) — order must be effectiveStatusOrder(board), not
    // the canonical-default omitted order. Rush mode no longer reorders
    // anything (2026-09-18, see RUSH_STATUS_ORDER's own comment), so this
    // is defensive rather than load-bearing the way it used to be — kept
    // anyway, since passing the wrong order here would still silently
    // misread a move if Rush mode's columns ever diverge again.
    if (crossesGate(card.status, newStatus, order) && !checklistComplete(card)){
      var ac = authorChecklistCounts(card);
      var cc = checklistCounts(card);
      var summary = 'authors ' + ac.done + '/' + ac.total + ', ' + REVIEW_ROLES.map(function(role){
        return REVIEW_ROLE_LABELS[role].toLowerCase() + ' ' + cc[role] + '/' + cc.total;
      }).join(', ');
      showToast('Both checklists must be complete before ' + STATUS_LABELS[GATE_STATUS] + ' — ' + summary + '.', 'error');
      renderBoard(); // undo any dropdown selection
      return;
    }

    // Same gate as advanceBlockReason() — see its own comment for why
    // this is (normally redundant with, but kept alongside) the
    // checklistComplete() check just above.
    if (crossesGate(card.status, newStatus, order) && reviewFilterState(card) !== 'approved'){
      showToast('Both reviewers must approve before ' + STATUS_LABELS[GATE_STATUS] + '.', 'error');
      renderBoard(); // undo any dropdown selection
      return;
    }

    // order-based, not canonical STATUS_ORDER — defensive for the same
    // reason as the comment above (Rush mode no longer reorders anything,
    // but this stays order-aware rather than assuming it never will again).
    var fromIdx = order.indexOf(card.status);
    var toIdx = order.indexOf(newStatus);
    var isAdvance = toIdx !== -1 && (fromIdx === -1 || toIdx > fromIdx);

    // Only blocks moving forward into Abstract — reverting back into it
    // isn't held to this, same as the checklist gate above only fires
    // crossing forward. Moved here from Paper Submitted (2026-09-18+1,
    // per Eduardo) to match advanceBlockReason's own gate — see its
    // comment for why.
    if (isAdvance && newStatus === 'abstract' && !reviewersAssigned(card)){
      showToast('Assign a junior and a senior reviewer before moving to ' + STATUS_LABELS.abstract + '.', 'error');
      renderBoard(); // undo any dropdown selection
      return;
    }

    // Same gate as advanceBlockReason() — see its own comment for why
    // (2026-09-18+4, per Eduardo). The status <select> dropdown bypasses
    // advanceBlockReason entirely (it's only consulted by the Advance
    // button's own disabled/tooltip state), so this is the only thing
    // actually stopping the dropdown from skipping the senior reviewer's
    // approval.
    if (isAdvance && newStatus === 'paper' && card.abstractReviewState !== 'approved'){
      showToast('Waiting for the senior reviewer’s approval before moving to ' + STATUS_LABELS.paper + '.', 'error');
      renderBoard(); // undo any dropdown selection
      return;
    }

    // Same gate as advanceBlockReason() — see its own comment
    // (2026-09-18+16, per Eduardo). The status <select> dropdown bypasses
    // advanceBlockReason entirely, so this is the only thing actually
    // stopping the dropdown from skipping the authors' checklist.
    if (isAdvance && newStatus === 'paper' && !authorChecklistComplete(card)){
      showToast('Finish the authors’ checklist before moving to ' + STATUS_LABELS.paper + '.', 'error');
      renderBoard(); // undo any dropdown selection
      return;
    }

    var next = state.cards.map(function(c){
      if (c.id !== cardId) return c;
      return Object.assign({}, c, { status: newStatus, updatedAt: Date.now() });
    });
    var prev = state.cards;
    state.cards = next; // optimistic
    renderBoard();
    saveBoard(boardId, { cards: next }).then(function(ok){
      if (!ok){
        state.cards = prev;
        renderBoard();
        showToast('Could not update status \u2014 try again.', 'error');
      }
    });
  }

  // Fixed 2026-09-14+1 — reported bug: a card kept showing a "JR approved"
  // pill even though the junior reviewer plainly hadn't approved anything.
  // roleChecklistComplete/reviewStatePillHtml only ever look at the
  // checklist items' own junior/senior ticks — nothing here previously
  // tied those ticks to WHO was actually assigned to the role, so
  // reassigning junior/senior to a different person left the checklist
  // exactly as the PREVIOUS person had left it. A brand-new reviewer in
  // the role inherited a stranger's completed pass (or their partial one)
  // as their own starting point. Now: whenever the assigned email in a
  // role actually changes (to someone else, or to/from blank), that
  // role's own science-checklist ticks reset to false and its
  // jrReviewState/srReviewState resets to 'in_review', so a new reviewer
  // always starts their own pass from zero. Re-picking the SAME person
  // already in the role is a no-op and doesn't touch anything — this only
  // fires on a genuine reassignment. Comments left on checklist items are
  // untouched (a discussion record, not a per-reviewer progress flag), and
  // the card's own status/column is untouched too — this only corrects
  // the checklist data a reassignment left stale, not what the board
  // already did with it.
  function onSetReviewer(cardId, role, value){
    var boardId = state.currentBoardId;
    var next = state.cards.map(function(c){
      if (c.id !== cardId) return c;
      var rv = Object.assign({}, c.reviewers || {});
      var reassigned = (rv[role] || '') !== (value || '');
      rv[role] = value;
      var merged = Object.assign({}, c, { reviewers: rv, updatedAt: Date.now() });
      if (reassigned){
        var resetChecklist = (merged.checklist || []).map(function(it){
          if (it.part !== 'science') return it;
          var patch = {}; patch[role] = false;
          return Object.assign({}, it, patch);
        });
        var field = role === 'senior' ? 'srReviewState' : 'jrReviewState';
        var statePatch = {}; statePatch[field] = 'in_review';
        merged = Object.assign({}, merged, { checklist: resetChecklist }, statePatch);
      }
      return merged;
    });
    var prev = state.cards;
    state.cards = next; // optimistic
    renderBoard();
    saveBoard(boardId, { cards: next }).then(function(ok){
      if (!ok){
        state.cards = prev;
        renderBoard();
        showToast(saveErrorMessage('Could not save the reviewer — try again.'), 'error');
      }
    });
  }

  function onRemoveCard(cardId){
    var card = state.cards.filter(function(c){ return c.id === cardId; })[0];
    if (!card) return;
    if (!window.confirm('Remove "' + card.title + '" from this venue?')) return;
    var boardId = state.currentBoardId;
    var next = state.cards.filter(function(c){ return c.id !== cardId; });
    var prev = state.cards;
    var wasOnDetail = state.view === 'card' && state.currentCardId === cardId;
    state.cards = next;
    if (wasOnDetail){ state.view = 'venue'; state.currentCardId = null; }
    if (wasOnDetail) renderAll(); else renderBoard();
    saveBoard(boardId, { cards: next }).then(function(ok){
      if (!ok){
        state.cards = prev;
        if (wasOnDetail){ state.view = 'card'; state.currentCardId = cardId; renderAll(); }
        else renderBoard();
        showToast('Could not remove the paper \u2014 try again.', 'error');
      }
    });
  }

  // Live, not a one-time fetch (2026-09-14) — Eduardo, after reviewer
  // assignment from the Slack App Home dashboard started writing straight
  // to Firestore via the Cloud Function's Admin SDK: "it landed on the
  // board, but I need to reload the page. Can't we update it without
  // reloading." Before this, every board/card read anywhere in the app was
  // a plain `.get()` — fine while the client's own actions were the only
  // way data changed, but the Slack integration means changes can now
  // arrive from somewhere the open tab has no other way to hear about.
  // `onSnapshot` is the general fix: any write to this board's cards —
  // from Slack, another signed-in person, or this same tab's own
  // optimistic writes reflecting back — re-renders automatically. Torn
  // down (unsubscribeCards()) whenever the viewer leaves this board
  // (backToVenuesList, opening a different venue, or signing out) so a
  // stale listener doesn't keep re-rendering a board that's no longer on
  // screen or (post-sign-out) start erroring against Security Rules.
  var unsubscribeCards = null;
  function stopWatchingCards(){
    if (unsubscribeCards){ unsubscribeCards(); unsubscribeCards = null; }
  }
  function loadCurrentBoardCards(){
    if (!state.currentBoardId) return Promise.resolve();
    state.loadingCards = true;
    renderBoard();
    stopWatchingCards();
    var boardId = state.currentBoardId;
    return new Promise(function(resolve){
      unsubscribeCards = cardsCol(boardId).onSnapshot(function(snap){
        // A listener from a board the viewer has since navigated away from
        // can still fire once more before Firestore finishes tearing it
        // down after stopWatchingCards() — ignore it rather than clobber
        // whatever board is actually on screen now.
        if (state.currentBoardId !== boardId) return;
        var cards = [];
        snap.forEach(function(doc){ cards.push(normalizeCard(Object.assign({ id: doc.id }, doc.data()))); });
        state.cards = cards;
        state.loadingCards = false;
        renderBoard();
        resolve();
      }, function(err){
        logError('loadCurrentBoardCards', err);
        state.loadingCards = false;
        renderBoard();
        resolve();
      });
    });
  }

  // ---------- wiring ----------

  els.newBoardToggle.addEventListener('click', openNewVenueModal);

  // ---------- init ----------
  // Data loading itself is kicked off from loadInitialData(), called once
  // auth resolves (see the onAuthStateChanged wiring right below) —
  // board/card reads now require being signed in, so there's no point
  // loading before we know who (if anyone) is signed in.

  // ---------- bootstrap ----------
  // Deliberately the LAST thing on the page (2026-09-18+13, per Eduardo —
  // moved here when audit-board.html's one big script was split into
  // audit-board-core.js through audit-board-handlers.js). This block
  // calls functions from several other files (parseDeepLinkHash from
  // audit-board-venues.js; updateNewVenueButtonState, also
  // audit-board-venues.js; loadInitialData, defined in
  // audit-board-core.js right above, which itself calls renderAll() from
  // audit-board-detail.js and loadBoardsIndex()/loadPeople() from
  // audit-board-storage.js) — in the original single-file build, that
  // was safe wherever this code sat, because every function declaration
  // in the whole file was hoisted together before any of it ran. Split
  // across real <script src> tags, that guarantee only holds once every
  // file has actually finished loading, so this can't run until here,
  // after all of them have. `storageOK` and `auth` are ordinary globals,
  // set earlier in audit-board-core.js — reading them from a different
  // file is fine; only CALLING something not yet defined would be a
  // problem, which is the actual reason this moved.
  if (storageOK){
    // Deep link support (2026-09-12) — a fresh page load can land straight
    // on a venue or a specific card (#board=<id> or #board=<id>&card=<id>),
    // so a link out of the app (a Slack notification, see functions/
    // index.js) goes to the actual paper, not just the front door. Captured
    // once here, before auth/boards are ready — applied (see
    // applyPendingDeepLink, in audit-board-core.js) the first time
    // loadInitialData() actually has boards to check it against. Never
    // re-applied after that, even if loadInitialData() runs again later
    // (e.g. a sign-out/sign-in in the same page load) — at that point
    // it's just a normal reload, not a fresh deep link.
    var pendingDeepLink = parseDeepLinkHash(location.hash);

    if (auth){
      auth.onAuthStateChanged(function(user){
        state.currentUser = user ? { email: user.email, name: user.displayName, photoURL: user.photoURL } : null;
        renderAuthRegion();
        updateNewVenueButtonState();
        loadInitialData();
      });
    } else {
      // No Auth SDK at all (init failed) — Security Rules require auth for
      // every read regardless, so there's nothing to gate on: go straight to
      // the signed-out state rather than attempting a fetch that can only fail.
      renderAuthRegion();
      updateNewVenueButtonState();
      loadInitialData();
    }
  }

