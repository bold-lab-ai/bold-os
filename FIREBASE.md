# Firebase backend — design + migration plan

Decided 2026-09-11: the Internal Review Board moves off per-browser `localStorage` onto a shared Firebase backend (Firestore + Identity Platform for Slack sign-in), because it's a bridge until BOLD OS exists, not a rebuild — see `TODO.md`'s "Shared storage" and "Permissions" sections for the requirements this satisfies. This doc is the concrete design; `TODO.md` stays the aspirational/BOLD-OS-blocked list.

Everything below the data model and Security Rules is buildable **without any credentials** and is either already done or in progress. The "Inputs needed" section at the bottom is the only thing blocking the next step.

**Hosting stays as-is — no Firebase Hosting.** Firestore/Auth/Functions are decoupled from where the static pages are served; the pages keep living wherever `bold-lab.ai` already does (GitHub Pages). The only hosting-adjacent step is adding that domain to Firebase Auth's **Authorized domains** allowlist once Phase 2 (Slack sign-in) starts — a config entry, not a migration.

---

## Phasing

**Revised 2026-09-11 — simplified for a quick MVP.** Google Workspace Groups + Admin SDK + Cloud Function role lookup (the original Phase 3 below) is **deferred**, not built now — Eduardo: "We will skip this. We just need to know 'who I am' for the moment. And we'll have hardcoded rules for some accounts to manually promot[e] them to PIs etc." Slack establishes identity only; role is a hardcoded email allowlist in `firestore.rules`, manually edited to promote/demote. Google Workspace (and eventually a Wikipedia/MediaWiki-style OAuth from BOLD OS, developed in parallel) are later phases, picked up once each identity provider is actually ready.

1. **Storage** — Firestore replaces `localStorage`, no auth yet (matches today: no permission layer exists either). **Done.**
2. **Slack sign-in** — Identity Platform custom OIDC provider. Establishes identity ("who am I") only — no role/claims. Blaze plan **done** (2026-09-11). UI scaffolding (`#authRegion`, `firebase.auth()`, sign-in/out) added to `audit-board.html`; the `oidc.slack` provider itself and the Slack app are still pending (see "Inputs needed" below).
3. **Permissions (MVP)** — hardcoded email allowlists (`pis()`/`seniors()`/`juniors()`) in `firestore.rules`, checked directly against `request.auth.token.email` — no custom claims, no Cloud Function. See "Security Rules" below for why this isn't deployed yet even though it's fully written.
4. **Permissions (later)** — Google Workspace Groups via the Admin SDK Directory API + a `beforeSignIn` Cloud Function stamping custom claims, once BOLD's Workspace domain/groups are settled. Keeps the same `pis()`/`seniors()`/`juniors()` call sites in Security Rules — only the source of truth changes, from a hardcoded list to a claim.
5. **(Stretch, separate decision)** — Slack channel auto-invite via a bot token, gated on confirming BOLD's Slack plan tier for the workspace-invite half; the channel-invite half works on any plan (bot needs `conversations:write.invites` and must already be a member of any private channel it manages).

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

## Security Rules

**Deployed 2026-09-11** (verified live via `firebase_get_security_rules` and the `firebase` CLI, both matching `firestore.rules` on disk exactly). Two-layer model unchanged in shape: role-list membership decides *eligibility* for lab-wide actions; a direct comparison against the card's own `reviewers.junior`/`reviewers.senior` decides *authorization* for that specific card.

**Role lists moved out of the rules file, into Firestore data — not literals here.** Originally drafted as hardcoded arrays (`pis()`/`seniors()`/`juniors()` functions returning literal email lists) directly in `firestore.rules`. Revised before deploy: Eduardo wants the option to make the `ml-conference-cycle` repo public, and a public repo would publish real BOLD members' email addresses in plaintext, forever, in git history. So the lists live in three Firestore documents instead — `roles/pis`, `roles/seniors`, `roles/juniors`, each shaped `{emails: [...]}` — referenced via `get()`. `get()`/`exists()` calls made *from inside* a rule bypass that target document's own rules (this is standard Firestore Security Rules behavior, not a hole) — so `roles/{roleId}` itself stays permanently `allow read, write: if false` for clients, and can only be written via the Firebase Console (project-owner access, which bypasses Security Rules entirely) or an Admin SDK credential — never by `audit-board.html` or anyone using it.

