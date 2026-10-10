# AGENTS.md

How to work on BOLD.OS, the lab's internal site, for anyone changing its code, human or agent.

Live: <https://bold-lab-ai.github.io/bold-os/>. A static [Eleventy](https://www.11ty.dev/) site on GitHub Pages, with a Firebase backend (project `bold-d7ff2`: Firestore, Auth via Slack sign-in, Cloud Functions). The repo is public.

## The rule that decides most things

**Content is edited on the site, not in code.** Everything people read on the site (events, their days and time slots, sessions, talks, skills, …) lives in Firestore and can be added, edited and deleted from the page itself, by whoever the Firestore rules allow. So:

- Don't write content into pages or data files. If you find some hardcoded, the fix is to move it into Firestore and give it add/edit/delete controls on its page.
- A code change is for how the site works: a new kind of content, a new page, a fix.
- Controls a user can't use are shown greyed out with a reason in their tooltip, not hidden.
- Where everyone may change something but PIs/admins must review it first (the how-to guides), a non-PI's edit is saved as a proposal that a PI/admin accepts or declines.

## Layout

```
src/pages/          one file per page: front matter + plain HTML body (.njk if it uses Nunjucks)
src/_includes/      layouts/base.njk + partials/: head, masthead, sign-in gate, sidebar, footer (defined once)
src/_data/site.js   Firebase config, pinned SDK version, sidebar nav
src/assets/css/     bold.css (design tokens, shared components) + pages/<name>.css
src/assets/js/      bold.js (auth, sidebar, shared helpers), pages/<name>.js, shared modules
functions/index.js  Cloud Functions (europe-west2)
firebase/           Firestore and Storage rules, indexes
checklists/         instructions for paper authors' and reviewers' agents (linked by URL from the site; don't move)
docs/               REFERENCE.md (detailed notes per file), FIREBASE.md (backend design), DIFF.md
```

## Run it

```
npm install
npm start          # http://localhost:8137, rebuilds on change
npm run build      # one-off build into _site/
```

**The local site uses the real database.** Signed in on localhost (a popup; the live site uses a redirect), you read and write production data. To try writes safely, use the emulators (they need Java):

```
npx firebase emulators:start --only firestore,functions --project demo-test
```

There is no Auth emulator (Slack sign-in can't run in it). Test rules by calling the emulator's REST API with unsigned tokens (`alg: none`, with an `email` claim), and seed `roles/pis` and `roles/admins` to give a test user PI or admin rights.

## How pages are built

- **Front matter:** `title`, `description`, `css` (a file in `assets/css/pages/`), `scripts` (files in `assets/js/`), `sdk` (extra Firebase SDKs, e.g. `["firestore", "functions"]`), `permalink` (keep URLs flat: `events.html`), `nav` (the sidebar link to highlight), `public` (no sign-in gate).
- **JavaScript:** plain classic scripts, each wrapped in an IIFE; no framework, no bundler. Never initialise Firebase yourself: use `BOLD.getApp()`, `BOLD.getAuth()`, `BOLD.onUser(fn)` from `bold.js`. Put any user-provided text through `BOLD.escapeHtml` before it goes into HTML.
- **External scripts:** only the pinned Firebase compat SDK (version in `site.js`), Google Fonts and KaTeX on the board. Ask before adding another.
- **One page per kind of content**, chosen by a query parameter: `event.html?event=`, `session.html?session=`, `talk.html?talk=`, `skill.html?skill=`, `guide.html?guide=`. **Never break a URL**: Slack messages and bookmarks link to them. When one moves, leave a redirect page (see `src/pages/events/old-session-talk-urls.njk`).
- **Who can do what:** clients can't read the role lists. A page asks the `getMyAccess` function whether the user is a PI or admin to decide which controls to enable; the Firestore rules decide what is actually allowed.
- **Look:** tokens in `bold.css` (cream paper, one navy accent, EB Garamond for reading, Cabin for labels and controls, hairline rules). Match the page you're editing; reuse the shared classes (`.event-form`, `.btn-text`, `.event-controls`, …).
- **Copy boxes:** any text offered for copying uses `BOLD.copyBoxHtml(text)`: a code box with the clipboard icon inside it. Never a text "Copy" button.
- **Page copy is terse:** one or two sentences of description, no commentary about the process or the code.

## Data and backend

- **Firestore collections** include `events/{slug}` (with `days` and `venues` inside), `collabWeekSessions`, `collabWeekTalks`, `skills/{name}`, `guides/{slug}` (with `proposals`), `boards/{id}/cards` (the Internal Review Board), `projects`, `people` (the Slack roster) and `roles` (never readable by clients).
- **Every write path needs a rule** in `firebase/firestore.rules`. Test new rules in the emulator, both what should pass and what shouldn't.
- **Version history:** each write to a tracked collection is saved as a full copy in `<doc>/versions` by a server function, and `history.js` shows versions, changes and Restore on the page. To track a new collection: add it to `TRACKED` in `functions/index.js`, require `updatedBy == email()` in its rules and let readers read `versions`, write `changeNote` on save, and mount `BoldHistory` on its page. `skills` and `guides` are tracked so far.
- **Functions** run on Node 20, which must move to Node 22 before 30 October 2026.

## Shipping

- **Pull requests:** work on a branch and open a PR to `main` (one approval needed). **Merging deploys the site** through GitHub Actions; there is no staging site.
- **Rules and functions deploy separately**, by someone with access to the Firebase project:
  - `npx firebase deploy --only functions:<name>` and `npx firebase deploy --only firestore:rules`, with `--project bold-d7ff2`.
  - **Never a bare `firebase deploy`**: production runs functions that aren't in this code.
  - Deploy rules together with the client code that needs them.
- **Never enable Firebase Hosting** on the project: it breaks sign-in.
- **Sign-in:** don't change how it works without testing in private windows on desktop and phone. The setup and its history are in `docs/REFERENCE.md` under "Sign-in".
- **Public repo:** no secrets, tokens or people's email addresses in code or docs. Role lists live in Firestore.

## The paper process

The ML Conference Cycle guide and the Internal Review Board implement BOLDiquette § ML Conference Cycle. Where the site differs from BOLDiquette, record it in `docs/DIFF.md` and its rendered copy `src/pages/ml-cycle/diff.html` (kept in sync by hand), never on the pages themselves.

## More detail

`docs/REFERENCE.md` has notes on every file and feature, often with the reasoning behind them. It's long, so search it for the file or feature you're touching rather than reading it top to bottom. `docs/FIREBASE.md` covers the backend design.
