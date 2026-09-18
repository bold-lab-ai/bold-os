"use strict";

  // ---------- storage (Firestore) ----------
  // Same five-function seam the page has always called through — every
  // caller elsewhere in this file is unchanged. `boards/{id}` holds venue
  // metadata only; each card is its own document in `boards/{id}/cards/{cardId}`,
  // so two people editing different cards on the same board never contend.
  //
  // Not yet done (deliberately deferred — see docs/FIREBASE.md "Phase 1b"):
  // checklist items, comments, discussion, and history still live embedded
  // on the card document, same shape as the old localStorage blob, so
  // `saveBoard(id, {cards})` still upserts every card in the array on every
  // call rather than writing just the one field that changed. Correct, safe,
  // not yet write-optimized — that split is the next increment, not this one.

  function cardsCol(boardId){ return db.collection('boards').doc(boardId).collection('cards'); }

  // The Slack workspace roster (see docs/FIREBASE.md) — backs the reviewer
  // picker (a real person, stored as their email — required for the
  // per-card Security Rules to ever match) and the authors datalist
  // (suggestions only; authors stay free text since a paper can have
  // co-authors outside this Slack workspace). Read-only for clients;
  // synced via a one-off script, never written from here.
  function loadPeople(){
    return db.collection('people').get()
      .then(function(snap){
        var out = [];
        snap.forEach(function(doc){ out.push(doc.data()); });
        out.sort(function(a, b){ return (a.name || '').localeCompare(b.name || ''); });
        return out;
      })
      .catch(function(err){ logError('loadPeople', err); return []; });
  }

  function personByEmail(email){
    if (!email) return null;
    for (var i = 0; i < state.people.length; i++){
      if (state.people[i].email === email) return state.people[i];
    }
    return null;
  }

  function snapToArr(snap){
    var out = [];
    snap.forEach(function(doc){ out.push(Object.assign({ id: doc.id }, doc.data())); });
    return out;
  }

  // Venue proposals (2026-09-11, see docs/FIREBASE.md): a plain, unfiltered
  // `boards.get()` can no longer read everything for a non-admin — Security
  // Rules deny the *whole* query if any candidate document (someone else's
  // pending proposal) would fail the per-document read check, so an
  // unconstrained list query is only safe for someone with hasFullWrite().
  // Everyone else needs queries whose `where` filters already guarantee the
  // rule holds for every possible result. This one helper is the single
  // place that fetches "every board this session can currently see" —
  // loadBoardsIndex() and saveBoardsIndex()'s own diff-baseline fetch both
  // go through it, so there's exactly one query shape to keep in sync with
  // firestore.rules.
  //
  // Three queries, run in parallel:
  //   1. status == 'approved' — always safe, visible to the whole lab.
  //   2. status == 'pending' AND proposedBy.email == me — always safe, a
  //      signed-in user's own proposals.
  //   3. status == 'pending', unfiltered — only succeeds for a PI/admin
  //      (hasFullWrite() is the only way the rule can hold across every
  //      possible result without an ownership filter); a genuine non-admin
  //      gets permission-denied here whenever at least one other person's
  //      proposal exists. Whether this one succeeds is how the client
  //      learns "can I approve venues" — there's no other way to ask, since
  //      roles/{roleId} itself is unreadable by clients (see guideline 6's
  //      Rush mode note in docs/AGENTS.md for the same constraint
  //      elsewhere). In the rare case zero other people's proposals exist
  //      yet, this can vacuously succeed for a non-admin too — harmless: it
  //      can only ever surface their own proposal back to them, and an
  //      Approve click against it still fails server-side (update stays
  //      hasFullWrite()-only), same as any other disallowed write.
  //
  // Legacy boards created before this field existed have no `status` at
  // all, which query 1's `where('status','==','approved')` can't match —
  // get()'s in-rule default (see firestore.rules) covers single-document
  // reads, but a missing field structurally can't satisfy a query filter.
  // Those boards need a one-time backfill (`status: 'approved'` written
  // onto every existing board) before this ships — see docs/FIREBASE.md.
  function fetchVisibleBoards(){
    var approvedP = db.collection('boards').where('status', '==', 'approved').get()
      .then(snapToArr)
      .catch(function(err){ logError('fetchVisibleBoards:approved', err); return []; });
    var mineP = state.currentUser
      ? db.collection('boards').where('status', '==', 'pending').where('proposedBy.email', '==', state.currentUser.email).get()
          .then(snapToArr)
          .catch(function(err){ logError('fetchVisibleBoards:mine', err); return []; })
      : Promise.resolve([]);
    var allPendingP = db.collection('boards').where('status', '==', 'pending').get()
      .then(function(snap){ return { ok: true, list: snapToArr(snap) }; })
      .catch(function(){ return { ok: false, list: [] }; }); // permission-denied here just means "not an admin" — not worth logError'ing as a failure
    return Promise.all([approvedP, mineP, allPendingP]).then(function(results){
      var approved = results[0], mine = results[1], allPending = results[2];
      var pending = allPending.ok ? allPending.list : mine;
      var seen = {};
      var mergedPending = [];
      pending.concat(mine).forEach(function(b){
        if (seen[b.id]) return;
        seen[b.id] = true;
        mergedPending.push(b);
      });
      return { list: approved.concat(mergedPending), canApproveVenues: allPending.ok };
    });
  }

  function loadBoardsIndex(){
    return fetchVisibleBoards().then(function(res){
      state.canApproveVenues = res.canApproveVenues;
      return res.list;
    });
  }

  // Called with the full desired boards-index array every time (create/edit
  // a venue appends or updates one entry, delete filters one out, but always
  // passes the whole list) — same contract as the old blob write. Upsert
  // only entries that actually changed, then delete any board doc no longer
  // present in the list. Skipping unchanged entries isn't just an
  // optimization: Security Rules authorize each document write on its own
  // terms, so blindly re-.set()-ing an untouched document can fail its own
  // authorization check (e.g. one only its own PI can touch) and take down
  // the whole batch — even though nothing about it was meant to change.
  //
  // The "existing" baseline for the diff now comes from fetchVisibleBoards()
  // rather than a plain get() (see its comment) — for a non-admin proposing
  // a new venue, `list` only ever contains boards they could already see
  // plus the one new entry, so this stays correct without needing to see
  // boards outside their visibility in the first place.
  function saveBoardsIndex(list){
    return fetchVisibleBoards().then(function(res){
        state.canApproveVenues = res.canApproveVenues;
        var existing = {}; res.list.forEach(function(b){ var d = Object.assign({}, b); delete d.id; existing[b.id] = d; });
        var keepIds = list.map(function(b){ return b.id; });
        var batch = db.batch();
        var touched = false;
        list.forEach(function(b){
          var data = Object.assign({}, b); delete data.id;
          if (existing.hasOwnProperty(b.id) && stableStringify(existing[b.id]) === stableStringify(data)) return;
          batch.set(db.collection('boards').doc(b.id), data);
          touched = true;
        });
        Object.keys(existing).forEach(function(id){
          if (keepIds.indexOf(id) === -1) { batch.delete(db.collection('boards').doc(id)); touched = true; }
        });
        if (!touched) return true;
        return batch.commit().then(function(){ return true; });
      })
      .catch(function(err){ logError('saveBoardsIndex', err); lastWriteErrorCode = err && err.code; return false; });
  }

  function loadBoard(id){
    return cardsCol(id).get()
      .then(function(snap){
        var cards = [];
        snap.forEach(function(doc){ cards.push(Object.assign({ id: doc.id }, doc.data())); });
        return { cards: cards };
      })
      .catch(function(err){ logError('loadBoard', err); return { cards: [] }; });
  }

  // Called with the full cards array every time (see note above) — upsert
  // only cards that actually changed, then delete any card doc no longer
  // present in the array. Same reasoning as saveBoardsIndex: re-.set()-ing
  // an untouched card re-triggers its own per-card authorization check
  // (only its submitter/reviewers/a PI can touch it), which can fail and
  // take the whole batch down even though that card was never meant to
  // change — e.g. registering a new paper on a board that already has
  // someone else's card would otherwise fail purely because of the
  // unrelated card, not the new one.
  function saveBoard(id, data){
    var cards = (data && Array.isArray(data.cards)) ? data.cards : [];
    return cardsCol(id).get()
      .then(function(snap){
        var existing = {}; snap.forEach(function(doc){ existing[doc.id] = doc.data(); });
        var keepIds = cards.map(function(c){ return c.id; });
        var batch = db.batch();
        var touched = false;
        cards.forEach(function(c){
          var cardData = Object.assign({}, c); delete cardData.id;
          if (existing.hasOwnProperty(c.id) && stableStringify(existing[c.id]) === stableStringify(cardData)) return;
          batch.set(cardsCol(id).doc(c.id), cardData);
          touched = true;
        });
        Object.keys(existing).forEach(function(cid){
          if (keepIds.indexOf(cid) === -1) { batch.delete(cardsCol(id).doc(cid)); touched = true; }
        });
        if (!touched) return true;
        return batch.commit().then(function(){ return true; });
      })
      .catch(function(err){ logError('saveBoard', err); lastWriteErrorCode = err && err.code; return false; });
  }

  function deleteBoardData(id){
    return cardsCol(id).get()
      .then(function(snap){
        var batch = db.batch();
        snap.forEach(function(doc){ batch.delete(doc.ref); });
        batch.delete(db.collection('boards').doc(id));
        return batch.commit();
      })
      .catch(function(err){ logError('deleteBoardData', err); return null; });
  }

  function logError(where, err){
    if (window.console && console.error) console.error('[Internal Review Board]', where, err);
  }

  // Set by saveBoard()/saveBoardsIndex()'s catch handlers so the call site
  // can tell "you're not allowed to do that" (Security Rules rejected the
  // write — retrying won't help) apart from an actual transient failure,
  // instead of showing the same generic "try again" for both. Firestore
  // rejections carry a stable err.code ('permission-denied') for exactly
  // this. A plain shared var, not per-call state, is fine here: the app
  // never has two saves racing each other where this would matter.
  var lastWriteErrorCode = null;
  function saveErrorMessage(fallback){
    var wasPermissionDenied = lastWriteErrorCode === 'permission-denied';
    lastWriteErrorCode = null;
    return wasPermissionDenied
      ? 'You don’t have permission to do that — check with a PI or lab admin.'
      : fallback;
  }