```
function isSignedIn() { return request.auth != null; }
function email()      { return request.auth.token.email; }
function roleList(name) {
  return get(/databases/$(database)/documents/roles/$(name)).data.emails;
}
function isPi()        { return isSignedIn() && email() in roleList('pis'); }
function isSenior()    { return isSignedIn() && (email() in roleList('seniors') || isPi()); }
function isJunior()    { return isSignedIn() && (email() in roleList('juniors') || isSenior()); }
function isLabMember() { return isSignedIn(); }

match /roles/{roleId} { allow read, write: if false; }

match /boards/{boardId} {
  allow read: if true;
  allow create, delete, update: if isPi();

  match /cards/{cardId} {
    allow read: if true;
    allow create: if isLabMember();
    // A card can be changed only by whoever created it, a reviewer
    // assigned to it, or a PI — decided 2026-09-11.
    allow update, delete: if isLabMember() && (
      email() == resource.data.submittedBy.email ||
      email() == resource.data.reviewers.junior ||
      email() == resource.data.reviewers.senior ||
      isPi()
    );
  }
}
// (checklist/comments/discussion/history subcollections not yet split out —
// see "Client-side change" below; their rules follow the same shape once they are)
```

**Deployed, but a no-op in practice today, and here's why that's fine.** `isSignedIn()` is always false until the `oidc.slack` provider exists and someone can actually sign in — so nothing changes in production behavior yet, this is safe to have live. The `roles/*` documents also don't exist yet (see "Inputs needed" — waiting on the actual email lists). Real, separate blocker for when Slack sign-in *does* go live: `submittedBy.email` and `reviewers.junior`/`reviewers.senior` assume real signed-in emails, but as of Phase 1a **they don't hold that** — `submittedBy` is `{name, slackId}` (a free-text name typed into a "Stand-in for Slack login" field) and `reviewers.junior`/`reviewers.senior` are free-text names from the shared people-autocomplete. That still needs fixing (wiring `state.currentUser.email` into both) before the per-card `update` rule can match anyone real — tracked in the "Client-side change (Phase 2)" section above.

## Cloud Functions

**Deferred (Phase 4, not MVP) — 2026-09-11.** The MVP permission model needs no Cloud Function at all: hardcoded email lists in Security Rules are evaluated entirely server-side, no claim-stamping step required. This section is the plan for when Google Workspace Groups replaces the hardcoded lists (see "Phasing").

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

## Client-side change — in progress (Phase 2, UI scaffolding only)

Added to `audit-board.html` 2026-09-11, not yet functional end-to-end (blocked on the Slack app + Firebase Console provider setup — see "Inputs needed"):

- Firebase **auth-compat** SDK script tag (`firebase-auth-compat.js`, same pinned `10.14.1`, same `gstatic.com` exception).
- Masthead restructured: `.masthead-right` wraps the existing "Internal" sub-label and a new `<div id="authRegion">`, styled to sit together.
- `firebase.auth()` initialized alongside `firebase.firestore()`, targeting the Auth emulator (`localhost:9099`) when `FIRESTORE_USE_EMULATOR` is true.
- `state.currentUser` tracks `{email, name, photoURL} | null` via `onAuthStateChanged`; `renderAuthRegion()` shows a "Sign in with Slack" button (signed out) or the user's name + a "Sign out" control (signed in), re-rendered on every auth-state change.
- Sign-in calls `auth.signInWithPopup(new firebase.auth.OAuthProvider('oidc.slack'))` with `openid profile email` scopes. Until the `oidc.slack` provider is configured in Firebase Console, this fails gracefully — a toast, not a crash — since the provider doesn't exist yet.

**Deliberately not yet done, and why:** nothing in the app *requires* being signed in to read or write a board/card, and `submittedBy`/`reviewers` still store free-text names rather than the signed-in email — see the Security Rules section's "written, not deployed" note for why that's a real blocker, not just an inconsistency to clean up later. Wiring `state.currentUser.email` into `submittedBy`/reviewer-assignment, and deciding whether writes become sign-in-gated in the UI (not just in Security Rules), is follow-up work once Slack sign-in is actually live and testable.

