# BOLDiquette navigation, reading view, and version history

Status: implemented for local review on `hack/boldiquette-vcs`; live Google Doc access and deployment configuration remain open.

## Goal

A signed-in BOLD.OS user can open BOLDiquette from the main sidebar, read it in the same visual style as the rest of the site, and see added and removed text since the version they last acknowledged. The live Google Doc remains authoritative. BOLD.OS automatically captures changes from it; nobody has to publish a version manually. The change view uses visible `+` and `−` markers as well as green and red styling. Users can also inspect earlier captured versions.

## What exists now

- `src/pages/ml-cycle/boldiquette.html` is a roughly 60 KB static HTML copy of BOLDiquette. Its provenance link opens the live Google Doc; the page itself does not load the Doc at runtime.
- Git commit `fb7f23e` says the page was made from a Drive export with Pandoc and manual cleanup. There is no import or synchronization script in this repo. Updating the displayed text currently requires another repo edit and deployment.
- Git commit `53cd32b` removed BOLDiquette from the sidebar pending a way to propose and track changes. The page remains in the repo. The sidebar is defined in `src/_data/site.js`.
- Its page CSS overrides the shared design tokens and uses Inter, small type, filled badges, and rounded boxes. The current site-wide style in `src/assets/css/bold.css` uses EB Garamond for reading, Cabin for UI, one accent colour, thin rules, and outlined badges.
- Auth and local emulator routing live in `src/assets/js/bold.js`. Firestore rules live in `firebase/firestore.rules`. On localhost, Firestore and Functions use emulators while Slack sign-in remains real.

## Product decisions

Confirmed by the user: the live Google Doc is the source of truth; BOLD.OS should update automatically when it changes; the user's read point advances only after **Mark as read**; and this feature is for reading versions and changes, not proposing edits inside BOLD.OS. The main-menu request means a top-level sidebar item, matching this site's existing navigation.

