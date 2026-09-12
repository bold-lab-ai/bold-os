# Firebase backend — design + migration plan

Decided 2026-09-11: the Internal Review Board moves off per-browser `localStorage` onto a shared Firebase backend (Firestore + Identity Platform for Slack sign-in), because it's a bridge until BOLD OS exists, not a rebuild — see `TODO.md`'s "Shared storage" and "Permissions" sections for the requirements this satisfies. This doc is the concrete design; `TODO.md` stays the aspirational/BOLD-OS-blocked list.

Everything below the data model and Security Rules is buildable **without any credentials** and is either already done or in progress. The "Inputs needed" section at the bottom is the only thing blocking the next step.

**Hosting stays as-is — no Firebase Hosting.** Firestore/Auth/Functions are decoupled from where the static pages are served; the pages keep living wherever `bold-lab.ai` already does (GitHub Pages). The only hosting-adjacent step is adding that domain to Firebase Auth's **Authorized domains** allowlist once Phase 2 (Slack sign-in) starts — a config entry, not a migration.

---

## Phasing

**Revised 2026-09-11 — simplified for a quick MVP.** Google Workspace Groups + Admin SDK + Cloud Function role lookup (the original Phase 3 below) is **deferred**, not built now — Eduardo: "We will skip this. We just need to know 'who I am' for the moment. And we'll have hardcoded rules for some accounts to manually promot[e] them to PIs etc." Slack establishes identity only; role is a hardcoded email allowlist in `firestore.rules`, manually edited to promote/demote. Google Workspace (and eventually a Wikipedia/MediaWiki-style OAuth from BOLD OS, developed in parallel) are later phases, picked up once each identity provider is actually ready.

1. **Storage** — Firestore replaces `localStorage`, no auth yet (matches today: no permission layer exists either). **Done.**
2. **Slack sign-in** — Identity Platform custom OIDC provider. Establishes identity ("who am I") only — no role/claims. Blaze plan **done** (2026-09-11). UI scaffolding (`#authRegion`, `firebase.auth()`, sign-in/out) added to `audit-board.html`; the `oidc.slack` provider itself and the Slack app are still pending (see "Inputs needed" below).
3. **Permissions (MVP)** — hardcoded email allowlists (`roles/pis`, `roles/admins`, `roles/seniors`, `roles/juniors` in Firestore data, looked up via `get()` from `firestore.rules`), checked against `request.auth.token.email` — no custom claims, no Cloud Function. **Deployed** (2026-09-11); `pis`/`admins` seeded with real emails, `seniors`/`juniors` still empty. See "Security Rules" below.
4. **Permissions (later)** — Google Workspace Groups via the Admin SDK Directory API + a `beforeSignIn` Cloud Function stamping custom claims, once BOLD's Workspace domain/groups are settled. Keeps the same `isPi()`/`isSenior()`/`isJunior()` call sites in Security Rules — only the source of truth changes, from Firestore data to a claim.
5. **(Stretch, separate decision)** — Slack channel auto-invite via a bot token, gated on confirming BOLD's Slack plan tier for the workspace-invite half; the channel-invite half works on any plan (bot needs `conversations:write.invites` and must already be a member of any private channel it manages).

## Data model (Firestore, Native mode)

Normalized further than the original "one JSON blob per board" plan, specifically so the two highest-contention writes — ticking a checklist box, and posting a comment — never need a transaction or can conflict with each other. Optimistic concurrency (a `version` field, checked and incremented inside a `runTransaction`) is only needed on the card document itself, for its own mutable fields (status, reviewers, edit-fields, jrReviewState/srReviewState, outcome).

```
boards/{boardId}
  venue, year, label, website, deadline, pitchDay, abstractDeadline,
  reviewsPublicDate, rebuttalDeadline, notificationDate, cameraReadyDeadline,
  conferenceDates, location, maxPapersPerAuthor, pageLimit, anonymity,
  submissionSystem, notes, createdAt, rushMode (bool, optional),
  status ('approved' | 'pending'), proposedBy ({name,email}, pending only)
  # replaces today's boards-index array entry — one doc per venue+year
  # rushMode: client-only display toggle (2026-09-11, see docs/AGENTS.md
  # guideline 6) — collapses the board to 4 columns. No Security Rules
  # implication: it's just another field on a document create/update
  # already covered by hasFullWrite().
  # status/proposedBy: venue proposals (2026-09-11, branch
  # feature/venue-proposals, NOT YET MERGED/DEPLOYED — see "Venue
  # proposals" below). A board with no `status` field at all is an
  # approved venue predating this feature; get()'s in-rule default
  # covers single-document reads, but see the migration note before
  # this ships — existing boards need a real `status: 'approved'`
  # backfill before the new query-based loadBoardsIndex()/
  # fetchVisibleBoards() go live, since a missing field can't satisfy a
  # `where('status','==','approved')` filter the way it can a rule's
  # `.get(field, default)`.

  boards/{boardId}/cards/{cardId}
    title, authors[] (last = PI; each {name, email} — changed from a plain
    name string, 2026-09-12, so the PI in particular has a real email to
    notify; normalizeCard() migrates old string entries to {name, email: ''}),
    overleafLink, correspondingAuthorEmail,
    computeEstimate, status, submittedBy{name,email,slackId},
    reviewers{junior,senior}, jrReviewState, srReviewState, outcome,
    submissionLink, rebuttalDeadline, rebuttalDocLink, reviewNotes,
    createdAt, updatedAt, version (int)
    # card-level fields only — checklist/discussion/history pulled out below
    # so they never contend with a card-level edit or each other
    # jrReviewState/srReviewState: each reviewer's own sign-off, one of
    # 'in_review' | 'changes_requested' | 'approved' (2026-09-11, see
    # docs/AGENTS.md guideline 6) — replaces an earlier, brief shape
    # (changesRequested + jrApproved/srApproved); normalizeCard() migrates
    # any card still holding that shape. Client-side gated so only the
    # matching card.reviewers[role] email can set it — Security Rules stay
    # whole-document (no field-level check that it's specifically that
    # reviewer writing it).
    # No card-level track/deadline: a card inherits its venue's deadline —
    # a different deadline (a different track, a workshop) is a different
    # venue by convention, not a per-card override. Decided 2026-09-11.
    # submittedBy.email and reviewers.junior/senior are now real emails
    # (populated from Sign-in-with-Slack / the people roster), not free
    # text — see "Security Rules" below for why that matters.

    boards/{boardId}/cards/{cardId}/checklist/{itemId}
      part, category, label, junior (bool), senior (bool)
      # id stays "chk-1".."chk-12" (CHECKLIST_TEMPLATE order) — ticking one
      # is a single-document write, no transaction, no cross-item contention

      boards/{boardId}/cards/{cardId}/checklist/{itemId}/comments/{commentId}
        author, uid, timestamp, body, parentId (null = top-level, or the
        parent comment's id — one level only, enforced by the client never
        offering "Reply" on a comment that already has a parentId)

    boards/{boardId}/cards/{cardId}/discussion/{messageId}
      author, uid, timestamp, body, parentId
      # same flat parentId shape as checklist comments — one code path
      # for both thread types instead of two

    boards/{boardId}/cards/{cardId}/history/{eventId}
      timestamp, actor, action, note
      # append-only, subcollection needs no version field at all
```