**Decided 2026-09-11:** yes, board/card writes become sign-in-gated. A card can be changed only by whoever created it, a reviewer assigned to it, or a PI — matches the Security Rules draft above exactly (`submittedBy` / `reviewers.junior` / `reviewers.senior` / `isPi()`). Not implemented yet — still blocked on the same prerequisite (real emails in `submittedBy`/`reviewers`, which needs Slack sign-in live first) — but no longer an open question, just sequencing.

## Project status (2026-09-11)

- **Firebase project:** `bold-d7ff2` (display name "BOLD"), created 2026-09-11. Signed in as `edu.pignatelli@gmail.com` via the Firebase MCP server — subsequent Firebase work in this repo uses those tools directly (project/app CRUD, SDK config, Security Rules read, deploy) rather than manual console steps.
- **Web app registered:** `internal-review-board` (`appId: 1:555050367135:web:d90f8d7bb93a755e9fcaaa`). SDK config pulled and recorded below — not secret, safe to commit/embed client-side.
- **Firestore:** enabled. Rules deployed 2026-09-11 (see "Security Rules") — no longer literal deny-all, but equivalent to it in practice until Slack sign-in is live, since every path requires `isSignedIn()` and nothing can sign in yet.
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

**Phase 1 (storage) — done.** CDN exception confirmed 2026-09-11, applied to `AGENTS.md`.

**Phase 2 (Slack sign-in) — in progress:**
- [x] Blaze plan upgrade — done 2026-09-11.
- [ ] **A Slack app** — I can't create this myself, it needs Eduardo's own Slack login. Steps: api.slack.com/apps → Create New App → From scratch → pick the BOLD workspace → **OAuth & Permissions**: add `openid`, `profile`, `email` as *User Token Scopes* under "Sign in with Slack" (or enable the pre-built "Sign in with Slack" option if the Slack UI offers it directly) → **Basic Information** for the Client ID + Client Secret. The redirect URL Slack needs goes in `Sign-in with Slack` (or OAuth) → *Redirect URLs*, and that value comes from Firebase Console (below), so do the Firebase half first.
- [ ] **Firebase Console, manual step (not available via my MCP tooling — confirmed by reading the `firebase://guides/init/auth` resource, which only supports `anonymous`/`emailPassword`/`googleSignIn`)**: Authentication → Sign-in method → Add new provider → OpenID Connect. Provider ID: `oidc.slack`. Issuer URL: `https://slack.com`. Client ID + Client Secret: from the Slack app above (the secret goes in Console only — never embedded client-side, unlike the rest of `FIREBASE_CONFIG`). Saving this step gives the redirect URL Slack's Redirect URLs field needs. Say when ready and I'll walk this half live, step by step.

**Phase 3 (MVP permissions) — rules deployed, one step left:**
- [ ] **The actual `pis`/`seniors`/`juniors` email lists.** Rules are live and already look for them (see "Security Rules"), but the three Firestore documents don't exist yet — no promotions take effect until they're created. I don't have a credentialed path to write Firestore data myself (no service account key, no `gcloud` set up on this machine, and I won't open production write rules to route around that) — this has to go in via the Firebase Console: **console.firebase.google.com → bold-d7ff2 → Firestore Database → Start collection → id `roles`**, then add three documents, IDs `pis`, `seniors`, `juniors`, each with one field named `emails`, type **array**, containing the email strings for that role. Give me the lists and I'll hand back the exact values to paste in, field by field.

**Gather in parallel, not urgent — Phase 4 (Google Workspace Groups, later):**
- [ ] The actual Google Workspace domain name (confirmed not `bold-lab.ai` itself — no MX/TXT on that domain).
- [ ] Domain-wide delegation for a service account (I'll generate its Client ID), scope `admin.directory.group.readonly`, authorized in that Workspace's Admin Console.
- [ ] Group addresses: `seniors@`, `juniors@`, `pis@`, and whether venue create/delete gets its own `coordinators@` or folds into `pis@`.
- [ ] Which admin/service email the delegated calls impersonate.

**Only if we pick up the Phase 5 stretch (Slack channel auto-invite) later:**
- [ ] BOLD's Slack plan tier (gates whether workspace auto-invite, not just channel auto-invite, is possible at all).
