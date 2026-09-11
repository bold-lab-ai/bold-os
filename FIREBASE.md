# Firebase backend — design + migration plan

Decided 2026-09-11: the Internal Review Board moves off per-browser `localStorage` onto a shared Firebase backend (Firestore + Identity Platform for Slack sign-in), because it's a bridge until BOLD OS exists, not a rebuild — see `TODO.md`'s "Shared storage" and "Permissions" sections for the requirements this satisfies. This doc is the concrete design; `TODO.md` stays the aspirational/BOLD-OS-blocked list.

Everything below the data model and Security Rules is buildable **without any credentials** and is either already done or in progress. The "Inputs needed" section at the bottom is the only thing blocking the next step.

**Hosting stays as-is — no Firebase Hosting.** Firestore/Auth/Functions are decoupled from where the static pages are served; the pages keep living wherever `bold-lab.ai` already does (GitHub Pages). The only hosting-adjacent step is adding that domain to Firebase Auth's **Authorized domains** allowlist once Phase 2 (Slack sign-in) starts — a config entry, not a migration.

---

## Phasing

1. **Storage** — Firestore replaces `localStorage`, no auth yet (matches today: no permission layer exists either).
2. **Slack sign-in** — Identity Platform custom OIDC provider.
3. **Permissions** — custom claims (Cloud Function reading Google Workspace group membership) + Security Rules enforcing the two-layer model from `project` memory: group membership = eligibility, per-card `reviewers.*` field = actual authorization.
4. **(Stretch, separate decision)** — Slack channel auto-invite via a bot token, gated on confirming BOLD's Slack plan tier for the workspace-invite half; the channel-invite half works on any plan (bot needs `conversations:write.invites` and must already be a member of any private channel it manages).

## Data model (Firestore, Native mode)

Normalized further than the original "one JSON blob per board" plan, specifically so the two highest-contention writes — ticking a checklist box, and posting a comment — never need a transaction or can conflict with each other. Optimistic concurrency (a `version` field, checked and incremented inside a `runTransaction`) is only needed on the card document itself, for its own mutable fields (status, reviewers, edit-fields, changesRequested, outcome).

```
boards/{boardId}
  venue, year, label, website, deadline, pitchDay, abstractDeadline,
  reviewsPublicDate, rebuttalDeadline, notificationDate, cameraReadyDeadline,
  conferenceDates, location, maxPapersPerAuthor, pageLimit, anonymity,
  submissionSystem, notes, createdAt
  # replaces today's boards-index array entry — one doc per venue+year

  boards/{boardId}/cards/{cardId}
    title, authors[] (last = PI), overleafLink, correspondingAuthorEmail,
    track, computeEstimate, deadline, status, submittedBy{name,uid},
    reviewers{junior,senior}, changesRequested, outcome, submissionLink,
    rebuttalDeadline, rebuttalDocLink, reviewNotes, createdAt, updatedAt,
    version (int)
    # card-level fields only — checklist/discussion/history pulled out below
    # so they never contend with a card-level edit or each other

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

## Security Rules (draft — logic is final, exact Rules-language syntax to be verified against the emulator before deploy)

Two-layer model per the settled design: group membership (custom claims, `request.auth.token.groups`) decides *eligibility* for lab-wide actions; a direct comparison against the card's own `reviewers.junior`/`reviewers.senior` decides *authorization* for that specific card. Stubbed as `true` in the client today (`can(action, card)` in `audit-board.html`) — this is that same predicate, enforced server-side so it can't be bypassed by calling the API directly.

```
function isSignedIn() { return request.auth != null; }
function hasGroup(g)  { return isSignedIn() && g in request.auth.token.groups; }
function isPiOrCoordinator() { return hasGroup('pis') || hasGroup('coordinators'); }