Both comment thread types (per-checklist-item feedback, card-level Discussion) share one shape and one flat `parentId` field instead of a nested `replies` array — appends never conflict, and it's one rendering/posting code path instead of two.

**Note: comments/discussion are still embedded arrays on the card document today, not subcollections** — the split shown above (with a flat `parentId`) was the plan, deliberately deferred (see "Client-side change (Phase 1a)" below); the shipped shape is `{ id, author, authorEmail, timestamp, body, replies: [] }`, one level of nested `replies`, not a `parentId`. As of 2026-09-12, `author`/`authorEmail` come from `state.currentUser` (real identity, required sign-in to post) rather than a free-text name typed into the form — same motivating problem as the `authors[]` change above. Older messages predating this only have `author` (free text) and no `authorEmail`.

## Security Rules

**Deployed 2026-09-11** (verified live via `firebase_get_security_rules` and the `firebase` CLI, both matching `firestore.rules` on disk exactly). Two-layer model unchanged in shape: role-list membership decides *eligibility* for lab-wide actions; a direct comparison against the card's own `reviewers.junior`/`reviewers.senior` decides *authorization* for that specific card.

**Role lists live in Firestore data, not as literals in this file.** Originally drafted as hardcoded arrays (`pis()`/`seniors()`/`juniors()` functions returning literal email lists) directly in `firestore.rules`. Revised before deploy: Eduardo wants the option to make the `ml-conference-cycle` repo public, and a public repo would publish real BOLD members' email addresses in plaintext, forever, in git history. So the lists live in Firestore documents instead — `roles/pis`, `roles/admins`, `roles/seniors`, `roles/juniors`, each shaped `{emails: [...]}` — referenced via `get()`. `get()`/`exists()` calls made *from inside* a rule bypass that target document's own rules (this is standard Firestore Security Rules behavior, not a hole) — so `roles/{roleId}` itself stays permanently `allow read, write: if false` for clients, and can only be written via the Firebase Console (project-owner access, which bypasses Security Rules entirely) or an Admin SDK credential — never by `audit-board.html` or anyone using it.

**Admins, added 2026-09-11:** a second full-write role alongside PIs, not folded into `pis()` — "admin" and "PI" aren't the same lab role, but both get the same permissions (venue create/delete, override any card) via a shared `hasFullWrite()`.

**Read gated too, 2026-09-11.** `boards`/`cards` read was `allow read: if true` (public) up to this point, deliberately, while write-gating and identity were still being wired up. Now `isLabMember()`, same as everything else — a real behavior change, not a no-op, since Sign-in-with-Slack is live and tested. `audit-board.html`'s init flow was updated to match: it waits for the first auth-state resolution before attempting to load anything, rather than firing a fetch that can only fail for a signed-out visitor.

```
function isSignedIn() { return request.auth != null; }
function email()      { return request.auth.token.email; }
function roleList(name) {
  return get(/databases/$(database)/documents/roles/$(name)).data.emails;
}
function isPi()         { return isSignedIn() && email() in roleList('pis'); }
function isAdmin()      { return isSignedIn() && email() in roleList('admins'); }
function hasFullWrite() { return isPi() || isAdmin(); }
function isSenior()     { return isSignedIn() && (email() in roleList('seniors') || isPi()); }
function isJunior()     { return isSignedIn() && (email() in roleList('juniors') || isSenior()); }
function isLabMember()  { return isSignedIn(); }

match /roles/{roleId} { allow read, write: if false; }

match /boards/{boardId} {
  allow read: if isLabMember();
  allow create, delete, update: if hasFullWrite();

  match /cards/{cardId} {
    allow read: if isLabMember();
    allow create: if isLabMember();
    // A card can be changed only by whoever created it, a reviewer
    // assigned to it, or a PI/admin — decided 2026-09-11.
    //
    // Reassigning reviewers is narrower still (also 2026-09-11): the
    // `reviewers` field specifically may only change if the writer is
    // the submitter or a PI/admin — an assigned reviewer can edit
    // everything else on their own card but can't reassign reviewers.
    allow update: if isLabMember() && (
      email() == resource.data.submittedBy.email ||
      email() == resource.data.reviewers.junior ||
      email() == resource.data.reviewers.senior ||
      hasFullWrite()
    ) && (
      request.resource.data.reviewers == resource.data.reviewers ||
      email() == resource.data.submittedBy.email ||
      hasFullWrite()
    );
    allow delete: if isLabMember() && (
      email() == resource.data.submittedBy.email ||
      email() == resource.data.reviewers.junior ||
      email() == resource.data.reviewers.senior ||
      hasFullWrite()
    );
  }
}
// (checklist/comments/discussion/history subcollections not yet split out —
// see "Client-side change" below; their rules follow the same shape once they are)
```

