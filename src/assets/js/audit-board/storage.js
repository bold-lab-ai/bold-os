"use strict";

  // ---------- storage (Firestore) ----------
  // Same five-function seam the page has always called through — every
  // caller elsewhere in this file is unchanged. `boards/{id}` holds venue
  // metadata only; each card is its own document in `boards/{id}/cards/{cardId}`,
  // so two people editing different cards on the same board never contend.
  // Checklist items, comments and the discussion live embedded on the card
  // document; saveBoard merges them with whatever else changed meanwhile.

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

  // Saves a change to a board's cards: `data.cards` is the list after the change,
  // `base` the list it was made from. Only the cards that differ between the two
  // are written, each merged with what's in Firestore now (merge3), in one
  // transaction: so a change from someone else that this tab hadn't seen yet
  // (a paper registered, a field edited, a comment posted) is kept, not
  // overwritten or deleted. A card is deleted only when it's in `base` and not in
  // `data.cards`, i.e. when this change removed it. Re-writing an untouched card
  // would also re-run its own Security Rules check and could fail the whole
  // save for a card nobody meant to change. → Promise<bool>.
  function saveBoard(id, data, base){
    var strip = function(list){ var o = {}; (list || []).forEach(function(c){ var d = Object.assign({}, c); delete d.id; o[c.id] = d; }); return o; };
    var mine = strip(data && data.cards), was = strip(base);
    var changed = Object.keys(Object.assign({}, mine, was)).filter(function(k){ return stableStringify(mine[k]) !== stableStringify(was[k]); });
    if (!changed.length) return Promise.resolve(true);
    // Who hears of it on Slack asks first (the ground rule); not going ahead is "not saved".
    var notices = [];
    changed.forEach(function(k){ if (was[k] && mine[k]) notices = notices.concat(cardNotices(was[k], mine[k])); });
    var ask = notices.length ? BOLD.confirmAction({ title: 'Save it?', go: 'Save', effects: notices }) : Promise.resolve(true);
    return ask.then(function(ok){
      if (!ok) { lastWriteErrorCode = 'cancelled'; return false; }
      return write(id, mine, was, changed);
    });
  }
  // What a change to a card tells people on Slack (functions/index.js cardEventsToNotify and
  // notifyAuthorsOverCap: keep the two in step), in words, for its popup; not you.
  function cardNotices(before, after){
    var me = String((auth && auth.currentUser && auth.currentUser.email) || '').toLowerCase();
    var name = function(e){ var p = personByEmail(e); return (p && p.name) || String(e).split('@')[0]; };
    var out = [], tell = function(emails, what){
      var who = (emails || []).filter(function(e){ return e && String(e).toLowerCase() !== me; }).filter(function(e, i, a){ return a.indexOf(e) === i; });
      if (who.length) out.push('Tell ' + who.map(name).join(' and ') + ' on Slack ' + what);
    };
    var sub = after.submittedBy && after.submittedBy.email, rb = before.reviewers || {}, ra = after.reviewers || {};
    if ((after.jrReviewState !== before.jrReviewState || after.srReviewState !== before.srReviewState)) tell([sub], 'about the review');
    if (ra.junior && ra.junior !== rb.junior) tell([ra.junior], 'that they’re its junior reviewer');
    if (ra.senior && ra.senior !== rb.senior) tell([ra.senior], 'that they’re its senior reviewer');
    if (before.status !== after.status) tell([sub], 'that it moved to another stage');
    var byId = {};
    (before.discussion || []).forEach(function(m){ byId[m.id] = m; });
    (after.discussion || []).forEach(function(m){
      var b = byId[m.id];
      if (!b) { tell([sub, ra.junior, ra.senior], 'about your message'); return; }
      var had = {}; (b.replies || []).forEach(function(r){ had[r.id] = true; });
      if ((m.replies || []).some(function(r){ return !had[r.id]; })) tell([b.authorEmail].concat((b.replies || []).map(function(r){ return r.authorEmail; })), 'about your reply');
    });
    (after.checklist || []).forEach(function(item){
      var b = (before.checklist || []).filter(function(x){ return x.id === item.id; })[0], seen = {};
      ((b && b.comments) || []).forEach(function(c){ seen[c.id] = true; });
      if ((item.comments || []).some(function(c){ return !seen[c.id]; })) tell(me === String(sub || '').toLowerCase() ? [ra.junior, ra.senior] : [sub], 'about your comment');
    });
    var authorsBefore = before.authorEmails || [];
    if ((after.authorEmails || []).some(function(e){ return authorsBefore.indexOf(e) < 0; })) out.push('Tell any author you added who is now over this venue’s limit of papers, on Slack');
    return out.filter(function(t, i, a){ return a.indexOf(t) === i; });
  }
  function write(id, mine, was, changed){
    return db.runTransaction(function(tx){
      return Promise.all(changed.map(function(k){ return tx.get(cardsCol(id).doc(k)); })).then(function(snaps){
        snaps.forEach(function(snap, i){
          var k = changed[i], ref = cardsCol(id).doc(k);
          if (!was[k]) { tx.set(ref, mine[k]); return; }
          if (!mine[k]) { if (snap.exists) tx.delete(ref); return; }
          if (!snap.exists) { var gone = new Error('The paper was removed meanwhile.'); gone.code = 'gone'; throw gone; }
          var merged = merge3(was[k], mine[k], snap.data());
          if (stableStringify(merged) !== stableStringify(snap.data())) tx.set(ref, merged);
        });
      });
    }).then(function(){ return true; })
      .catch(function(err){ logError('saveBoard', err); lastWriteErrorCode = err && err.code; return false; });
  }

  // Pure: a three-way merge of one value. `base` is what this tab started from,
  // `mine` what it changed it to, `theirs` what's saved now. Whoever changed it
  // wins; when both did, objects merge key by key and lists of things with ids
  // (comments, replies, checklist items) merge item by item: both sides'
  // additions kept, either side's removals honoured. Otherwise, mine wins.
  function merge3(base, mine, theirs){
    var same = function(a, b){ return stableStringify(a) === stableStringify(b); };
    if (same(mine, base)) return theirs;
    if (same(theirs, base) || theirs === undefined || base === undefined) return mine;
    var isObj = function(x){ return x !== null && typeof x === 'object' && !Array.isArray(x); };
    var withIds = function(x){ return Array.isArray(x) && x.every(function(v){ return isObj(v) && v.id !== undefined; }); };
    if (withIds(base) && withIds(mine) && withIds(theirs)){
      var find = function(list, id){ return list.filter(function(v){ return v.id === id; })[0]; };
      var out = [];
      theirs.forEach(function(t){
        var b = find(base, t.id), m = find(mine, t.id);
        if (!b) out.push(t);                       // they added it
        else if (m) out.push(merge3(b, m, t));     // both still have it
        else if (!same(t, b)) out.push(t);          // I removed it, but they changed it: kept
      });
      mine.forEach(function(m){ if (!find(base, m.id) && !find(theirs, m.id)) out.push(m); }); // I added it
      return out;
    }
    if (isObj(base) && isObj(mine) && isObj(theirs)){
      var o = {};
      Object.keys(Object.assign({}, base, mine, theirs)).forEach(function(k){
        var v = merge3(base[k], mine[k], theirs[k]);
        if (v !== undefined) o[k] = v;
      });
      return o;
    }
    return mine;
  }

  // Forms that save several fields at once (Edit, the abstract stage's fields):
  // the card as it was when someone started editing it (startEditing), so saving
  // writes only the fields they changed, not the rest as they were back then.
  var FIELD_WORDS = { title: 'the title', authors: 'the authors', overleafLink: 'the Overleaf link', abstractText: 'the abstract',
    correspondingAuthorEmail: 'the corresponding author', computeEstimate: 'the compute estimate', pitchLink: 'the pitch link',
    submissionLink: 'the submission link', arxivLink: 'the arXiv link', rebuttalDeadline: 'the rebuttal deadline',
    rebuttalDocLink: 'the rebuttal document', cameraReadyLink: 'the camera-ready link', reviewNotes: 'the review notes',
    outcome: 'the outcome', reviewers: 'the reviewers' };
  // `form` names the form ('edit', 'stage'): each keeps its own starting point.
  function startEditing(form, cardId, again){
    var card = state.cards.filter(function(c){ return c.id === cardId; })[0];
    if (!card || (state.editingFrom[form + ':' + cardId] && !again)) return;
    state.editingFrom[form + ':' + cardId] = JSON.parse(JSON.stringify(card));
  }
  // → { prev, next, base, mine } for saveBoard (next: the board to show now), or
  // null when someone else changed one of the same fields meanwhile and this
  // person chose to keep theirs.
  function formChange(form, cardId, updates){
    var live = state.cards.filter(function(c){ return c.id === cardId; })[0];
    var from = state.editingFrom[form + ':' + cardId] || live;
    var blank = function(v){ return v === undefined || v === null || v === ''; };
    var same = function(a, b){ return (blank(a) && blank(b)) || stableStringify(a) === stableStringify(b); };
    var changed = {};
    Object.keys(updates).forEach(function(k){ if (k === 'updatedAt' || !same(updates[k], from[k])) changed[k] = updates[k]; });
    var clash = Object.keys(changed).filter(function(k){ return k !== 'updatedAt' && !same(live[k], from[k]) && !same(changed[k], live[k]); });
    if (clash.length){
      var words = clash.map(function(k){ return FIELD_WORDS[k]; }).filter(Boolean);
      if (!words.length) words = ['some of these fields'];
      if (!window.confirm('Someone else changed ' + words.join(', ') + ' since you started editing. Save yours over theirs?')) return null;
    }
    delete state.editingFrom[form + ':' + cardId];
    var prev = state.cards;
    var swap = function(card){ return prev.map(function(c){ return c.id === cardId ? card : c; }); };
    return { prev: prev, next: swap(Object.assign({}, live, changed)), base: swap(from), mine: swap(Object.assign({}, from, changed)) };
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
    var code = lastWriteErrorCode;
    lastWriteErrorCode = null;
    return code === 'permission-denied' ? 'You don’t have permission to do that — check with a PI or lab admin.'
      : code === 'gone' ? 'Someone removed this paper meanwhile.'
      : code === 'cancelled' ? 'Not saved.'
      : fallback;
  }

