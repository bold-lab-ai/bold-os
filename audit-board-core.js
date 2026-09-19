"use strict";


  // Columns mirror the guide's phases (how-to-submit-a-paper.html), same
  // names, same order — except Post to arXiv (2026-09-18+3), a guide phase
  // with no column of its own since arXiv posting no longer gates or
  // occupies a stage (see STATUS_ORDER's own comment below). Sub-states
  // that used to be their own column
  // (review in progress / changes requested / approved; rebuttal in
  // progress / submitted) are now a colour on the card (or, for a
  // reviewer's own pass, a per-reviewer pill) instead — see
  // reviewFilterState()/reviewStatePillHtml() and the rebuttal badge in
  // renderCard(). Outcomes
  // (Accepted / Rejected / Withdrawn) aren't phases either; they're
  // card.outcome, shown as a badge, set from the Edit-fields modal.
  //
  // Redesigned 2026-09-18, per Eduardo — 8 stages, down from the old 10.
  // The old draft_review/final_draft/abstract_review/pi_polish foursome
  // (internal draft review, internal re-review, abstract submission, PI
  // approval) collapses into one stage, `abstract`: the abstract goes out
  // to the venue, and everything else that used to be its own column —
  // finishing the full draft, both reviewers' checklists, PI sign-off —
  // now happens *while sitting in* `abstract`, gating the move to `paper`
  // (see GATE_AFTER_STATUS). PI approval specifically is no separate
  // mechanism at all any more: the senior reviewer defaults to the card's
  // PI (see onAddCard), so the existing senior-checklist-complete check
  // already *is* PI approval. `submit`/`arxiv_publicity`/`pre_conference`
  // renamed to `paper`/`arxiv`/`conference`; `camera_ready` is new — it
  // always had a real venue-level deadline (board.cameraReadyDeadline,
  // see internalSchedule) but never had a column of its own before.
  //
  // Reversed 2026-09-18+1, per Eduardo: there IS now a real "abstract
  // text" field (card.abstractText) — see onAddCard, renderAbstractHtml
  // (KaTeX-rendered on the detail page). Authors and the Overleaf link
  // moved out to the same point, both now filled in via Edit fields when
  // the abstract itself is submitted rather than at registration — see
  // authorsLocked's own comment and advanceBlockReason's `abstract` gates.
  //
  // `arxiv` collapsed into `rebuttal` (2026-09-18+3, per Eduardo): arXiv
  // posting is no longer a gate or a column of its own — it's something
  // you can do any time once the paper's submitted ("concurrent to
  // Rebuttal"), just a link on the card, not blocking anything. Once
  // "Submit paper" is clicked (now from `paper`, see below) the card
  // lands directly in `rebuttal`, showing a badge that starts "Waiting
  // for reviews" and flips itself to "In Rebuttal" (plus a Slack DM) once
  // the venue's own reviews-release date passes — see the new
  // notifyReviewsOut scheduled function in functions/index.js, and
  // renderCard's rebuttal badge. First real time-driven automatic
  // transition in this pipeline; everything else here is still a
  // deliberate human click by design.
  //
  // `paper` reinstated as its own stage (2026-09-18+4, per Eduardo) —
  // briefly collapsed into `abstract` alongside the same-day redesign
  // above, but that combined too much into one column: `abstract` is a
  // lightweight go/no-go on the abstract itself (senior reviewer
  // approves or requests changes directly, card.abstractReviewState),
  // but does carry the authors' own 6-item Format checklist
  // (self-checkable in parallel with waiting on that approval — moved
  // here from `paper` at 2026-09-18+16, per Eduardo). Both — approval
  // AND the Format checklist — gate the move into `paper`, where the
  // reviewers' 6-item Science checklist lives, same mechanism as before,
  // just the two checklists now split across the two columns rather than
  // both sitting in `paper`. See advanceBlockReason's own comment for
  // the exact gates on each transition.
  var STATUS_ORDER = ['register', 'pitch', 'abstract', 'paper', 'rebuttal', 'camera_ready', 'conference'];

  // Rush mode (2026-09-11): a per-venue toggle (board.rushMode) for an
  // imminent-deadline venue that needs to move faster than the full
  // pipeline. Originally (2026-09-14) reordered its columns relative to
  // STATUS_ORDER's own sequence — abstract submission moved before the
  // full-paper pass instead of after — which made Rush mode genuinely NOT
  // a coherent subsequence any more, and forced crossesGate/displayStatus/
  // authorsLocked to become order-aware just to cope. Moot now: the
  // 2026-09-18 redesign above already puts `abstract` before `paper` in
  // STATUS_ORDER itself, so Rush mode no longer needs to reorder anything
  // — it's a plain subsequence, same relative order, same labels
  // (statusLabelFor's STATUS_LABELS fallback already covers every key
  // here, so there's no separate RUSH_STATUS_LABELS map any more either).
  // Skips `pitch` (no time for a scheduled Pitch Day) and
  // `camera_ready`/`conference` (rush's own urgency is about the
  // submission deadlines specifically — once past `paper`, the only
  // rush-specific thing left to track is the rebuttal deadline). `arxiv`
  // dropped from here too (2026-09-18+3) now that it's gone from
  // STATUS_ORDER itself. `paper` reinstated (2026-09-18+4, alongside
  // STATUS_ORDER's own) — Rush mode's only remaining divergence from the
  // full pipeline is skipping Pitch.
  var RUSH_STATUS_ORDER = ['register', 'abstract', 'paper', 'rebuttal'];

  function effectiveStatusOrder(board){
    return (board && board.rushMode) ? RUSH_STATUS_ORDER : STATUS_ORDER;
  }

  // The label to show for a status — just STATUS_LABELS now (2026-09-18):
  // rush mode no longer has its own wording, since it's a plain
  // subsequence of the same sequence with the same meaning per stage (see
  // RUSH_STATUS_ORDER's own comment). `board` stays a parameter, unused,
  // rather than changing every call site's signature for a distinction
  // that no longer exists — column headers, Move-to tooltips, and the
  // status dropdown all still go through this one function either way.
  function statusLabelFor(status, board){
    return STATUS_LABELS[status] || status;
  }

  // Where a card displays when its true status isn't one of the active
  // order's columns (e.g. a card already at Pitched when rush mode gets
  // turned on) — the active column representing the latest milestone the
  // card has actually passed, never rewriting card.status itself.
  // Toggling rush mode is purely a display change; a card's status only
  // ever changes when someone actually moves it, at which point it's set
  // directly to a value from whichever order was active for that move
  // (see onChangeStatus — needs no changes since newStatus already comes
  // from the right order by construction).
  //
  // Rewritten 2026-09-14 for Rush mode's reordered active columns (see
  // RUSH_STATUS_ORDER) — the old version picked whichever active column
  // came LAST in `order`'s own iteration among those the card has passed,
  // which only gave the right answer because the old active order
  // happened to preserve canonical relative order. With Abstract
  // Submitted now positioned before Paper Submitted despite
  // abstract_review's own canonical index being *after* draft_review's,
  // "last in iteration order" and "temporally latest milestone" are no
  // longer the same thing. This picks the active column with the
  // largest canonical index that's still <= the card's own canonical
  // index — the genuine closest predecessor, regardless of where that
  // column happens to sit in the active array.
  function displayStatus(card, board){
    var order = effectiveStatusOrder(board);
    if (order.indexOf(card.status) !== -1) return card.status;
    var cardIdx = STATUS_ORDER.indexOf(card.status);
    var best = order[0];
    var bestIdx = STATUS_ORDER.indexOf(best);
    order.forEach(function(s){
      var si = STATUS_ORDER.indexOf(s);
      if (si <= cardIdx && si > bestIdx){ best = s; bestIdx = si; }
    });
    return best;
  }
  // Past tense on purpose: a column name is the checkpoint already met to
  // be sitting in it (see guideline 6/8 in docs/AGENTS.md), not an
  // in-progress label — "Drafted" not "Drafting" (now "Abstract
  // Submitted" not "Abstract in review" — see STATUS_ORDER's own comment
  // for the full 2026-09-18 redesign this belongs to). 8 stages now, same
  // order as the guide's `.timeline` — the guide's headings stay
  // instructional ("Pitch", "Submit paper") since they're telling you
  // what to go do, not stating that it's done.
  // camera_ready fixed 2026-09-18+1: was "Camera-ready Submitted", which
  // was simply wrong — a card enters `camera_ready` by submitting the
  // REBUTTAL (see advanceBlockReason's rebuttalDocLink gate on
  // toStatus==='camera_ready'), not by having submitted camera-ready
  // material yet — that's the NEXT transition, camera_ready -> conference.
  // "Abstract Submitted" reverted back to "Abstract in review" (2026-09-18+2,
  // per Eduardo) — the exact name flagged below as this whole redesign's
  // original mislabel (the column is entered the instant the abstract goes
  // out, before either reviewer has actually started anything). Deliberate
  // this time: a card visibly shows reviewer approval in place once it
  // happens (see renderCard's rv-approved class, reviewFilterState) without
  // changing column, so "in review" reads as "this is the review stage" —
  // still true the whole time a card sits here — rather than "review is
  // active on it right now," which was the original bug's actual claim.
  // Shortened again to plain "Abstract" (2026-09-18+4) once `abstract`
  // stopped being where the checklist itself lives — it's a lightweight
  // go/no-go now (card.abstractReviewState, see advanceBlockReason's own
  // comment), and reviewStateBadgeHtml already shows the live state, so
  // "in review" baked into the column name is redundant the same way
  // Rebuttal's own badge made "Reviews Out" redundant. `paper` is the new
  // column where the full checklist and its "in review"-style badge live.
  var STATUS_LABELS = {
    register: 'Registered',
    pitch: 'Pitched',
    abstract: 'Abstract',
    paper: 'Paper',
    rebuttal: 'Rebuttal',
    camera_ready: 'Rebuttal Submitted',
    conference: 'Accepted'
  };
  // Super-brief "move a card here when…" note under each column title.
  // `abstract`/`paper`/`rebuttal`'s own badges (renderCard) carry the
  // finer-grained review/waiting states these hints can't — see their
  // own comments (reviewStateBadgeHtml, rebuttalBadgeHtml).
  var STATUS_HINTS = {
    register: 'Waiting for pitch',
    pitch: 'Waiting for abstract submission',
    abstract: 'Reviewer approval + authors’ checklist',
    paper: 'Reviewer approval + rebuttal document',
    rebuttal: 'Waiting for reviews, then rebuttal',
    camera_ready: 'Waiting for the camera-ready submission',
    conference: 'Planning for conference'
  };
  // Old status keys mapped forward, so a card saved under a since-retired
  // status still lands in a real column instead of the "Other" fallback.
  // Where an old status carried information a plain status-rename would
  // lose (the review sub-state, an outcome), normalizeCard() below sets the
  // matching field too — this map only decides where the card lands.
  //
  // Two generations of retired keys now: the pre-2026-09 legacy ones
  // (todo/in_audit/etc., already a migration before this file's current
  // history began) chain through to whichever NEW key their already-once-
  // migrated target itself now maps to, not the old intermediate one —
  // e.g. in_audit used to land on draft_review, which itself no longer
  // exists, so in_audit now goes straight to abstract, draft_review's own
  // replacement. Plus the second generation: every 2026-09-18-retired
  // STATUS_ORDER key (pitch_day, draft_review, final_draft,
  // abstract_review, pi_polish, submit, arxiv_publicity, pre_conference)
  // mapped to its replacement directly — see STATUS_ORDER's own comment
  // for what absorbed what. A real, live board can have cards sitting at
  // ANY of these today; this map is what keeps every one of them landing
  // on a real column instead of the orphaned-status rescue UI the moment
  // this ships.
  var STATUS_MIGRATIONS = {
    // pre-2026-09 legacy
    todo: 'register',
    in_audit: 'abstract',
    changes_requested: 'abstract',
    approved: 'abstract',
    submitted: 'rebuttal',
    rebuttal_in_progress: 'rebuttal',
    rebuttal_submitted: 'rebuttal',
    accepted: 'conference',
    rejected: 'rebuttal',
    withdrawn: 'rebuttal',
    // 2026-09-18 pipeline redesign. draft_review/final_draft/pi_polish
    // repointed to `paper` (2026-09-18+4, alongside `paper` itself coming
    // back): those three named actual full-draft-checklist activity, which
    // is where the checklist genuinely lives again now — abstract_review
    // stays at `abstract`, since that one's about the abstract itself, a
    // real match for the new lightweight stage there.
    pitch_day: 'pitch',
    draft_review: 'paper',
    final_draft: 'paper',
    abstract_review: 'abstract',
    pi_polish: 'paper',
    submit: 'rebuttal',
    arxiv_publicity: 'rebuttal',
    pre_conference: 'conference',
    // 2026-09-18+3: arxiv collapsed into rebuttal (see STATUS_ORDER's own
    // comment) — this lookup is a single hop, not chained, so any entry
    // that used to target a status later retired gets repointed straight
    // at its replacement too, not left dangling. `paper` reinstated as
    // its own real stage again (2026-09-18+4), so it no longer needs an
    // entry here at all — a card already there just stays.
    arxiv: 'rebuttal'
  };

  // Each item folds together what used to be several sibling checks in the
  // same category (see changelog) \u2014 same substance, fewer ticks. Every
  // item is still worked through twice (junior + senior). 12 items: the
  // Submission-system category was dropped (it's what the OpenReview form
  // covers anyway, not something the draft needs an internal check for).
  var CHECKLIST_TEMPLATE = [
    { part: 'format', category: 'Mandatory sections & parts', label: 'All required sections and disclosure forms are present and filled in, not left as templates (e.g. limitations, ethics statement, paper checklist) \u2014 and everything the main text references in the appendix actually exists there' },
    { part: 'format', category: 'Length & page limits', label: "Main paper and every section-specific limit (abstract word count, appendix pages, etc.) are within bounds \u2014 without manually shrinking margins, font, or spacing to fit more in" },
    { part: 'format', category: 'Double-blind anonymity', label: "No identity anywhere in the PDF \u2014 no author names or affiliations (including acknowledgments), and nothing identifying in the file's title/author metadata" },
    { part: 'format', category: 'Double-blind anonymity', label: 'No identity outside the PDF either \u2014 linked code/data repos are anonymized (README, commit history, filenames) and self-citations are phrased in the third person' },
    { part: 'format', category: 'Template & formatting', label: 'Latest official venue template (not a copy from a previous year), compiles cleanly with no missing figures / broken references / warnings, and fonts / page size are correct' },
    { part: 'format', category: 'Policy compliance', label: "Not in violation of the venue's dual-submission / prior-publication policy, and any arXiv or preprint posting follows its timing policy" },
    { part: 'science', category: 'Claimed contributions', label: 'Contributions are stated clearly (ideally a short, explicit list) and checked against the paper\u2019s actual evidence \u2014 nothing in the abstract or intro claims more than the results show' },
    { part: 'science', category: 'Correctness', label: 'Theoretical claims: proofs are correct, with reasonable and clearly-stated assumptions' },
    { part: 'science', category: 'Correctness', label: 'Empirical claims: experiments are well-designed with fair, non-strawman baselines, and the results shown actually support the conclusions drawn from them' },
    { part: 'science', category: 'Impact', label: 'The problem is relevant to the target community, others could plausibly build on it, and the scope of impact is honestly represented \u2014 not oversold, not undersold' },
    { part: 'science', category: 'Limitations', label: 'Limitations and known failure modes or negative results are disclosed honestly \u2014 not buried or omitted' },
    { part: 'science', category: 'Related work & positioning', label: 'Prior work is represented accurately, the contribution is clearly differentiated from the closest prior work, and nothing obviously relevant is missing' }
  ];

  // Each checklist item is worked through twice: a junior reviewer and a
  // senior reviewer.
  var REVIEW_ROLES = ['junior', 'senior'];
  var REVIEW_ROLE_LABELS = { junior: 'Junior', senior: 'Senior' };

  // Two different shapes depending on part (2026-09-14, see
  // authorChecklistComplete/roleChecklistComplete): a format item is
  // ticked once, by any author — authorChecked, no junior/senior at all.
  // A science item keeps the original per-reviewer shape — junior/senior,
  // no authorChecked. Never both on the same item; which fields an item
  // carries is itself how the rest of the file tells the two checklists
  // apart, alongside `part`.
  function makeChecklistSnapshot(){
    return CHECKLIST_TEMPLATE.map(function(item, i){
      var base = { id: 'chk-' + (i + 1), part: item.part, category: item.category, label: item.label, comments: [] };
      return item.part === 'format'
        ? Object.assign(base, { authorChecked: false })
        : Object.assign(base, { junior: false, senior: false });
    });
  }

  // A paper can't reach this status (or any to its right, in whichever
  // order is active) until both checklists are complete. Purely for
  // *display* — "before Rebuttal" in a toast/banner — the real,
  // human-facing name for what crossesGate's gate actually protects. The
  // gate calculation itself (crossesGate, below) is anchored to
  // GATE_AFTER_STATUS instead. Unaffected by `paper` coming back
  // (2026-09-18+4) — the checklist gate moved from `abstract` to `paper`
  // (see GATE_AFTER_STATUS below), but 'rebuttal' is still exactly what's
  // on the other side of it either way.
  var GATE_STATUS = 'rebuttal';

  // The actual anchor crossesGate computes from. Moved from `abstract` to
  // `paper` (2026-09-18+4, per Eduardo) when `paper` was reinstated as its
  // own stage: `abstract` is a lightweight go/no-go now (no checklist at
  // all, see card.abstractReviewState), `paper` is where the actual
  // 12-item Format+Science checklist lives — same mechanism this whole
  // gate has always used, just relocated. "Crossing the gate" means
  // leaving `paper` without the checklist done, i.e. moving from
  // at-or-before its position (in whichever order is active) to strictly
  // after it. Rush mode doesn't reorder anything (see RUSH_STATUS_ORDER),
  // so this is trivially adjacent to GATE_STATUS in both pipelines — kept
  // as two separate constants anyway (one anchors the calculation, one
  // names the result for display) since collapsing them back into one
  // would just reintroduce the coupling that caused real bugs the last
  // time Rush mode's columns diverged from canonical's own order.
  var GATE_AFTER_STATUS = 'paper';

  var OUTCOME_LABELS = { accepted: 'Accepted', rejected: 'Rejected', withdrawn: 'Withdrawn' };

  // Skip the outcome badge when it would just repeat the column name — the
  // last column is itself called "Accepted" (see STATUS_LABELS), so an
  // Accepted-outcome card sitting there doesn't need to say so twice.
  // Rejected/Withdrawn never collide with a column name, so they always show.
  function shouldShowOutcomeBadge(card){
    return !!card.outcome && !(card.outcome === 'accepted' && card.status === 'conference');
  }

  var state = {
    view: 'list', // 'list' | 'venue' | 'card'
    boards: [],
    currentBoardId: null,
    currentCardId: null,
    cards: [],
    loadingBoards: true,
    loadingCards: false,
    search: { query: '', field: 'all', reviewState: 'all' },
    detailEditing: null, // 'overleaf' | 'abstract' — which detail is being edited inline on the card page
    detailTab: 'review', // 'review' | 'author' — card detail page tab (2026-09-18+19), For reviewers first
    discussionReplyOpenId: null,
    checklistCommentOpenId: null, // checklist item whose feedback thread is expanded
    checklistReplyOpenId: null,   // comment within it whose reply box is open
    currentUser: null,            // { email, name, photoURL } | null — set by onAuthStateChanged
    authResolved: false,          // true once the first onAuthStateChanged callback has fired
    people: [],                   // [{ slackId, name, email }] — the Slack roster, from Firestore
    canApproveVenues: false       // learned from whether the admin-only pending-venues query succeeds — see fetchVisibleBoards()
  };

  var ANONYMITY_OPTIONS = [
    ['', '—'],
    ['double-blind', 'Double-blind'],
    ['single-blind', 'Single-blind'],
    ['open', 'Open review']
  ];
  var ANONYMITY_LABELS = {};
  ANONYMITY_OPTIONS.forEach(function(o){ if (o[0]) ANONYMITY_LABELS[o[0]] = o[1]; });

  var els = {
    newBoardToggle: document.getElementById('newBoardToggle'),
    toastRegion: document.getElementById('toastRegion'),
    venuesRegion: document.getElementById('venuesRegion'),
    boardRegion: document.getElementById('boardRegion'),
    modalRegion: document.getElementById('modalRegion'),
    authRegion: document.getElementById('authRegion')
  };

  // Last line of defense: if anything throws or a promise rejects
  // unexpectedly, surface it instead of failing silently.
  window.addEventListener('error', function(ev){
    if (window.console && console.error) console.error('[Internal Review Board] uncaught error', ev.error || ev.message);
    if (els.toastRegion) showToast('Something went wrong \u2014 open the console for details.', 'error');
  });
  window.addEventListener('unhandledrejection', function(ev){
    if (window.console && console.error) console.error('[Internal Review Board] unhandled rejection', ev.reason);
    if (els.toastRegion) showToast('Something went wrong \u2014 open the console for details.', 'error');
  });

  // Persistence: Firestore (bold-d7ff2), replacing the old per-browser
  // localStorage — see docs/FIREBASE.md for the project/data-model/phasing.
  // Real Security Rules replaced the deny-all default on 2026-09-11 (see
  // docs/FIREBASE.md), so the deployed site now points at real production
  // Firestore — FIRESTORE_USE_EMULATOR = false. Flip both flags to true for
  // local dev against the emulator (see docs/AGENTS.md); never commit them
  // that way, or the live site silently can't read/write for anyone but
  // whoever happens to have a local emulator running (this shipped once,
  // caught 2026-09-11 when a second real user saw "No venues yet" despite
  // Sign-in-with-Slack genuinely working — Auth was flipped to real ages
  // before Firestore was).
  var FIRESTORE_USE_EMULATOR = false;
  var AUTH_USE_EMULATOR = false;

  // Loud, unmissable banner the moment this file is ever served with the
  // flag above true — see its own comment and .emulator-warning's CSS.
  // Deliberately not folded into any render function: the flag is a
  // constant for the life of the page load, so this only ever needs to
  // run once, here, right next to the flag it's guarding.
  (function(){
    var w = document.getElementById('emulatorWarning');
    if (w) w.hidden = !FIRESTORE_USE_EMULATOR;
  })();

  var FIREBASE_CONFIG = {
    apiKey: 'AIzaSyDNKEMYuV0gehbKoM2acafzVbBQL489yDY',
    authDomain: 'bold-d7ff2.firebaseapp.com',
    projectId: 'bold-d7ff2',
    storageBucket: 'bold-d7ff2.firebasestorage.app',
    messagingSenderId: '555050367135',
    appId: '1:555050367135:web:d90f8d7bb93a755e9fcaaa',
    measurementId: 'G-527H8R28KB'
  };

  var db = null;
  var storageOK = (function(){
    try {
      firebase.initializeApp(FIREBASE_CONFIG);
      db = firebase.firestore();
      if (FIRESTORE_USE_EMULATOR) db.useEmulator('localhost', 8080);
      return true;
    } catch (e){ return false; }
  })();

  // No top-level `return` here any more (2026-09-18+13) — this file used
  // to be the top of one big enclosing IIFE, where `return` just exited
  // that function early, skipping everything after it (harmless, since
  // everything after it was either more function declarations, which
  // still get defined either way, or the app's actual bootstrap trigger,
  // now moved to the very end of audit-board-handlers.js and itself
  // guarded by `if (storageOK)` there instead — see its own comment).
  // Split into a real top-level classic script, a bare `return` outside
  // any function is a SyntaxError, not just wrong: it would stop this
  // whole file from parsing at all, not just misbehave when storage
  // fails. Keeping just the user-facing part here, unconditionally.
  if (!storageOK){
    els.venuesRegion.innerHTML =
      '<p class="board-empty">Could not connect to storage. Reload, or check back shortly.</p>';
    els.newBoardToggle.disabled = true;
  }

  // Sign-in-with-Slack (Firebase Auth, custom OIDC provider). Identity only,
  // for the moment — "who am I", not "what am I allowed to do". Role
  // (junior/senior/PI) is a hardcoded email allowlist enforced in
  // firestore.rules, not derived from this sign-in — see docs/FIREBASE.md.
  // The 'oidc.slack' provider itself is configured manually in the Firebase
  // Console once the Slack app exists; until then, signing in will fail with
  // a clear toast rather than a crash.
  var auth = null;
  try {
    auth = firebase.auth();
    if (AUTH_USE_EMULATOR) auth.useEmulator('http://localhost:9099');
  } catch (e){ auth = null; }

  // Cloud Storage — publishes each venue's .ics feed at a stable public
  // URL for calendar subscription (see syncVenueIcs()/icsSubscribeUrl()
  // below and storage.rules). Always the real bucket, no emulator: the
  // write-side Storage rule cross-references real roles/pis + roles/admins
  // data in production Firestore, which a local emulator wouldn't have —
  // same reasoning as testing Sign-in-with-Slack against the real backend.
  var storage = null;
  try { storage = firebase.storage(); } catch (e){ storage = null; }

  // Shared by the masthead's sign-in button and any other "sign in" trigger
  // on the page (e.g. the signed-out empty-state message) \u2014 one place that
  // actually starts the popup flow.
  function triggerSlackSignIn(){
    if (!auth) return;
    var provider = new firebase.auth.OAuthProvider('oidc.slack');
    provider.addScope('openid');
    provider.addScope('profile');
    provider.addScope('email');
    auth.signInWithPopup(provider).catch(function(err){
      console.error('[Internal Review Board] sign-in failed', err);
      showToast('Sign-in with Slack isn\u2019t set up yet \u2014 check back soon.', 'error');
    });
  }

  function renderAuthRegion(){
    if (!els.authRegion) return;
    if (!auth){
      els.authRegion.innerHTML = '';
      return;
    }
    if (state.currentUser){
      var whoHtml = state.currentUser.name
        ? escapeHtml(state.currentUser.name) + (state.currentUser.email
            ? ' <span class="auth-user-email">(' + escapeHtml(state.currentUser.email) + ')</span>'
            : '')
        : escapeHtml(state.currentUser.email || 'Signed in');
      els.authRegion.innerHTML =
        '<div class="auth-user">' +
          '<a class="auth-user-name" href="profile.html">' + whoHtml + '</a>' +
          '<button class="btn-text" type="button" id="signOutBtn">Sign out</button>' +
        '</div>';
      var so = document.getElementById('signOutBtn');
      if (so) so.addEventListener('click', function(){ auth.signOut(); });
    } else {
      els.authRegion.innerHTML =
        '<button class="auth-signin" type="button" id="signInBtn">Sign in with Slack</button>';
      var si = document.getElementById('signInBtn');
      if (si) si.addEventListener('click', triggerSlackSignIn);
    }
  }

  // pendingDeepLink itself (var, no declaration here any more —
  // 2026-09-18+13) is captured in audit-board-handlers.js, the very last
  // file loaded: this file's own parseDeepLinkHash() call used to run
  // here, at script load, before audit-board-venues.js (which actually
  // defines parseDeepLinkHash) had loaded — harmless in the original
  // single-file build (everything was hoisted together), a guaranteed
  // ReferenceError on every page load once split into real <script src>
  // tags. See that file's own "bootstrap" section for where it's set now
  // — global `var`s are shared across every classic <script> on the page
  // regardless of which file declares them, so applyPendingDeepLink
  // below still reads the exact same variable, just assigned later.
  //
  // Applies pendingDeepLink if one's waiting, consuming it either way (so
  // it's never retried on a later call). Returns true if it took over
  // rendering itself (via openVenue/openCard, both of which already
  // render+pushNavState), false if the caller still needs to renderAll()
  // itself. A venue/card that doesn't exist — or that fetchVisibleBoards()
  // (see docs/FIREBASE.md) simply didn't return because this viewer isn't
  // allowed to see it — look identical here on purpose: same toast either
  // way, not leaking which case it was.
  function applyPendingDeepLink(){
    var dl = pendingDeepLink;
    pendingDeepLink = null;
    if (!dl) return false;
    var board = state.boards.filter(function(b){ return b.id === dl.boardId; })[0];
    if (!board){
      showToast('That venue couldn’t be found, or isn’t visible to you yet.', 'error');
      return false;
    }
    openVenue(dl.boardId);
    if (dl.cardId){
      // openVenue() already kicked off its own loadCurrentBoardCards()
      // fire-and-forget; awaiting a second call here to know when the
      // specific card is available costs one small duplicate read, once,
      // on this one initial load — accepted for keeping openVenue()
      // itself unchanged rather than growing a special no-fetch variant.
      var cardId = dl.cardId;
      loadCurrentBoardCards().then(function(){
        var card = state.cards.filter(function(c){ return c.id === cardId; })[0];
        if (card) openCard(cardId);
        else showToast('That paper couldn’t be found — it may have been removed.', 'error');
      });
    }
    return true;
  }

  // Startup timing probe: ms since navigation start, one console line per
  // stage — filter the console on "[BOLD Lab] boot".
  function bootMark(name){
    console.info('[BOLD Lab] boot ' + name + ' @' + Math.round(performance.now()) + 'ms');
  }

  // Venue-list cache (2026-09-19): the last fetched venue list, per person,
  // painted at once on the next open while the real fetch runs in the
  // background — the list is always refetched, the cache only hides the
  // wait. Cleared on sign-out.
  var BOARDS_CACHE_PREFIX = 'boldBoardsIndex:';
  function boardsCacheGet(email){
    try { return JSON.parse(localStorage.getItem(BOARDS_CACHE_PREFIX + String(email).toLowerCase()) || 'null'); } catch (e) { return null; }
  }
  function boardsCachePut(email, list){
    try { localStorage.setItem(BOARDS_CACHE_PREFIX + String(email).toLowerCase(), JSON.stringify({ list: list, canApprove: !!state.canApproveVenues })); } catch (e){}
  }
  function boardsCacheClear(){
    try {
      Object.keys(localStorage).forEach(function(k){ if (k.indexOf(BOARDS_CACHE_PREFIX) === 0) localStorage.removeItem(k); });
    } catch (e){}
  }

  // Bumped on every loadInitialData() so a slow response from an earlier
  // call (sign-out/sign-in in the same page load) can't overwrite a newer one.
  var loadGeneration = 0;

  // Board/card reads now require being signed in (Security Rules,
  // 2026-09-11 — see firestore.rules). So the initial load — and any
  // reload after a sign-in/out — waits for auth to resolve first, rather
  // than firing a doomed fetch for a signed-out visitor. On sign-out,
  // clears whatever was in memory and backs out to the venues list, so a
  // board's contents don't linger on screen after actively signing out.
  function loadInitialData(){
    var gen = ++loadGeneration;
    if (!state.currentUser){
      stopWatchingCards();
      boardsCacheClear();
      state.boards = [];
      state.people = [];
      state.cards = [];
      state.view = 'list';
      state.currentBoardId = null;
      state.currentCardId = null;
      state.loadingBoards = false;
      state.authResolved = true;
      renderAll();
      return;
    }
    var email = state.currentUser.email;
    state.authResolved = true;

    var boardsP = loadBoardsIndex().then(function(r){ bootMark('venues fetched (' + r.length + ')'); return r; });
    var peopleP = loadPeople().then(function(r){ bootMark('people fetched (' + r.length + ')'); return r; });

    // A deep link (Slack notification etc.) needs the venue AND the roster
    // (card pickers) before it can open a card, so it keeps the original
    // wait-for-both flow.
    if (pendingDeepLink){
      state.loadingBoards = true;
      renderAll();
      Promise.all([boardsP, peopleP]).then(function(results){
        if (gen !== loadGeneration) return;
        state.boards = results[0];
        state.people = results[1];
        state.loadingBoards = false;
        boardsCachePut(email, results[0]);
        if (!applyPendingDeepLink()) renderAll();
        bootMark('venue list rendered');
      });
      return;
    }

    // Normal open: paint the cached list (if any) now, swap in the fresh
    // one when it arrives, and let the roster load without holding the list
    // up — only card pages need it.
    var cached = boardsCacheGet(email);
    if (cached && Array.isArray(cached.list)){
      state.boards = cached.list;
      state.canApproveVenues = !!cached.canApprove;
      state.loadingBoards = false;
      bootMark('venue list painted from cache');
    } else {
      state.loadingBoards = true;
    }
    renderAll();

    boardsP.then(function(list){
      if (gen !== loadGeneration) return;
      state.boards = list;
      state.loadingBoards = false;
      boardsCachePut(email, list);
      renderAll();
      bootMark('venue list rendered');
    });
    peopleP.then(function(people){
      if (gen !== loadGeneration) return;
      state.people = people;
      // Pickers on an already-open board/card page were rendered without it.
      if (state.view !== 'list') renderAll();
    });
  }

  // The actual auth-state-change wiring that starts the app (calls
  // updateNewVenueButtonState/loadInitialData) moved to the very end of
  // audit-board-handlers.js too (2026-09-18+13), same reason as
  // pendingDeepLink just above — it calls functions defined in later
  // files (updateNewVenueButtonState is in audit-board-venues.js;
  // loadInitialData, right above, calls renderAll() from
  // audit-board-detail.js and loadBoardsIndex()/loadPeople() from
  // audit-board-storage.js), so it can't run until every file has
  // actually loaded. `auth` itself stays right here as an ordinary global
  // — reading it later, from a different file, is fine.

  // Canonical (key-order-independent) stringify, used to detect which
  // documents in a saveBoardsIndex/saveBoard array actually changed — see
  // the note above each of those functions for why this matters now that
  // Security Rules authorize writes per-document, not per-batch.
  function stableStringify(x){
    if (Array.isArray(x)) return '[' + x.map(stableStringify).join(',') + ']';
    if (x && typeof x === 'object'){
      return '{' + Object.keys(x).sort().map(function(k){
        return JSON.stringify(k) + ':' + stableStringify(x[k]);
      }).join(',') + '}';
    }
    return JSON.stringify(x);
  }

  function slugify(s){
    return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
  }

  function escapeHtml(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }

  // Abstract text may contain LaTeX ($inline$ / $$block$$, plain-text-typed
  // by whoever filled the field in — see the Edit-fields modal) — render
  // those spans with KaTeX, everything else as plain escaped text. A
  // single regex pass, block delimiters checked first so "$$" is never
  // mistaken for two empty inline formulas. KaTeX's own output is safe
  // HTML (no user string reaches the DOM unescaped outside of it), and a
  // formula KaTeX can't parse falls back to its literal source rather
  // than breaking the whole abstract.
  // Hard limit on the abstract's length (2026-09-18+34, per Eduardo), in
  // characters of the raw text (LaTeX source included).
  var ABSTRACT_MAX_CHARS = 5000;
  function abstractCounterText(length){
    return 'Characters remaining: ' + (ABSTRACT_MAX_CHARS - length);
  }

  function renderAbstractHtml(text){
    if (!text) return '';
    if (typeof katex === 'undefined') return escapeHtml(text);
    var out = '';
    var lastIndex = 0;
    var re = /\$\$([\s\S]+?)\$\$|\$([^\$\n]+?)\$/g;
    var m;
    while ((m = re.exec(text))){
      out += escapeHtml(text.slice(lastIndex, m.index));
      var isBlock = m[1] !== undefined;
      var src = isBlock ? m[1] : m[2];
      try {
        out += katex.renderToString(src, { throwOnError: false, displayMode: isBlock });
      } catch (err){
        out += escapeHtml(m[0]);
      }
      lastIndex = re.lastIndex;
    }
    out += escapeHtml(text.slice(lastIndex));
    return out;
  }

  function showToast(message, kind, durationMs){
    els.toastRegion.innerHTML =
      '<div class="toast-inner ' + (kind === 'error' ? 'error' : 'ok') + '">' + escapeHtml(message) + '</div>';
    setTimeout(function(){
      if (els.toastRegion.innerHTML.indexOf(escapeHtml(message)) !== -1) {
        els.toastRegion.innerHTML = '';
      }
    }, durationMs || 4000);
  }

  // onOk()/onFail() default to a toast if not given — pass your own to show
  // feedback anchored to whatever triggered the copy instead (e.g. a
  // tooltip on the button itself, so nothing else on the page shifts).
  function copyText(text, onOk, onFail){
    if (!text) return;
    function ok(){ (onOk || function(){ showToast('Copied.', 'ok'); })(); }
    function fail(){ (onFail || function(){ showToast('Could not copy — select and copy it manually.', 'error'); })(); }
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(ok, fail);
      return;
    }
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var copied = document.execCommand('copy');
      document.body.removeChild(ta);
      copied ? ok() : fail();
    } catch (e){ fail(); }
  }