**Reviewer reassignment narrowed to submitter/PI/admin only, 2026-09-11.** Eduardo asked to confirm who could assign reviewers; turned out the base `update` condition alone let *any* already-assigned reviewer also reassign reviewers (whole-document rule, no field distinction) — not just the submitter/PI/admin the question assumed. Added a second `&&` clause to `update` specifically: the `reviewers` map may only actually change if the writer is the submitter or a PI/admin (compared by map equality — the client only ever rewrites `reviewers` as a whole, via `onSetReviewer`, so no per-key diffing needed). The base condition (submitter/junior/senior/PI-admin) still gates every other field, so an assigned reviewer keeps full access to their own card's checklist, review state, discussion, and status — just not to who the reviewers are. `delete` was split into its own `allow` statement, unchanged in condition, since the new clause is update-specific (a `request.resource.data` diff doesn't apply to a delete). **Not mirrored client-side**: `reviewerInputHtml()`'s picker stays enabled for every signed-in lab member (only a `title` hint added for a non-owner) — PI/admin status isn't client-readable (`roles/{roleId}` stays deny-all), so disabling it for "not the owner" would also block a real PI/admin from ever using it, the same constraint already accepted for Rush mode's toggle. A disallowed save still fails cleanly with the existing permission-denied toast.

**`roles/pis` and `roles/admins` are seeded and live** (2026-09-11) — 6 PIs, 3 admins, written via a one-off Admin SDK script (Node, `firebase-admin`) run from a service-account key Eduardo generated in Firebase Console, verified by reading both documents back afterward. The key file was deleted immediately after (never committed — it landed in this repo's own folder from the browser download, caught before `git add`, moved out and shredded) and Eduardo was asked to revoke the key itself in Console (Project Settings → Service Accounts → Keys) since a live Admin SDK key grants full database access regardless of Security Rules, and there was no reason to leave a standing one behind for a one-time job. `roles/seniors` and `roles/juniors` are still unseeded — no junior/senior reviewer assignments possible until those exist too.

**Deployed, but a no-op in practice today, and here's why that's fine.** `isSignedIn()` is always false until the `oidc.slack` provider exists and someone can actually sign in — so nothing changes in production behavior yet, this is safe to have live even with real role data seeded. Real, separate blocker for when Slack sign-in *does* go live: `submittedBy.email` and `reviewers.junior`/`reviewers.senior` assume real signed-in emails, but as of Phase 1a **they don't hold that** — `submittedBy` is `{name, slackId}` (a free-text name typed into a "Stand-in for Slack login" field) and `reviewers.junior`/`reviewers.senior` are free-text names from the shared people-autocomplete. That still needs fixing (wiring `state.currentUser.email` into both) before the per-card `update` rule can match anyone real — tracked in the "Client-side change (Phase 2)" section above.

## Venue proposals (2026-09-11) — built on `feature/venue-proposals`, NOT YET SHIPPED

Eduardo: any lab member should be able to propose a new venue, through the exact same form admins/PIs use, but a proposal is only visible to its proposer and to PI/admin — with an Approve button — until approved. Also the trigger for moving development onto a branch first: the site's live and in real use now, so this and future features get built and reviewed on a branch before merging to `main`/deploying, rather than going straight to production like every earlier feature this session did.

**Data model:** `boards/{boardId}` gets two new fields — `status` (`'approved'` or `'pending'`; missing means `'approved'`, for backward compatibility with every board created before this existed) and `proposedBy` (`{name, email}`, pending proposals only, mirrors a card's `submittedBy`).

**Security Rules** (already written, in `firestore.rules` on the branch): `read` now requires `status != 'pending'` OR `hasFullWrite()` OR being the proposer (`.get('status','approved')` covers the missing-field case for a *single-document* read). `create` still allows a direct `status:'approved'` create for `hasFullWrite()` only, same as before, but now also allows anyone signed in to create a doc with `status:'pending'` **and** `proposedBy.email` matching their own email — self-attributed only, can't propose in someone else's name. `update`/`delete` are unchanged (`hasFullWrite()` only) — approving is just an update (flips `status`), and rejecting is just a delete, same as `onDeleteBoard()` already needed.

**The hard part was list queries, not single-doc reads.** Firestore rejects a *whole* `collection.get()`/`.where()` query outright if any candidate document in it could fail the read rule for this requester — it doesn't silently filter out the ones that fail. A plain `boards.get()` (what `loadBoardsIndex()`/`saveBoardsIndex()` always did) would therefore start failing for non-admins the moment any pending proposal exists that isn't theirs. Fixed by replacing it everywhere with `fetchVisibleBoards()`, which runs three separate, purpose-built queries in parallel instead of one unconstrained one:
1. `where('status','==','approved')` — always succeeds, the whole lab.
2. `where('status','==','pending').where('proposedBy.email','==', me)` — always succeeds, my own proposals.
3. `where('status','==','pending')`, unfiltered — succeeds **only** for someone with `hasFullWrite()`, since that's the only way the rule can hold across every possible result without an ownership filter.

Query 3's success/failure is also how the client learns whether to show the "Pending your approval" section and the Approve/Reject controls at all — there's no other way to ask, since `roles/{roleId}` stays permanently unreadable by clients (same constraint as Rush mode's own permission check, `docs/AGENTS.md` guideline 6). This can vacuously succeed for a genuine non-admin in the edge case where zero *other* people's proposals currently exist (nothing to violate the rule against) — harmless: it can only ever hand back their own proposal, and an Approve/Reject click against it still fails server-side (`update`/`delete` stay `hasFullWrite()`-only), same graceful failure as any other disallowed write in this app.

**Reviewing a proposal is now a click-in, not a blind list action (revised 2026-09-11, same day).** Every venue row — approved or pending — opens the normal venue page; a pending one shows a "Pending approval" badge, a `proposerLabel()`-rendered "Proposed by Name (email)" line (deliberately always both — a bare name wasn't enough to tell two pending proposals apart at a glance), the empty board, and no "+ Register paper" button at all (revised again same day — it used to render disabled-with-a-tooltip; Eduardo: it shouldn't be there at all on a pending venue, not just unusable — `renderBoard()` omits it entirely when `current.status === 'pending'`, `openModal()`'s existing check stays as a defense-in-depth backstop). Approve and a new **Reject** button live in that page's header (next to Edit venue), shown only when `state.canApproveVenues`. `onRejectVenue(id)` is the same underlying write as `onDeleteBoard()` — nothing's worth keeping on an unapproved venue, and there's no rejection-reason field in the schema — but gets its own confirm dialog and toast wording, and is a visually separate button from "Delete this venue" (which now only renders once a venue is actually `'approved'` — deleting a live venue with real registered papers is a much bigger, scarier action than declining a proposal that never went anywhere).

**Revised again same day, per Eduardo: reviewing shouldn't need a click-in first.** Approve/Reject now also appear inline on the "Pending your approval" list row itself, not just the detail page — both places call the same `onApproveVenue`/`onRejectVenue`. This meant the pending row with actions could no longer be the whole-row `<button>` the rest of the list uses (a button can't contain other buttons) — it's now a `<div>` with its own small nested clickable name (`.venue-name-btn`) plus the two action buttons as siblings. Styling: `.btn-approve`/`.btn-reject` — same size and weight as any other `.btn`, just filled green/red, a deliberately neutral either-way pairing rather than a primary/plain one that would visually imply a "default" answer. Also: **"+ New venue" now reads "+ Propose venue"** for anyone who isn't a confirmed PI/admin (`updateNewVenueButtonState()`, driven by `state.canApproveVenues`), and the modal's own title/submit-label follow suit ("Propose new venue"/"Propose" vs. "New venue"/"Create") — same form, same `onCreateBoard()` either way, just honest labeling about which one it'll actually be.

**`onCreateBoard()` doesn't pre-decide whether to propose or create directly.** There's no reliable client-side "am I PI/admin" check to branch on (see above), so it always attempts the real thing first — a direct `status:'approved'` create, exactly like before — and only falls back to a self-attributed pending create on the *specific* failure that means "you're not PI/admin" (a `permission-denied` write), never on any other error. A PI/admin's own attempt just succeeds on the first try, indistinguishable from today.

**Required before this can actually deploy: a one-time data migration.** Every board created before this feature has no `status` field at all. A rule's `resource.data.get('status','approved')` safely defaults that for a *single-document* read, but a **query** filter (`where('status','==','approved')`) can't match a field that structurally isn't present — so the moment the new rules + query-based `loadBoardsIndex()` go live together, every pre-existing venue would vanish from the "approved" list for everyone until backfilled. The fix is straightforward (write `status: 'approved'` onto every existing board document) but needs to happen **before** flipping over, using the *old*, still-unconstrained rules — not attempted yet, since this is still branch-only. When it's time to ship: backfill first (a PI/admin session running old client code against old rules can do this via the existing `saveBoardsIndex()`), confirm every board has `status` set, *then* deploy the new rules and the new client code together.

**Not built, deliberately out of scope for this pass:** a proposer can't edit or withdraw their own pending proposal once submitted (same `update`/`delete` = `hasFullWrite()`-only as everything else); no record kept of a rejected proposal (its board doc is just gone — no audit trail, no notification to the proposer that it was rejected or why). Also: the compound query in step 2 above (`status` + `proposedBy.email`, both equality filters) *should* work against Cloud Firestore's automatic indexing without a composite index — pure-equality compound queries generally do — but this hasn't been verified against a live project yet; if it turns out to need one, Firestore's own error on first real use names the exact index to add to `firestore.indexes.json`.

## Cloud Functions

### Slack notifications (`ml-conference-cycle#1`) — built and deployed 2026-09-12, LIVE

**Deployed and verified working end-to-end against real Slack** — both functions created successfully on the second attempt (first hit the well-known first-time-Gen2-functions `Permission denied while using the Eventarc Service Agent` propagation delay; retrying a few minutes later succeeded, per Google's own error message). A 1-day Artifact Registry cleanup policy was set (`firebase functions:artifacts:setpolicy`) so old container images don't accumulate. Eduardo created a real test venue/paper against production and confirmed real DMs landing on multiple test actions. `feature/slack-notifications` (the branch) isn't merged to `main` yet, but the Cloud Functions themselves are live regardless — a `firebase deploy --only functions` isn't gated on which branch is checked out in git the way GitHub Pages' auto-deploy-from-`main` is.

The project's first Cloud Function, and the first server-side code of any kind — everything before this ran entirely client-side (`audit-board.html` talking straight to Firestore/Storage, authorized by Security Rules). A Slack DM needs a **Bot token** (`chat:write` + `im:write` scopes), a real credential that can never live in the client's source, so something server-side has to hold it and make the call. `functions/index.js` is that something.

**Two Firestore-triggered functions**, both region-pinned to `europe-west2` (same as Firestore itself):
- `onVenueProposed` (`onDocumentCreated` on `boards/{boardId}`) — fires when a venue is created with `status: 'pending'`; DMs every PI and admin (from `roles/pis`/`roles/admins`, read via the Admin SDK, which bypasses Security Rules entirely — this is server-side privileged code, not a client) that a proposal needs their approval.
- `onCardWritten` (`onDocumentWritten` on `boards/{boardId}/cards/{cardId}`) — one trigger, several independent checks against the same before/after diff, since a single write can imply more than one notification at once (e.g. a reviewer's last tick both sets their review state *and* auto-advances the card in the same write — see `onSetReviewState`/`onToggleChecklist` in `audit-board.html`):
  - A reviewer sets their sign-off (Approved/Changes requested), or both approve and the card auto-advances → DMs the submitter.
  - Someone's newly assigned as junior/senior reviewer → DMs that person (not whoever they replaced).
  - The card's status changes at all → DMs the submitter.
  - The card reaches the PI-approval step (`status` becomes `pi_polish`) → DMs the PI specifically (the last entry in `authors` — see below for why that's now reliable) in addition to the general status-change DM above.
  - A new Discussion message or checklist-item comment appears — routing depends on which and, for Discussion, whether it's a top-level post or a reply (see "Comment routing" below).

**Design: a pure decision function, then a thin I/O wrapper.** `cardEventsToNotify(before, after, title, boardId, cardId)` computes *what* to notify — a list of `{ emails, headline, excludeEmail? }` — with zero I/O (no Firestore, no Slack, no `await` at all); the actual trigger just resolves each event's emails to Slack ids (`slackIdForEmail`, one `people` collection lookup per email — the roster is already synced from Slack's `users.list`, no live `users.lookupByEmail` call needed) and sends it (`chat.postMessage` after `conversations.open`, plain `fetch` against the Slack Web API, no SDK dependency — same minimal-deps preference as the rest of this project). Keeping the decision logic pure is what makes it unit-testable without a live Firestore emulator or a real Slack workspace: 36 standalone cases (every trigger, several multi-event-in-one-write cases, the "no email on file" no-op case, the deep-link URL, every comment-routing branch) verified before/after each round of this was wired to real Slack.

**This depends on the author/comment identity fixes from the same day** (see docs/AGENTS.md guideline 8 and the "still embedded arrays" note above) — before those, the PI had no reliable email (`authors` was free text) and neither did a comment's poster. `dmByEmail`/`sendEvent` silently no-op (log only, never throw) for anyone with no email or no matching `people` roster entry, so an old, not-yet-migrated card just produces fewer notifications rather than an error.

**Message design — went through several rounds of live feedback the same day, this is the current state:**

- **Deep links.** `audit-board.html` gained real, bookmarkable URLs — `history.pushState()`'s third argument (the actual browser URL) was never set before this, so a link *into* the app could only ever land on the front door. `stateUrl(view, boardId, cardId, baseUrl)` builds a hash (`#board=<id>` or `#board=<id>&card=<id>` — a hash, not a real path, since this is a static GitHub Pages site with no server-side routing) and `pushNavState()` passes it as `pushState`'s third argument; `parseDeepLinkHash(hash)`/`applyPendingDeepLink()` restore straight to that venue/card on a fresh page load (once boards are loaded — a missing venue and one that exists but isn't visible to this viewer get the identical toast, deliberately not distinguished). `functions/index.js` mirrors the same hash scheme by hand (`venueUrl(boardId)`/`cardUrl(boardId, cardId)`, same discipline as `STATUS_LABEL`).
- **The linked title is the message's one clickable element — no separate button.** `linkedTitle(text, url)` produces `<url|*text*>`, Slack mrkdwn's bold-link syntax; every headline's paper/venue name goes through it. An earlier version sent real Slack Block Kit (`blocks`, a button below the headline) — removed the same day once the title itself became clickable, since a separate button was a redundant second link to the same place. Back to plain `text` (Slack's default `mrkdwn: true` already renders the bold link correctly, no `blocks` needed).
- **Emoji, regrouped by meaning, not one-per-event-type.** 🔔 = "this needs a decision from you" (a venue proposal awaiting approval, a card reaching PI-approval). 🔍 = "you've been handed a reviewing task" (assigned as junior/senior reviewer). ✅/❌/↩️ = a reviewer's own sign-off outcome (approved / changes requested / reverted to in-review) — one per role that changed, leading the message (so a mixed outcome — one role approves, the other requests changes in the same write — shows both glyphs up front, e.g. `✅❌`), not folded into a single ambiguous icon. ➡️ = a plain status change, 💬 = a comment — both unchanged throughout.
- **Comment routing** (revised from "always DM submitter + both reviewers except the poster" once real testing showed that over-notified): Discussion and checklist comments now route differently. A **new top-level Discussion message** still goes to every stakeholder (submitter + both reviewers) except the poster. A **reply** goes only to the people already in *that* thread — the top-level message's author plus anyone who'd replied before this one — so replying inside one side conversation doesn't loop in someone who was never part of it. A **checklist-item comment** is treated as a submitter↔reviewer conversation, not a stakeholder broadcast: the submitter posting notifies *both* reviewers (one shared thread per item has no way to tell which reviewer it's meant for), but either reviewer posting notifies *only* the submitter, not the other reviewer (the two review passes are independent) — anyone else posting falls back to notifying the submitter.

**To actually deploy this:**
1. Add `chat:write` + `im:write` Bot Token Scopes to the Slack app (https://api.slack.com/apps → the app → OAuth & Permissions) and **Reinstall to Workspace** — this regenerates the Bot token. (`canvases:read`/`canvases:write` are worth adding in the same reinstall for a possible later notification-history-log feature, discussed but not built — see `ml-conference-cycle#1`'s comments.)
2. Set the token as a Cloud Functions secret, never in the repo or passed through the client: `firebase functions:secrets:set SLACK_BOT_TOKEN --project bold-d7ff2`.
3. `firebase deploy --only functions --project bold-d7ff2`.

**Not built, deliberately out of scope for this pass:** no rate-limiting/throttling on a chatty card (every single event sends immediately); no digest/batching (a burst of activity sends a burst of DMs); no per-person notification preferences or opt-out; no canvas-based notification history (Eduardo's idea, flagged as a genuine follow-up once the DM-sending itself is confirmed working).

### Deferred Google Workspace Groups custom claims (Phase 4, not MVP) — 2026-09-11

The MVP permission model needs no Cloud Function at all for this part: hardcoded email lists in Security Rules are evaluated entirely server-side, no claim-stamping step required. This section is the plan for when Google Workspace Groups replaces the hardcoded lists (see "Phasing").

1. **Custom claims on sign-in** — a `beforeSignIn` blocking Auth function: takes the signed-in email, calls the Google Workspace Admin SDK Directory API (`groups.list?userKey=<email>`, read-only `admin.directory.group.readonly` scope, domain-wide-delegated service account), sets `{groups: [...]}` as a custom claim. No separate membership-change listener needed — Firebase ID tokens refresh roughly hourly, so a claim is never more than about an hour stale, which is fine at this scale; avoids needing Admin SDK push notifications.
2. **(Stretch, Phase 5)** `syncSlackChannels` — same trigger, diffs old vs. new group membership, calls Slack's `conversations.invite` for any channel tied to a newly-added group. Needs a bot token with `conversations:write.invites`, and the bot must already be a member of any private channel it's meant to manage.

## Client-side change — done (Phase 1a)

`audit-board.html` now talks to Firestore instead of `localStorage`. The five-function seam (`loadBoardsIndex` / `saveBoardsIndex` / `loadBoard` / `saveBoard` / `deleteBoardData`) is unchanged from the outside — every caller elsewhere in the file is untouched — but internally:

- `boards/{id}` holds venue metadata only (the old boards-index entry shape, minus `id`).
- Each card is its own document in `boards/{id}/cards/{cardId}` — so two people editing *different* cards on the same board never contend. **Not yet done** (deliberately deferred — see below): checklist items, comments, discussion, and history still live embedded on the card document, so `saveBoard(id, {cards})` still upserts every card in the array on every call rather than writing just the changed field. Correct, safe, not yet write-optimized.
- `saveBoardsIndex(list)` / `saveBoard(id, {cards})` are still called with the *full* desired array every time (unchanged contract) — implemented as a Firestore batch: upsert everything in the array, delete any existing doc no longer present.

Loads the Firebase **compat build** (not modular/ES-import) from `gstatic.com`, pinned to `10.14.1` — approved `AGENTS.md` exception to "no CDN scripts, no bundler," applied 2026-09-11.

**Verified working end-to-end against the Firestore emulator** (2026-09-11): venue create → persists → survives a full page reload (twice, clean). Card register → persists → visible after reload. Checklist tick → confirmed via the emulator's own data browser (ground truth, not just the app's own re-render) that `checklist[0].junior` actually flips to `true` in the stored document. All three exercise the real `saveBoard()` write path — the first end-to-end proof this data model round-trips correctly through real Firestore, not just in-memory.

**A note for whoever runs headless-browser tests against this page next:** don't trust a single quick headless-Chrome run that shows a write "didn't land" — early attempts here gave false negatives because `--screenshot` mode's `--virtual-time-budget` can exit the process before a real (non-virtual) network round trip to the emulator finishes; a `db.settings({experimentalAutoDetectLongPolling: true})` speculative fix was tried and made things *worse* (hung outright) and was reverted. What actually worked: no special Firestore settings, generous real delays between DOM steps (~1.5s), and checking the emulator's own data browser directly rather than reloading the app and re-rendering.

## Client-side change — Sign-in-with-Slack live and tested (Phase 2)

Added to `audit-board.html` 2026-09-11:

- Firebase **auth-compat** SDK script tag (`firebase-auth-compat.js`, same pinned `10.14.1`, same `gstatic.com` exception).
- Masthead restructured: `.masthead-right` wraps the existing "Internal" sub-label and a new `<div id="authRegion">`, styled to sit together.
- `firebase.auth()` initialized alongside `firebase.firestore()`. **Two separate emulator flags**, not one: `FIRESTORE_USE_EMULATOR` and `AUTH_USE_EMULATOR`. The `oidc.slack` custom provider only exists on the real (Console-configured) Firebase Auth backend, not the local Auth emulator — so testing real Slack sign-in needs `AUTH_USE_EMULATOR = false` even while `FIRESTORE_USE_EMULATOR` stays `true` (keeps test writes off production data). Mixing real Auth with the Firestore emulator is a supported pattern — the emulator accepts real Firebase ID tokens.
- `state.currentUser` tracks `{email, name, photoURL} | null` via `onAuthStateChanged`; `renderAuthRegion()` shows a "Sign in with Slack" button (signed out) or the user's name **and email** + a "Sign out" control (signed in — both shown together deliberately, so the email claim landing correctly is visible at a glance, not just trusted).
- Sign-in calls `auth.signInWithPopup(new firebase.auth.OAuthProvider('oidc.slack'))` with `openid profile email` scopes.

**Tested end-to-end 2026-09-11 — works.** Eduardo created the Slack app, configured `oidc.slack` in Firebase Console, and signed in for real against `http://localhost:8137/audit-board.html` (Firestore on the local emulator, Auth against the live backend). Confirmed: popup completes, `#authRegion` shows real name + email, matching what the Security Rules need.

**Bug found and fixed during that same test: `saveBoard`/`saveBoardsIndex` blindly re-`.set()` every document in their array on every call** (see "Client-side change (Phase 1a)" above — this was flagged there as "not yet write-optimized," a performance note; it turned out to also be a **correctness** bug once per-document Security Rules went live). Re-`.set()`-ing an unchanged document is an `update` for rules purposes, so it re-triggers that document's own authorization check — meaning registering a new paper on a board that already had someone *else's* card failed outright, purely because the batch also (harmlessly, but still requiring authorization) re-wrote that unrelated card. Fixed: both functions now diff against the freshly-fetched Firestore snapshot (via a canonical `stableStringify`, key-order-independent) and only write documents that actually changed. Verified via the emulator's raw data after the fix: an old test card was left untouched while a new one was added in the same call. This would have broken real multi-user usage in production the moment any board had more than one person's cards on it — good thing it surfaced now, in testing, not after rollout.

**Decided 2026-09-11, now working end-to-end:** board/card writes are sign-in-gated. A card can be changed only by whoever created it, a reviewer assigned to it, or a PI/admin — matches the Security Rules exactly.

## Client-side change — real identity in the registration form + reviewer picker

Done 2026-09-11, closing the gap the previous section flagged as open (`submittedBy`/`reviewers` were free text, not real emails):

- **Corresponding author email and Submitted by are no longer form fields.** Both are set automatically from `state.currentUser` (email, and display name) when a paper is registered — `correspondingAuthorEmail: state.currentUser.email`, `submittedBy: {name, email, slackId: null}`. The register modal shows a one-line "Registering as X (email)" instead. Registering a paper now requires being signed in (`requireSignedIn()` — guards both the **+ Register paper** button, disabled with a tooltip when signed out, and `onAddCard()` itself as defense in depth).
- **`submittedBy` is no longer editable after registration** — dropped from the edit-card modal entirely (it's what Security Rules authorize edits against, not free-form metadata to reassign). `correspondingAuthorEmail` stays editable there, since it's just paper metadata, not a rules-relevant field.
- **This is what actually makes the per-card `update` rule work for non-admins now**: `submittedBy.email` is a real address, so "whoever created it... can change it" is no longer only true for PIs/admins.
- **Reviewer picker (Junior/Senior) is now a `<select>` over the real Slack roster**, not a free-text input — see "Security Rules" for the `roles`/`people` split and why `people` exists. Storing the person's actual email (not a display name) is what lets the per-card rule recognize an assigned reviewer at all. The Authors field (and PI, its last entry) stays free text with roster-backed suggestions — a paper can have co-authors outside this Slack workspace, so a closed picker would be wrong there.
- **`people` collection**: synced from Slack's `users.list` Web API (274 real, non-bot members, all with emails) via a one-off Admin SDK script — same pattern as `roles`, not automated/scheduled. `firestore.rules` updated: `people/{personId}` readable by any signed-in lab member, write-denied to clients.
- **Per-card deadline override removed.** A card now always inherits its venue's deadline (`effectiveDeadline` no longer checks `card.deadline`) — a paper on a different track or with a different deadline is a different venue by convention, so there's no case where a card needs its own. Card-level `track` was removed for the same reason, in the same pass.

## Cloud Storage — subscribable calendar feed (Phase 2, 2026-09-11)

The old "Subscribable deadline feed" TODO item was blocked for as long as this was a static-page-only project — no server meant no stable URL for calendar apps to poll. Unblocked now: **Cloud Storage, not a Cloud Function** (see the design discussion when this was picked — client already builds the exact `.ics` bytes for the download button; a Function would just regenerate the same thing server-side for no real benefit at this scale, and would be the project's first Cloud Function, a bigger step than needed here).

- `syncVenueIcs(v)` reruns `buildIcs(v)` (unchanged) and uploads to `venues/{boardId}/feed.ics` in the default bucket whenever a venue is created or edited (`onCreateBoard`/`onSaveVenue`, best-effort — a failure here doesn't fail the venue save itself, just logs). `onDeleteBoard` deletes the published file too. If a venue's deadline is ever cleared, the file is deleted rather than left stale.
- **Public URL is constructed deterministically**, not via `getDownloadURL()`: `https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{encoded path}?alt=media`. No token needed — the object is genuinely public via `storage.rules`, so `getDownloadURL()`'s share-token mechanism would just be misleading (implies "secret link" when it isn't one).
- **`storage.rules`**: `venues/{boardId}/feed.ics` is `allow read: if true` (the whole point — calendar apps fetch it unauthenticated); write requires being a PI or admin, checked via `firestore.get(/databases/(default)/documents/roles/pis).data.emails` (and `roles/admins`) — Storage rules can't call Firestore-rules functions directly, so the `hasFullWrite()` check is re-spelled out here against the same underlying data. Everything else in the bucket is deny-all.
- **UI**: a "Subscribe to calendar" button next to the existing "Add to calendar (.ics)" download button copies the URL and shows a small anchored tooltip with instructions ("paste into your calendar app's Subscribe by URL option") — deliberately not the page's normal toast (`#toastRegion` sits in normal document flow and shifts page content when it appears; a tooltip anchored to the button doesn't).

**Setup saga worth remembering if this ever needs debugging again:** enabling Storage for a brand-new project (via Console → Storage → Get started) created a bucket literally named `bold-d7ff2` — but the project's own config (`FIREBASE_CONFIG.storageBucket`, Project Settings' SDK snippet, `firebase_get_sdk_config` — all three agreed) expected `bold-d7ff2.firebasestorage.app`. `firebase deploy --only storage` kept failing with "Firebase Storage has not been set up," which was misleading — Storage *was* set up, just under the wrong bucket name. Confirmed via direct Google Cloud Storage API calls (404 for the expected name = genuinely doesn't exist; 401 for the actual name = exists, just not anonymously readable — a real, diagnostic difference, not the same "no" from two different causes). Fixed by finding/selecting the correctly-named bucket in Console directly (Eduardo found it by trying `gs://bold-d7ff2.firebasestorage.app` directly in the Console UI) rather than the auto-offered default. A second, unrelated Storage Rules gotcha hit right after: `match /venues/{boardId}.ics` doesn't compile — a `{wildcard}` can't be combined with literal characters in the same path segment. Fixed by using a subfolder instead: `match /venues/{boardId}/feed.ics`.

## Project status (2026-09-11)

- **Firebase project:** `bold-d7ff2` (display name "BOLD"), created 2026-09-11. Signed in as `edu.pignatelli@gmail.com` via the Firebase MCP server — subsequent Firebase work in this repo uses those tools directly (project/app CRUD, SDK config, Security Rules read, deploy) rather than manual console steps.
- **Web app registered:** `internal-review-board` (`appId: 1:555050367135:web:d90f8d7bb93a755e9fcaaa`). SDK config pulled and recorded below — not secret, safe to commit/embed client-side.
- **Firestore:** enabled, real Security Rules deployed and actually in effect (see "Security Rules") — Sign-in-with-Slack is live, and `audit-board.html` points at this project for real (not the emulator) as of 2026-09-11.
- **Local project scaffolding:** `firebase.json`, `firestore.rules` (mirrors the deployed deny-all), `firestore.indexes.json` (empty — no composite indexes needed yet), `.firebaserc` (default project `bold-d7ff2`) all created in this directory via `firebase_init`.
- **Region confirmed:** `europe-west2` (London) — `firebase.json`'s `location` field corrected to match (was `nam5`, the init tool's own default, never actually verified against reality until now).

```js
// bold-d7ff2 web app config — not secret
{
  apiKey: "AIzaSyDNKEMYuV0gehbKoM2acafzVbBQL489yDY",
  authDomain: "bold-d7ff2.firebaseapp.com",
  projectId: "bold-d7ff2",
  storageBucket: "bold-d7ff2.firebasestorage.app",
  messagingSenderId: "555050367135",
  appId: "1:555050367135:web:d90f8d7bb93a755e9fcaaa",
  measurementId: "G-527H8R28KB"
}
```

**Superseded — the app is live against real production Firestore now (2026-09-11).** Originally built against the emulator only, deny-all in production, until auth existed (see the git history of this section for that reasoning while it applied). Real Security Rules deployed once Sign-in-with-Slack worked; `roles`/`people` seeded with real data; `FIRESTORE_USE_EMULATOR` in `audit-board.html` flipped to `false` the same day, after a real second user hit a silent failure caused by the client still pointing at a local test emulator that only ever existed on one laptop — see `docs/changelog.md`. Local dev still flips both `FIRESTORE_USE_EMULATOR`/`AUTH_USE_EMULATOR` to `true` (see `docs/AGENTS.md`), just never commits them that way.

## Inputs needed from Eduardo

**Phase 1 (storage) — done.** CDN exception confirmed 2026-09-11, applied to `AGENTS.md`.

**Phase 2 (Slack sign-in) — in progress:**
- [x] Blaze plan upgrade — done 2026-09-11.
- [ ] **A Slack app** — I can't create this myself, it needs Eduardo's own Slack login. Steps: api.slack.com/apps → Create New App → From scratch → pick the BOLD workspace → **OAuth & Permissions**: add `openid`, `profile`, `email` as *User Token Scopes* under "Sign in with Slack" (or enable the pre-built "Sign in with Slack" option if the Slack UI offers it directly) → **Basic Information** for the Client ID + Client Secret. The redirect URL Slack needs goes in `Sign-in with Slack` (or OAuth) → *Redirect URLs*, and that value comes from Firebase Console (below), so do the Firebase half first.
- [ ] **Firebase Console, manual step (not available via my MCP tooling — confirmed by reading the `firebase://guides/init/auth` resource, which only supports `anonymous`/`emailPassword`/`googleSignIn`)**: Authentication → Sign-in method → Add new provider → OpenID Connect. Provider ID: `oidc.slack`. Issuer URL: `https://slack.com`. Client ID + Client Secret: from the Slack app above (the secret goes in Console only — never embedded client-side, unlike the rest of `FIREBASE_CONFIG`). Saving this step gives the redirect URL Slack's Redirect URLs field needs. Say when ready and I'll walk this half live, step by step.

**Phase 3 (MVP permissions) — mostly done:**
- [x] `roles/pis` (6) and `roles/admins` (3) seeded 2026-09-11 with real emails, via a one-off Admin SDK script run from a Console-generated service-account key (deleted immediately after; Eduardo revoked the key in Console).
- [ ] `roles/seniors` and `roles/juniors` — still empty, no one can be assigned as a reviewer yet. Same process as above once there's a list, or just via Console directly (Firestore Database → `roles` collection → new doc, id `seniors`/`juniors`, one `emails` array field).

**Gather in parallel, not urgent — Phase 4 (Google Workspace Groups, later):**
- [ ] The actual Google Workspace domain name (confirmed not `bold-lab.ai` itself — no MX/TXT on that domain).
- [ ] Domain-wide delegation for a service account (I'll generate its Client ID), scope `admin.directory.group.readonly`, authorized in that Workspace's Admin Console.
- [ ] Group addresses: `seniors@`, `juniors@`, `pis@`, and whether venue create/delete gets its own `coordinators@` or folds into `pis@`.
- [ ] Which admin/service email the delegated calls impersonate.

**Only if we pick up the Phase 5 stretch (Slack channel auto-invite) later:**
- [ ] BOLD's Slack plan tier (gates whether workspace auto-invite, not just channel auto-invite, is possible at all).