match /boards/{boardId} {
  allow read: if true;
  allow create, delete: if isPiOrCoordinator();

  match /cards/{cardId} {
    allow read: if true;
    allow create: if isSignedIn();
    allow update: if isSignedIn() && (
      request.auth.token.email == resource.data.submittedBy.email ||
      request.auth.token.email in resource.data.reviewers.values() ||
      isPiOrCoordinator()
    );

    match /checklist/{itemId} {
      allow read: if true;
      allow update: if isSignedIn() && (
        (request.resource.data.junior != resource.data.junior &&
         request.auth.token.email == get(/databases/$(database)/documents/boards/$(boardId)/cards/$(cardId)).data.reviewers.junior) ||
        (request.resource.data.senior != resource.data.senior &&
         request.auth.token.email == get(/databases/$(database)/documents/boards/$(boardId)/cards/$(cardId)).data.reviewers.senior)
      );

      match /comments/{commentId} { allow read: if true; allow create: if isSignedIn(); }
    }

    match /discussion/{messageId} { allow read: if true; allow create: if isSignedIn(); }
    match /history/{eventId}      { allow read: if true; allow create: if isSignedIn(); }
  }
}
```

## Cloud Functions

1. **Custom claims on sign-in** — a `beforeSignIn` blocking Auth function: takes the signed-in email, calls the Google Workspace Admin SDK Directory API (`groups.list?userKey=<email>`, read-only `admin.directory.group.readonly` scope, domain-wide-delegated service account), sets `{groups: [...]}` as a custom claim. No separate membership-change listener needed — Firebase ID tokens refresh roughly hourly, so a claim is never more than about an hour stale, which is fine at this scale; avoids needing Admin SDK push notifications.
2. **(Stretch, Phase 4)** `syncSlackChannels` — same trigger, diffs old vs. new group membership, calls Slack's `conversations.invite` for any channel tied to a newly-added group. Needs a bot token with `conversations:write.invites`, and the bot must already be a member of any private channel it's meant to manage.

## Client-side change — done (Phase 1a)

`audit-board.html` now talks to Firestore instead of `localStorage`. The five-function seam (`loadBoardsIndex` / `saveBoardsIndex` / `loadBoard` / `saveBoard` / `deleteBoardData`) is unchanged from the outside — every caller elsewhere in the file is untouched — but internally:

- `boards/{id}` holds venue metadata only (the old boards-index entry shape, minus `id`).
- Each card is its own document in `boards/{id}/cards/{cardId}` — so two people editing *different* cards on the same board never contend. **Not yet done** (deliberately deferred — see below): checklist items, comments, discussion, and history still live embedded on the card document, so `saveBoard(id, {cards})` still upserts every card in the array on every call rather than writing just the changed field. Correct, safe, not yet write-optimized.
- `saveBoardsIndex(list)` / `saveBoard(id, {cards})` are still called with the *full* desired array every time (unchanged contract) — implemented as a Firestore batch: upsert everything in the array, delete any existing doc no longer present.

Loads the Firebase **compat build** (not modular/ES-import) from `gstatic.com`, pinned to `10.14.1` — approved `AGENTS.md` exception to "no CDN scripts, no bundler," applied 2026-09-11.

**Verified working end-to-end against the Firestore emulator** (2026-09-11): venue create → persists → survives a full page reload (twice, clean). Card register → persists → visible after reload. Checklist tick → confirmed via the emulator's own data browser (ground truth, not just the app's own re-render) that `checklist[0].junior` actually flips to `true` in the stored document. All three exercise the real `saveBoard()` write path — the first end-to-end proof this data model round-trips correctly through real Firestore, not just in-memory.

**A note for whoever runs headless-browser tests against this page next:** don't trust a single quick headless-Chrome run that shows a write "didn't land" — early attempts here gave false negatives because `--screenshot` mode's `--virtual-time-budget` can exit the process before a real (non-virtual) network round trip to the emulator finishes; a `db.settings({experimentalAutoDetectLongPolling: true})` speculative fix was tried and made things *worse* (hung outright) and was reverted. What actually worked: no special Firestore settings, generous real delays between DOM steps (~1.5s), and checking the emulator's own data browser directly rather than reloading the app and re-rendering.

## Project status (2026-09-11)

- **Firebase project:** `bold-d7ff2` (display name "BOLD"), created 2026-09-11. Signed in as `edu.pignatelli@gmail.com` via the Firebase MCP server — subsequent Firebase work in this repo uses those tools directly (project/app CRUD, SDK config, Security Rules read, deploy) rather than manual console steps.
- **Web app registered:** `internal-review-board` (`appId: 1:555050367135:web:d90f8d7bb93a755e9fcaaa`). SDK config pulled and recorded below — not secret, safe to commit/embed client-side.
- **Firestore:** enabled, currently `allow read, write: if false` (deny-all) — the safe starting state, left in place deliberately (see below).
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

**Deliberate choice: building against the Firestore emulator, not the live deny-all database, until Phase 1's client code is ready.** Phase 1 has no auth yet, and this is a real cloud project now — flipping Security Rules open to public read/write so the app can actually function pre-auth would mean anyone with the (necessarily public, embedded-in-the-page) config could read and write the board. The emulator gives a full local Firestore with zero production exposure to build and test against; the real cloud rules stay at deny-all until a deliberate decision on when to open them (either once Slack auth is close, or with a narrower interim policy if the shared board needs to go live sooner).

## Inputs needed from Eduardo

**To finish Phase 1 (storage) today:**
- [ ] Confirm the `AGENTS.md` CDN exception below (Firebase SDK from `gstatic.com`) — recommended over hand-rolled REST calls.

**Gather in parallel, not urgent — Phase 2:**
- [ ] Blaze plan upgrade (billing card on file; expected bill ≈ $0/month at this scale — see prior cost estimate).
- [ ] A Slack app with Sign-in-with-Slack / OIDC scopes (`openid profile email`) — Client ID + Secret.

**Gather in parallel, not urgent — Phase 3:**
- [ ] The actual Google Workspace domain name (confirmed not `bold-lab.ai` itself — no MX/TXT on that domain).
- [ ] Domain-wide delegation for a service account (I'll generate its Client ID), scope `admin.directory.group.readonly`, authorized in that Workspace's Admin Console.
- [ ] Group addresses: `seniors@`, `juniors@`, `pis@`, and whether venue create/delete gets its own `coordinators@` or folds into `pis@`.
- [ ] Which admin/service email the delegated calls impersonate.

**Only if we pick up the Phase 4 stretch (Slack channel auto-invite) later:**
- [ ] BOLD's Slack plan tier (gates whether workspace auto-invite, not just channel auto-invite, is possible at all).
