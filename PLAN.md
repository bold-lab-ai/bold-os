# Group meeting rota integration plan

## Goal and agreed behavior

Bring the existing group meeting rota from `../bold-rota` into BOLD.OS. The
current published assignments are the starting record and must not change as
a result of migration, roster updates, or schedule generation. Flag any
presenter who cannot be matched to an active Slack account with at least the
`bold-associates` role; do not remove or reassign them automatically.

The first release should provide:

- A BOLD.OS page for the weekly rota, next meeting, presenter search, talk
  details, and change history.
- Presenter control of their own topic, project link, and slides link.
- Like-for-like slot swaps that take effect only after the other presenter
  confirms through the BOLD.OS Slack app.
- Recusal with a required reason, a vacant slot, and a private backend record
  of who declined.
- Self-service claims of open long-presentation slots.
- Links between group meeting talks and project pages, plus prompts to add
  slides.
- A tracker distinguishing past presentations that actually happened from
  future assignments.
- Rota reminders sent by the BOLD.OS Slack app.

An administrator control for skipping entire dates is backlog work. The data
model should allow it without implementing that control in the first release.
The first release should use a slides **URL**, as Collaboration Week does;
uploading a PDF or PowerPoint file to BOLD.OS is a separate feature.

This plan was prepared from the local repositories and platform documentation.
No live rota, Firestore, or Slack data was accessed. Do not run the live-data
migration or membership audit until that access is authorized.

## Existing code to reuse

- `../bold-rota/schedule.js` generates the seeded 2026–27 rotation. Its
  `data.js` supplies the current hardcoded roster, dates, time, and skips;
  D1 overrides and registrations make up the rest of the live state.
- `../bold-rota/public/app.js` contains the next-meeting view, presenter
  search, slot editing, and change-history UI. Port the interactions and
  accessibility behavior, not its separate visual shell.
- `src/_data/site.js`, `src/pages/`, `src/assets/css/bold.css`, and
  `src/assets/js/bold.js` provide BOLD.OS navigation, layout, styling,
  authentication, and shared helpers.
- `src/assets/js/pages/project.js` already has a Presentations tab and notes
  that group meetings will be linked from the rota. `src/assets/js/project-links.js`
  is the existing pattern for links between an occasion and a project.
- `src/assets/js/pages/talk.js` accepts a presentation URL for Collaboration
  Week talks. The first rota release should use that same kind of field.
- `functions/index.js` already verifies Slack requests, sends messages,
  maintains the `people` roster, and runs scheduled functions.
- `firebase/firestore.rules`, `firebase/firestore.indexes.json`, and
  `functions/index.js` need the new collection permissions, queries, and
  server operations. Follow `AGENTS.md` for build, emulator, and release rules.

## Data model

Use Firestore as the authoritative store for the published rota. The existing
seed is useful provenance and may be reused to **draft a future season**; it
must not regenerate or alter a published season when the roster changes.
Meeting details are content and must be editable on the site rather than
hardcoded in a page or data file.

| Path | Purpose and key fields |
| --- | --- |
| `groupMeetingSeasons/{id}` | Season label, dates, regular time and location, rotation description, initial seed, publication state. |
| `groupMeetings/{date}` | Date, season ID, format (`short` or `long`), time zone, start time, duration, and meeting status. Reserve a skipped status and reason for the backlog feature. |
| `groupRotaSlots/{id}` | Stable meeting and slot IDs, slot number, format, presenter Slack ID, legacy member ID/name where needed, topic, optional project ID, slides URL, outcome (`unconfirmed`, `presented`, `did-not-present`), revision, edit metadata. This is the single source of truth for each talk. |
| `groupRotaMembers/{slackId}` | Active presenter registration and category, separate from the Slack-synced `people` roster. Joining or leaving must not alter existing assignments. |
| `groupRotaEligibility/{slackId}` | Server-maintained membership check, source group ID, result, and checked time. Do not treat a failed refresh as a negative membership result. |
| `groupRotaSwaps/{id}` | Both slot IDs and expected revisions, requester and recipient Slack IDs, created/expiry times, notification state, decision, and final status. |
| `groupRotaDeclines/{id}` | Private recusal record: person, original slot, reason, time, and resolution. The records form the backend list of people who declined. |
| `groupRotaNotifications/{id}` | Reminder and interaction-message delivery attempts, status, and Slack message reference where available. |

Keep a recusal reason out of lab-readable slot documents, version snapshots,
and the general changelog. Use stable Slack IDs for identities. Preserve a
legacy ID and name for assignments that cannot yet be matched, and show them
as unresolved rather than dropping them. A project's ID on a slot is
optional, since some group talks will not be about a registered project.

Prefer top-level `groupRotaSlots` documents: the rota page can query by date,
and a project page can query by project ID without copying the presentation.
Add the indexes those queries require. Give the rota page a stable deep link
to a meeting and slot, for example `group-meetings.html?date=YYYY-MM-DD&slot=1`.

## Eligibility and security