The user wants updates within a few minutes. A five-minute scheduled check is the initial target; scheduler delay or a failed check can make a particular update take longer, so the UI should show the last successful check time rather than promise a strict five-minute deadline. A scheduled check avoids maintaining a Drive webhook subscription, which [expires after at most one day for a watched file and needs explicit renewal](https://developers.google.com/workspace/drive/api/guides/push). It captures the latest content at each check, rather than every keystroke or every native Google Docs revision. If exact per-edit history is required, that is a separate requirement.

Google Doc access is unresolved: the user does not know whether a service account can be granted read access. First verify that the Doc owner can share this one Doc as **Viewer** with the function's service-account address; [Google documents this as the direct-file-access path](https://developers.google.com/workspace/guides/create-credentials). If that is disallowed by Workspace settings, use an approved read-only OAuth identity and keep its credential outside the repo. Do not change the Doc to public sharing merely to make sync work. The hackathon demo uses fictional local fixtures either way.

## Proposed hackathon implementation

### 1. Add navigation and restyle the reading page

Add a top-level BOLDiquette link to `nav` in `src/_data/site.js`; retain the page's own table of contents for section links. Refactor `src/assets/css/pages/boldiquette.css` to inherit shared tokens and typography from `bold.css`, remove the extra Inter font from page front matter, and make article headings, paragraphs, lists, links, and tables readable on desktop and mobile. Keep document wording and IDs intact. Give the version controls the site's normal understated UI; use green/red only to convey changes in the diff.

### 2. Capture Google Doc versions automatically

Add a Cloud Function using the existing `onSchedule` pattern in `functions/index.js`, scheduled every five minutes. It reads the one configured Google Doc through the Drive API with read-only access, checks its modification metadata, and exports HTML when needed. Google supports `files.export` to `text/html` (see [export format reference](https://developers.google.com/workspace/drive/api/guides/ref-export-formats) and [export method](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export)). Do not put a credential, token, or real document text in Git or the local seed. In production, grant an approved server identity Viewer access to the Doc and enable the required Google API; local development uses a fictional export fixture.

Treat Google export HTML as untrusted input. Keep only the BOLDiquette document's own sections, normalize headings, paragraphs, lists, tables, links, and emphasis, discard styles/scripts/event handlers and unsafe URLs, and preserve stable heading anchors. Compute a SHA-256 ID from normalized semantic content, not raw export bytes, so cosmetic export churn does not create false versions. When the hash matches the latest captured version, update `lastCheckedAt` only. When it differs, write a new immutable snapshot and atomically advance the latest-version pointer after the snapshot is available. Log and retain the last good version if fetch, conversion, or storage fails.

Store the sanitized article and metadata in immutable Firestore documents, for example `boldiquetteVersions/{hash}`, and store the latest-version ID and `lastCheckedAt` in `boldiquetteMeta/current`. A version records `sourceModifiedAt`, `capturedAt`, `hash`, sanitized HTML, and normalized blocks. Reject an export that exceeds the safe document-size budget rather than publishing a truncated version. Firestore rules allow signed-in users to read versions, while only the server can write them. This avoids redeploying the static site for each Google Doc edit and keeps the hackathon implementation to one data store. The checked-in article remains a clearly labelled fallback if no synchronized version can load; its wording should not be silently mixed with live versions.

The UI displays **“BOLD.OS copy checked …”** and a separate link to the live Google Doc. It should not promise instant updates. The first successful sync is the start of BOLD.OS's independent snapshot history; earlier Google Docs edits cannot be shown as a BOLD.OS diff unless old content is imported explicitly.

### 3. Show a useful change view

Add a page script and styles for **Changes since your last read** and a compact version history. Listen to the Firestore latest pointer so an already-open page can notice a new capture, then load that version document. Compare normalized text blocks (headings, paragraphs, and list items) rather than source HTML lines, which are densely packed and would produce meaningless Git diffs. Show removed blocks with `−` and red, added blocks with `+` and green, and enough unchanged headings for context. Escape all diff text before inserting it into the page. Provide an accessible text label in addition to colour. A version selector should let the user compare any earlier captured version with the latest one.

On a first visit, show the current article and explain that no earlier read point is recorded. If there are no captured changes after the user's read point, say so directly. Styling-only edits must not appear as document-text changes.

### 4. Store each user's read point

Use a Firestore document such as `boldiquetteViews/{auth.uid}` containing `lastReadVersion` and `readAt`. Add a rule allowing a signed-in user to read/write only their own document. The page should load this after `BOLD.onUser` resolves. **Mark as read** writes the latest captured version only after the user clicks it; the diff remains available through version history. A failed write should leave the old baseline visible and show an error. The local emulator makes this testable without touching production.

### 5. Verify and pitch

Use two fictional BOLDiquette-like exports in local demo fixtures to exercise the sync function and show one removed and one added passage, without inventing a policy change in the real document. Verify first visit, unchanged return visit, changed export, duplicate export, failed export retaining the last good version, explicit acknowledgement, cross-device read point, sign-out, narrow screens, and keyboard use. Run the Eleventy build and test against emulators. The pitch should show the menu, refreshed page, and `+`/`−` view, then explain the Google Doc access and deployment steps needed for real synchronization.

## Acceptance criteria

- The signed-in sidebar has a working BOLDiquette link and its active state is correct.
- The page matches the site's current type, spacing, colours, and mobile layout; document text and links remain intact.
- Automatically captured versions have stable content IDs and a visible history. A user can compare the latest version to their last acknowledged version.
- Additions and deletions are understandable without relying on colour alone. Unchanged or first-visit states are clear.
- Read points are private to each authenticated user and survive another browser session. A page open does not silently overwrite them.
- A changed fictional export produces exactly one new version locally; an unchanged export produces none. A failed sync leaves the last good version readable. In production, a new Google Doc edit normally appears within about five minutes, subject to scheduler and fetch latency, without a GitHub deployment; the UI states when it last checked successfully.

## Constraints and setup

The hackathon instructions require a `hack/<team>` branch, made-up demo data, plain HTML/CSS/JS, no new CDN scripts, and a PR into `hackathon`. This branch already exists. Live Google Doc synchronization needs read access for a server identity and API setup; neither credential nor real content belongs in this public repo. `docs/DIFF.md` needs an update only if the BOLDiquette process itself changes, not for navigation, styling, or read-only history.

## Local review and shipping setup

- On the running local site, sign in with Slack and open `http://localhost:8137/boldiquette.html` from the top-level sidebar. With no Google credential configured, this shows the styled checked-in copy and says that no synchronized version is available yet.
- Open `http://localhost:8137/boldiquette.html?demo=1` for two **fictional** versions seeded in the emulator. Click **Pretend I last read the earlier demo version**, then inspect **Changes since last read** and **Mark as read**. The demo read point is stored under your local Firebase identity and is separate from the real BOLDiquette read point.
- For production, enable the Google Drive API on the Firebase project, grant the Cloud Function's execution service account Viewer access to the one authoritative Doc (or arrange an approved read-only OAuth identity if Workspace blocks sharing), and set `BOLDIQUETTE_DOC_ID` in the Functions environment. Deploy the function, Firestore rules, and site together only after review. The scheduled function checks every five minutes; its first successful export starts the snapshot history. A failed check leaves the last good version intact and logs an error.
- The importer intentionally supports text, headings, lists, tables, links, and emphasis. Images and richer Google Docs elements are dropped. Check a real export before shipping to confirm that the full BOLDiquette is represented.
