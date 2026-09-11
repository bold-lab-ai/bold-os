# TODO — Internal Review Board × BOLD OS

Most of this is blocked on **BOLD OS**, the lab's new system for governance, projects, and other lab info. Until it exists, the Internal Review Board runs standalone: free-text paper entry, a name field instead of login, no link to any project. When BOLD OS spins up, work through this list.

Independent of BOLD OS: the board persists to browser `localStorage` today (no Claude dependency), but that is per-browser — a **shared backend** is still needed.

Related tracking: `DIFF.md` (implementation vs. BOLDiquette), `changelog.md` (build history), and the handover's "Known gaps / open decisions".

---

## Shared storage for the Internal Review Board

**In progress as of 2026-09-11 — see `FIREBASE.md` for the concrete data model, Security Rules, and phasing.** The items below stay as the requirements list; `FIREBASE.md` is where the actual design lives so the two don't drift into conflicting plans.

The board now persists to browser **`localStorage`** (keys `bold-audit-board:boards-index` and `bold-audit-board:board:<id>`), isolated in the `lsRead` / `lsWrite` / `lsRemove` helpers behind `loadBoardsIndex` / `saveBoardsIndex` / `loadBoard` / `saveBoard` / `deleteBoardData`. No Claude / Claude-Artifacts dependency — it works opened as a file or hosted anywhere.

What's still missing: `localStorage` is **per-browser**. Data isn't shared between people, isn't backed up, and doesn't follow you to another device. That needs a real backend — **database + API**.

- [ ] Stand up a datastore + API. If BOLD OS provides one, the board becomes a BOLD OS view and uses that (preferred — single source of truth, and it lines up with identity and the Projects model). Otherwise the board needs its own minimal backend, shaped by whatever bold-lab.ai is built on.
- [ ] Swap the storage layer in `audit-board.html` — replace the three `ls*` helpers with `fetch()` calls to the API; `loadBoardsIndex` / `saveBoardsIndex` / `loadBoard` / `saveBoard` / `deleteBoardData` and the rest of the page are unaffected.
- [ ] Persist the full shape: the boards index (`{ id, venue, year, label, deadline, createdAt }`) and each board's `{ cards: [...] }`, including the checklist snapshot, the `discussion` thread, and the per-card `history` log.
- [ ] Handle concurrent editors. Today every change re-writes the **whole board blob**, so two reviewers on the same board race and one clobbers the other. Move to per-card writes or optimistic concurrency (version / updatedAt check).
- [ ] Require authentication for writes once identity exists (see "BOLD OS capabilities" below).
- [ ] Migrate each person's `localStorage` data into the shared store on cutover.

## The core change: publications come from BOLD OS projects

Today you add a paper to the Internal Review Board by typing a title into a form. In BOLD OS, **a publication only exists as an attachment to a project**, so the board should mirror that rather than re-collect it:

- [ ] The **Registered** column is populated automatically — every publication attached to one of your BOLD OS projects shows up there. No "Register paper" form.
- [ ] The first action on a paper is a **status change, not a creation**: move its card from *Registered* to *Drafted* when the first full draft is done.
- [ ] A publication with no BOLD OS project can't reach the board at all — the fix is to create the project / attach the publication in BOLD OS.

A BOLD OS **project** carries (at least): research questions, findings, compute allowed, and a list of attached publications. The Internal Review Board consumes that; it does not own it.

## BOLD OS capabilities this depends on

- [ ] **Identity** — an authenticated current user (replaces the "Submitted by" name field and its "stand-in for Slack login" note in `audit-board.html`).
- [ ] **Projects API** — list the current user's projects; read a project's publications, research questions, findings, and compute-allowed.
- [ ] **Publication records** — canonical title, authors, corresponding author, Overleaf / repo links, target venue. The board should read these, not re-collect them.
- [ ] **Roles / governance** — who is a junior / senior reviewer, PI, or project owner, for assignment and for gating status changes.
- [ ] **A datastore + API** — see "Permanent storage" above. If BOLD OS owns it, the board becomes a view inside BOLD OS rather than a standalone page.

## Permissions

**In progress as of 2026-09-11 — see `FIREBASE.md`'s Security Rules draft.** Resolved: Slack OIDC for identity, Google Workspace Groups (`seniors@`/`juniors@`/`pis@`) surfaced as Firebase custom claims for eligibility, `reviewers.junior`/`reviewers.senior` field comparison for per-card authorization — the two-layer model referenced below.

Today the page has **no permission layer**: anyone who opens it can create and delete venues, add / edit / move / remove cards, and tick either checklist pass. That's fine for a per-browser `localStorage` tool but not once it's shared.

**Slack OAuth** is the intended sign-in (the "stand-in for Slack login" note points at it). Once it's in, identity and lab membership come with it and the rules below become enforceable.