1. Before a live audit, establish whether `bold-associates` is a Slack User
   Group or another workspace role, then record its stable identifier. The
   existing `people` collection supplies Slack IDs, names, and emails but
   does not store this membership. If it is a User Group, the BOLD.OS Slack
   app needs `usergroups:read` and a server-side membership sync.
2. Compare every distinct assigned presenter and registered member with the
   current Slack roster and eligibility source. Report missing, ambiguous,
   inactive, or ineligible matches for human review. Preserve their slots.
3. Require BOLD.OS Slack-linked sign-in for rota reads and actions. Only an
   eligible, registered presenter may take a new self-service slot. An
   unresolved existing presenter cannot use identity-based self-service
   actions until matched; their assignment remains visible.
4. Route mutations through callable Cloud Functions. They must resolve the
   caller to a Slack ID and enforce eligibility, slot ownership, revision,
   and action-specific conditions. The Admin SDK bypasses Firestore rules,
   so these checks are mandatory server-side. Do not use site-wide admin
   status as the only rota permission model.
5. Add explicit Firestore rules: lab members may read meetings and slots;
   direct client writes to server-managed rota collections are denied;
   swap requests are readable by their participants and rota administrators;
   decline reasons are readable only by their author and rota administrators;
   notification logs and eligibility internals are server-only. Test both
   allowed and denied paths in the emulator.
6. Return the viewer's capabilities to the page so unavailable actions can
   appear disabled with a reason in their tooltip, as `AGENTS.md` requires.

Use a dedicated rota-administrator list or rule for exception handling. For
the first release, existing BOLD.OS admins can handle exceptional corrections
if no separate organisers have been designated; record each override in
history. A new presenter must still accept an offered vacancy rather than
being silently assigned.

## Action workflows

### Own talk details

An assigned presenter may edit their topic, optional project link, and slides
URL. They may not directly change the presenter or date. Validate text and
URLs, record `updatedBy`, `updatedAt`, and a generic `changeNote`, and reject
a stale revision. Keep the old rota's 140-character topic limit initially.

### Swap

1. A presenter selects one of their assigned slots and another assigned
   presenter's slot of the same format. Check that both presenters are
   eligible, both meetings are upcoming, and neither slot has a conflicting
   pending action.
2. Save a pending swap with both slot IDs and current revisions. Leave the
   published assignments untouched.
3. Send the recipient a BOLD.OS Slack message with both dates, formats, a
   rota link, and Confirm and Decline buttons. If delivery fails, show that
   status to the requester and retry safely; never imply acceptance.
4. Verify the Slack signature and recipient Slack ID on every button click.
   Recheck both slots and eligibility. On confirmation, exchange both
   **presentation packages** (presenter, topic, project, slides) in one
   Firestore transaction and mark the request confirmed. A stale request
   cannot overwrite a later edit.
5. Allow the requester to cancel. Expire unanswered requests before a
   meeting begins. Record confirmed, declined, cancelled, expired, and
   invalidated outcomes. Repeated Slack deliveries must be idempotent.

### Recusal and vacancies

Require a nonempty reason. In one transaction, create the private decline
record and vacate the slot. Clear the public topic, project link, and slides
link while retaining the prior values in the appropriate audit record.
Show only Open slot and a generic history note to the lab. One declined date
does not remove the person from future eligibility.

An eligible member may claim an open **long** slot for themselves, subject to
a transaction that checks it is still open and that they are not already
presenting at that meeting. For an open short slot, a rota administrator may
offer it to an eligible person through Slack; the person must accept before
the slot changes. Admin corrections require an explicit audit note.

### Meeting outcome

After the meeting, an administrator marks each slot `presented`,
`did-not-present`, or leaves it `unconfirmed`. Future assignments and
unconfirmed past slots never count as completed presentations.

## Project and slides integration

The rota slot remains the authoritative presentation record. The project
Presentations tab should query linked `groupRotaSlots` and render them beside
existing project presentation entries, with a link back to the precise rota
slot. The rota links to the project page. This avoids a copied project
presentation becoming stale after a swap. Edit a group meeting talk from
the rota, not from the project's generic presentation form; show that
form's edit control disabled with a link or explanation where applicable.

Offer a presenter their own projects in the project picker. Retain No project
for general talks. Linking a different team's project requires that team's
permission or a rota-administrator action. If a project is removed, retain
the talk and show that its former project link is unavailable. During
migration, review older manually entered `kind: group` project
presentations for duplicates before linking them to slots.

For slides, add an Add slides URL control to the assigned presenter's slot
and show whether a link is present. Reuse the Collaboration Week convention
of accepting a deck, shared document, or recording URL. The weekly Slack
reminder should prompt presenters with missing slides and link to their
slot. Do not make slides a condition of presenting. Check that any linked
project deck is actually viewable by the intended audience; a project
workspace deck may be shared only with that project's members.

If an actual file upload is later wanted, specify permitted file types,
size, retention, and viewer access, then add a Firebase Storage path and
rules. It is outside this first release.

## Reminders and Slack app

Extend the existing signed `slackEvents` HTTP function for swap and vacancy
actions, keeping its App Home and reviewer interactions intact. Verify the
request signature before using a payload. Acknowledge Slack promptly, and
handle retries and duplicate button clicks safely. The BOLD.OS app's bot
token and signing secret stay in Cloud Functions secrets.

Add a scheduled Cloud Function for the next-Monday presenter reminder. It
should read the current slots, mention linked presenters, include topics,
point at the BOLD.OS rota, and request slides links where missing. Keep
delivery records keyed by meeting and channel, with enough status to inspect
an uncertain send rather than blindly retrying it. The old backend schedules
the reminder for Monday 14:00 London time for the following Monday, while
its page says 16:00; settle on one time and show it consistently.

The BOLD.OS Slack app can also own `/rota` registration. Point that command
at the BOLD.OS handler only after its Firestore-backed join/leave behavior
works. Avoid a period in which both apps compete for the command name. The
old Cloudflare reminder must be disabled as part of the same cutover to
avoid double posts.

## History and presentation tracker

Extend BOLD.OS's version-history mechanism to `groupRotaSlots` and show
recent changes on the rota page. A public history entry may describe the
slot becoming open; it must not reveal a private recusal reason. Keep the
private decline log and delivery log separate from lab-wide change history.

For each registered member, show the last **confirmed** presentation date,
the number confirmed in a chosen period, and the next scheduled date. Show
unconfirmed historical coverage honestly, rather than treating it as zero.
Import old completed talks as unconfirmed unless reliable evidence says
they happened. Compute the tracker from slot outcomes initially; introduce
cached aggregates only if measurement shows they are needed.

## Migration, tests, and release

### Build without live data

1. Add the page, script, page CSS, and sidebar navigation; use BOLD.OS's
   shared layout, classic-script pattern, auth helpers, and HTML escaping.
2. Add Firestore rules and indexes, callable functions, Slack handlers, the
   scheduled reminder, and unit tests for pure decisions.
3. Move the functions runtime from Node 20 to Node 22 before the 30 October
   2026 deadline noted in `AGENTS.md`.
4. Test Firestore rules and function behavior against the emulators. Include
   signed-out access, own edits, another person's slot, concurrent claims,
   a wrong Slack confirmer, stale swap revisions, recusal privacy, broken
   project links, missing slides, and reminder deduplication.
5. Run `npm run build` and verify the new page's narrow and wide layouts,
   keyboard controls, loading and error states, and deep links.

### Read-only preflight when live access is authorized

1. Export the old live rota, including the generated schedule merged with
   D1 overrides, registrations, and full change history where available.
   The public API's recent changes alone are insufficient for a full audit.
2. Compare every date, format, slot, presenter, topic, and skipped date with
   the export. Resolve identity matches by Slack ID where possible; never
   rely on a matching display name alone.
3. Check each distinct assigned presenter against the active Slack roster
   and `bold-associates` eligibility source. Give the owner a report of
   missing, ambiguous, inactive, and ineligible matches. No assignment is
   changed by this check.
4. Inspect existing project presentation entries for group meeting records
   that would otherwise appear twice.

### Import and cutover

1. Import a frozen snapshot of published meetings and actual slots,
   preserving all assignments. Keep an export and a per-slot comparison
   report for review. Do not make the generated seed authoritative.
2. A Firebase project maintainer reviews and deploys the new rules,
   indexes, and **named** functions with the client PR. Deploy rules with
   the client code that needs them. Follow `AGENTS.md`: never use a bare
   `firebase deploy`, and never enable Firebase Hosting.
3. Update the BOLD.OS Slack app's `/rota` target and verify that its bot can
   reach the internal reminder channel. Disable the old Cloudflare reminder
   before the new scheduled reminder becomes active.
4. Preserve the old rota URL as a redirect to the new page so saved links
   and old messages remain useful.
5. Verify one reminder, a slides prompt, a claim, and a swap end to end in
   the first live cycle. Keep the migration export and reversal procedure
   until that cycle passes. If cutover fails, return to the frozen old
   assignments; do not regenerate them.

## Deferred decisions and backlog

- Confirm the exact Slack meaning and ID of `bold-associates` before the
  membership audit or eligibility gate goes live.
- Set the swap-expiry period, slides target date, and reminder wording during
  implementation review. They do not block building the data model or page.
- Add admin date skipping later, including effects on pending swaps,
  vacancy claims, presentation outcomes, and reminders.
- Consider actual file uploads after the slides-link workflow is in use.

## Platform references

- [Slack User Groups API](https://docs.slack.dev/reference/methods/usergroups.list/)
  and [`usergroups:read` scope](https://docs.slack.dev/reference/scopes/usergroups.read/)
- [Slack interaction acknowledgments](https://docs.slack.dev/interactivity/handling-user-interaction/)
- [Firestore transactions](https://firebase.google.com/docs/firestore/manage-data/transactions)
- [Firestore collection-group queries](https://firebase.google.com/docs/firestore/query-data/queries)
- [Scheduled Cloud Functions](https://firebase.google.com/docs/functions/schedule-functions)