- [ ] **Authentication required for every action.** An anonymous / signed-out visitor can read the board but cannot create, edit, move, remove, or tick anything.
- [ ] **Moving a card** (any status change, including the Left / Right buttons and the dropdown): only the paper's **author**, a **project owner**, or the **assigned junior / senior reviewer**.
- [ ] **Checklist passes:** the Junior column — the assigned junior reviewer only; the Senior column — the assigned senior reviewer only.
- [ ] **Venue create / delete:** a smaller admin set (PIs / review coordinators) — exact set TBD.
- [ ] Implement as one `can(action, card)` check that every handler consults. Stub it to `true` now; back it with the session user + roles when auth lands.

## Internal Review Board changes (`audit-board.html`)

- [ ] Remove `openModal()` / `onAddCard()` — cards are no longer user-created. Mirror BOLD OS project publications into the *Registered* column (poll or subscribe). Deadline override and any note-to-reviewers moves to the card's edit view.
- [ ] Cards key on `projectId` + `publicationId` (BOLD OS refs); `title`, `overleafLink`, `correspondingAuthorEmail`, authors are read from the publication record, not stored on the card.
- [ ] One publication → at most one card per venue board.
- [ ] Expose venue and card creation as **plain callable functions** (take an object, not DOM values) so an agent can populate a venue from the call for papers. The venue modal fields already define the shape: `venue`, `year`, `website` (URL), `abstractDeadline`, `deadline`, `pitchDay`, `reviewsPublicDate`, `rebuttalDeadline`, `notificationDate`, `cameraReadyDeadline`, `conferenceDates`, `location`, `maxPapersPerAuthor`, `pageLimit`, `anonymity`, `submissionSystem` (URL of the submission page), `notes`. Every date except `deadline` is optional.
- [ ] **Subscribable deadline feed.** The board offers a downloadable `.ics` (`internalSchedule` / `buildIcs`), but a *subscription* URL is not possible from the current static + `localStorage` setup: there is no server, venue data is per-browser, and calendar clients (Google, Apple, Outlook) fetch the feed from their own servers — they can't run the page's JS, and don't accept `data:` URIs. It needs the shared backend (see "Shared storage"):
  - Serve each venue's schedule as a real file at a stable URL, e.g. `https://bold-lab.ai/irb/venues/iclr-2026.ics`, regenerated when the venue changes. Hand users the `webcal://` form of that URL to subscribe.
  - `buildIcs` / `internalSchedule` already produce the exact bytes — reuse them server-side unchanged.
  - Offer an all-venues feed too (every venue's milestones in one calendar).
  - Until then the download is the only option; keep it.
- [ ] Use the venue metadata to drive the checklist: `pageLimit`, `anonymity`, and `maxPapersPerAuthor` should prefill / scope the relevant Format items instead of a reviewer re-deriving them.
- [ ] `submittedBy` — populate `{ name, id }` from the authenticated user; drop the name input and the "stand-in for Slack login" helper text.
- [x] Per-card checklist UI — clicking a card opens a detail page with all its info and the 12-item checklist in two passes (Junior / Senior). A paper cannot leave Drafted for Reviewed until both passes are complete (`GATE_STATUS`).
- [x] Assign a junior and a senior reviewer per submission — `card.reviewers = { junior, senior }`, editable from the card's **Edit fields** modal; shown on the card and the detail page; the gate banner nudges when unassigned.
- [x] **Assign reviewers directly on the card.** The Junior / Senior inputs live on the card face itself (not just the detail page or an edit modal) — teal/plum-labelled, empty ones tinted amber so an unassigned paper stands out at a glance on the board. Saves on `change`, no extra click to open anything.
- [x] **PI and authors on every card — one field.** `card.authors` (string array, at least one required at registration), where **the last author is the PI** (`cardPi()`) — no separate PI field, matching how a paper's own author list usually reads. Collected via dynamic add/remove rows in the registration modal, the last row tagged "PI"; "+ Add author" inserts before it so the PI stays last as co-authors are added. Shown on the detail page (full list) and the card face (PI only, to keep the card compact). Not editable after registration, matching title/track/email.
- [ ] **Real people picker — PI (last author), authors, and reviewers all need it.** The Author / Junior / Senior fields are free text today, with a single shared `<input list="peopleNames">` autocomplete (`peoplePoolNames()` — every card's `submittedBy`, `authors`, and assigned reviewers, deduped) as a stand-in. Replace with a real picker (with search) over the **people pool = union of BOLD lab members + this paper's authors + volunteers**. Needs that list to exist — a maintained roster in BOLD OS (members), the publication record (authors), and a per-cycle volunteer sign-up. Store `{ id, name }` per entry, not a bare string, and swap `peoplePoolNames()`'s source for the real roster. **The real picker must still accept a name that isn't on the roster** (an external collaborator, a new hire not yet added) — don't regress to a closed dropdown; keep a "custom" / free-text escape hatch same as the current stand-in already has by construction. Keep the "last author = PI" convention when this lands, unless BOLD OS's publication record already carries PI separately — then read it from there instead.
- [ ] Wire the checklist gate together with role checks (see **Permissions**): the existing `crossesGate` completeness rule plus "who may move this card" and "who may tick which column". Closes the standalone "nothing gates status changes" gap. Needs identity + `card.reviewers`.
- [x] **Search / filter the venue board.** A free-text box (`matchesSearch()`) plus a scope select (Everything / Title / PI / Authors) filters the cards shown in every column live as you type; column counts and "No matches" vs "Nothing here" reflect the filter. Client-side only — fine at board sizes seen so far, but a board with hundreds of cards may want this server-side once there's a backend.
- [x] **Discussion tab — OpenReview-style thread per card, one level of replies.** Format and Science are now tabs (were one long stacked matrix) alongside a new Discussion tab: `card.discussion`, free-text author + body, reply nesting capped at one level by construction (a reply has no `replies` field, so there's no "reply to a reply" to build UI for).
- [x] **Per-checklist-item feedback threads.** Each checklist point has its own `comments` array (same message shape / one-level-reply rule as Discussion) — a reviewer can leave a note pinned to a specific point ("author name visible, p.4 line 312") and anyone can reply. Toggle under each checklist row; comments never gate the checkbox.
- [ ] **Discussion and checklist-item comments need real identity, same as everything else free-text.** `author` on a post is typed by hand (shared `peopleNames` suggestions, same stand-in as PI/authors/reviewers) — once identity exists, populate it from the authenticated user and drop the name field, same plan as `submittedBy` (see "BOLD OS capabilities" below). No edit/delete on a posted message yet either — worth revisiting once posts are attributable to a real account. Also consider: mark a checklist-item comment thread "resolved" (distinct from ticking the box), and surface an unresolved-comment count somewhere on the card face / gate banner so open concerns aren't missed.

## Surface project context in the Science review

The senior reviewer checks claims against evidence — BOLD OS already holds much of that evidence:

- [ ] On the card, or in the Science tab, show the project's **research questions** and **findings** next to the "Claimed contributions" category, so the reviewer checks the paper's claims against the project's own record.
- [ ] Add a checklist item backed by BOLD OS data: **experiments stayed within the project's allocated compute** (`compute allowed`).

## Bidirectional linkage

- [ ] The BOLD OS project page shows each attached publication's current review status (Registered … Accepted, or its outcome once decided) with a link to the board card.
- [ ] On **Accepted**, push status back to the BOLD OS publication record and auto-publish the accepted publication to the public website. This is why the guide dropped BOLDiquette's manual "On Acceptance" form step (see `DIFF.md`).

## Guide & audit-page copy (`how-to-submit-a-paper.html`, `internal-qa-review.html`)

- [ ] Phase 1 "Log the project" — becomes: create or verify the **project in BOLD OS** and attach the paper as a publication; it then appears in *Registered* on its own. No "add to the Internal Review Board" step.
- [ ] Phase 3 — the card already exists; wording is just "move it from Registered to Drafted."
- [ ] `internal-qa-review.html` worknote, and the board footer line about shared data — revisit once there is a real backend and per-user identity.

## Explore: run Internal Review on OpenReview

The Internal Review *is* a simulated venue review — so consider running it on the real thing instead of building more of the board.

- [ ] Spin up a private OpenReview venue (or one hidden venue per conference cycle) that BOLD papers are submitted to before the real venue. Reviewers are the pool (junior + senior); the author sees threaded reviews, writes a rebuttal, gets a decision — the exact motions of a venue.
- [ ] What OpenReview gives for free: paper upload + PDF rendering, reviewer assignment, structured review forms, comment threads, rebuttal flow, decision stages, email notifications, per-paper anonymity. Much of this the board would otherwise reimplement.
- [ ] What the board still owns: the venue schedule / derived deadlines / `.ics`, the pipeline kanban and status gate, the Pitch Day step, the link to BOLD OS projects. The board becomes a thin tracker/dashboard *over* OpenReview rather than the review tool itself.
- [ ] Open questions: does OpenReview allow private/self-hosted venues for a lab this size, and at what cost / admin overhead? Can the Format/Science checklist be expressed as an OpenReview review form (two reviewer roles → two review invitations)? How does the Approved gate map to an OpenReview decision? API for pulling status back into the board.
- [ ] Alternative if OpenReview is too heavy: the same idea on a lighter self-hosted stack (e.g. a HotCRP instance), same trade-off analysis.

## Governance / BOLDiquette

- [ ] "A publication must belong to a project" is a governance decision. Once settled, it likely belongs in BOLDiquette too — fold into `DIFF.md` / `proposed-boldiquette-addition.md` when BOLD OS governance is written up.

## Open questions

- Which venue board does a publication land on before a venue is chosen? Does the BOLD OS publication carry a target venue, or is there one shared *Registered* pool that feeds every board?
- Can a publication be attached to more than one project? If so, which project's compute / research-questions govern the review?
- Are Overleaf links and corresponding author edited in BOLD OS only, or still on the board?
- Does creating a new publication happen in BOLD OS and then appear in the picker, or can the board create one in BOLD OS on your behalf?
- Workshop papers and non-project submissions (e.g. position pieces) — is "must have a project" absolute, or is there an exception path?
