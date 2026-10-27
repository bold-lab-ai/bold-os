# AGENTS.md

How to work on BOLD.OS, the lab's internal site, for anyone changing its code, human or agent.

Live: <https://bold-lab-ai.github.io/bold-os/>. A static [Eleventy](https://www.11ty.dev/) site on GitHub Pages, with a Firebase backend (project `bold-d7ff2`: Firestore, Auth via Slack sign-in, Cloud Functions). The repo is public.

## The rule that decides most things

**Content is edited on the site, not in code.** Everything people read on the site (events, their days and time slots, sessions, talks, skills, …) lives in Firestore and can be added, edited and deleted from the page itself, by whoever the Firestore rules allow. So:

- Don't write content into pages or data files. If you find some hardcoded, the fix is to move it into Firestore and give it add/edit/delete controls on its page.
- A code change is for how the site works: a new kind of content, a new page, a fix.
- Controls a user can't use are shown greyed out with a reason in their tooltip, not hidden.
- Where changes must be reviewed (the how-to guides, BOLDiquette, skills), every change is saved as a proposal, a PI's or admin's too, and a PI/admin other than whoever proposed it accepts or declines it (`decideProposal`, which applies it); nobody changes the content directly. Whoever proposed it can edit it (back into their draft, then **Update proposed change**) or withdraw it while it's open.

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

There is no Auth emulator (Slack sign-in can't run in it). Test rules by calling the emulator's REST API with unsigned tokens (`alg: none`, with an `email` claim and `firebase.identities: { 'oidc.slack': [...] }`: only Slack accounts count as signed in), and seed `roles/pis` and `roles/admins` to give a test user PI or admin rights.

## How pages are built

- **Front matter:** `title`, `description`, `css` (a file in `assets/css/pages/`), `scripts` (files in `assets/js/`), `sdk` (extra Firebase SDKs, e.g. `["firestore", "functions"]`), `permalink` (keep URLs flat: `events.html`), `nav` (the sidebar link to highlight), `area` (its page in the BOLDiquette's Who can see what: who may view it; every gated page has one, and its sidebar entry the same `area` in `site.js`), `public` (no sign-in gate), `bare` (no masthead, sidebar or footer: pages for people outside the lab, like `join.html`).
- **JavaScript:** plain classic scripts, each wrapped in an IIFE; no framework, no bundler. Never initialise Firebase yourself: use `BOLD.getApp()`, `BOLD.getAuth()`, `BOLD.onUser(fn)` from `bold.js`. Put any user-provided text through `BOLD.escapeHtml` before it goes into HTML.
- **External scripts:** only the pinned Firebase compat SDK (version in `site.js`), Google Fonts and KaTeX on the board. Ask before adding another.
- **One page per kind of content**, chosen by a query parameter: `event.html?event=`, `session.html?session=`, `talk.html?talk=`, `skill.html?skill=`, `guide.html?guide=`. **Never break a URL**: Slack messages and bookmarks link to them. When one moves, leave a redirect page (see `src/pages/events/old-session-talk-urls.njk`). An event with its own page (`page` on `events/{slug}`: Collaboration Week, the Festival) is linked there (`eventUrl` in functions, `x.page ||` in the pages); `event.html?event=<slug>` forwards to it (`pages/event.js`), since that page can't draw their programme.
- **Who can do what:** clients can't read the role lists. A page asks the `getMyAccess` function whether the user is a PI or admin to decide which controls to enable; the Firestore rules decide what is actually allowed.
- **Who can see what:** the BOLDiquette's part of that name (`access`) is a table of each page's lowest group (Who is BOLD) that may see it and that may change it (at once, or by proposing where changes are reviewed: `REVIEWED` in `functions/access.js`). Accepting a change to it (only PIs and admins propose one) saves it in `settings/access`, which everything enforces: the rules (`may(page, 'view' | 'change')` on every collection's reads and writes, on top of their own conditions), the callables (`await access.requireAccess(email, page, 'view' | 'change')` after the caller's email), the agents' API (each reading tool and resource names its page) and the pages (`area` gates the page, and its chip at the page's top right opens who can see it, where PIs and admins propose a change; `BOLD.can(area, what)` and `BOLD.cannotReason` for controls). A member's group is their `category`, only PIs and admins set it (PAN-BOLD without one); PIs and admins count as BOLD-exec. A new page or collection takes its area; a new page key goes in `PAGES` in `functions/access.js`, `AREA_NAMES` in `bold.js` and the BOLDiquette's table.
- **Look:** tokens in `bold.css` (cream paper, one navy accent, EB Garamond for reading, Cabin for labels and controls, hairline rules). Match the page you're editing; reuse the shared classes (`.event-form`, `.btn-text`, `.event-controls`, …).
- **Tagging people:** any textarea offers `@` tags, shown as @Name everywhere and DMed to whoever is tagged by `onTagged`, for any collection. Give a box `.no-tags` when its text leaves BOLD.OS (an abstract, a SKILL.md); add a new collection to `tagPlace` (its link) or `TAG_SILENT` in `functions/index.js`.
- **Comments:** a new kind of comment thread belongs on `comments.html` (`pages/comments.js`), and every Slack message about a comment links to the comment itself, not just its page (`#c=` on a guide, `&msg=` on the board).
- **Search:** a new kind of content gets a section in `BoldSearch.SCOPES` (`search-box.js`) and a loader in `LOAD` (`pages/search.js`), and the same in the agents' `search` tool (`functions/api.js`); both rank with `search-rank.js`.
- **Agents:** `functions/api.js` lets people's AI agents read BOLD.OS as them (MCP and JSON, personal tokens from their profile; activity on `agents.html`), and act as them once a PI or admin approves (Requests → Agents). Anything it returns must match what that person sees on the site, and never include email addresses. A new feature gets its action in `functions/api-actions.js`, doing what its page does: Firestore writes as the person under the rules (`asUser`), callables through the callable (`act`); never admin writes that skip the rules. The site is the single source of truth for what agents get: instructions are the BOLDiquette's Agentiquette part, word for word (after one line in code, `FLOOR`, that puts the BOLDiquette first), prompts from the skills, resources from the pages, and added tools from the Tools pages (`agentTools`, changed by proposals like everything else); added tools run only in `mcpSandbox` (no roles, no secrets, as the caller), never in BOLD.OS's own functions. Never give the MCP content of its own.
- **Confirm before reaching outside BOLD.OS:** any button that makes something happen outside the site for the person (a Slack channel, invite or message, a Google Calendar meeting, Drive sharing, a GitHub repository or invitation, an email) first calls `BOLD.confirmAction({ title, effects, go })` (`bold.js`), listing in plain words what will happen, and goes ahead only if it resolves true. Plain edits on the site don't ask, nor do replies that only tell the other person. An automation someone may not want is optional (`{ key, text }`, a ticked box): leaving it out is recorded on the object (as a project's workspace `skipped`), and its page offers to run it later. Everyone can turn these off for good ("Don't ask me again", `prefs/{uid}.skipConfirm`) and back on from their profile.
- **Copy boxes:** any text offered for copying uses `BOLD.copyBoxHtml(text)`: a code box with the clipboard icon inside it. Never a text "Copy" button.
- **Page copy is terse:** one or two sentences of description, no commentary about the process or the code.

## Data and backend

- **Firestore collections** include `events/{slug}` (with `days` and `venues` inside), `collabWeekSessions`, `collabWeekTalks`, `skills/{name}`, `guides/{slug}` and `handbook/{slug}` (BOLDiquette; both with `proposals` and `comments`; the BOLDiquette also with `readers`, who has marked it read), `boards/{id}/cards` (the Internal Review Board), `projects`, `projectWorkspaces/{card id}` (each project's meeting, slides, notes and members; server only), `people` (the Slack roster), `joinRequests` (requests to join BOLD, from `join.html`; PIs/admins, and whoever the applicant says invited them), `members/{email}` (each member's details, made on approval, edited on their profile; their group in Who is BOLD, `category`, only PIs and admins set), `groupRequests` (requests to change group; all writes through `groupRequest`), `studies/{email}` (a PhD or Master student's supervisors and, optionally, recurring meeting with them; server only, through `studies`), `studyRequests` (requests to join a student's meeting, from the Calendar; the student and whoever asked read them, all writes through `studyRequest`), `letterRequests` (recommendation letters on the Service desk; only whoever asked and the writer read one, all writes through `letterRequest`), `introOffers` and `introRequests` (introductions on the Service desk: offers read by the lab and written by their author, withdrawn through `introRequest`, which closes their open requests; requests read by the two people, all writes through `introRequest`), `venueCalls` (the ICLR/ICML/NeurIPS calls already announced to PIs and admins; server only), `settings` (`joinForm`, `joinInvite`, `groups`: each group's Slack channel; `groupsInvited`, server only: what has been invited), `readPoints/{uid}` (each person's "last read" versions, theirs alone), `interactions` (who did what with whom, derived from the other collections by the server for Connections and Network; the lab reads them; a new kind of content with people in it gets a branch in `interactionsFor`), `changelog` (each content change in brief, for the changelog page), `githubLinks` (linked GitHub accounts and their bold-lab-ai membership; server only), `apiTokens` and `apiLog` (agents' personal tokens, hashed, and what they read; server only), `calendarFeeds/{email}` (each person's private Calendar subscription link; server only), `eventSeries/{id}` (event series; server only, through `eventSeries`), `eventInvites/{slug}` (each occurrence's Google Calendar invitation; server only) and `roles` (never readable by clients).
- **Every write path needs a rule** in `firebase/firestore.rules`. Test new rules in the emulator, both what should pass and what shouldn't.
- **Version history:** each write to a tracked collection is saved as a full copy in `<doc>/versions` by a server function, and `history.js` shows versions, changes and Restore on the page. To track a new collection: add it to `TRACKED` in `functions/index.js`, require `updatedBy == email()` in its rules and let readers read `versions`, write `changeNote` on save, and mount `BoldHistory` on its page. `skills`, `guides` and `handbook` are tracked so far.
- **Functions** run on Node 22 (`engines` in `functions/package.json`).

## Adding a feature

Building a feature (a page that reads and writes its own data, say a rota) needs no keys and no access to the Firebase project:

- **No API key.** The Firebase web config in `src/_data/site.js`, its `apiKey` included, is public: it names the project and grants nothing. People write as themselves, signed in with Slack, and the rules decide what they may do.
- **In the PR:** the page and its script, its Firestore collection, the rules for it in `firebase/firestore.rules` (behind `isSignedIn()`/`isLabMember()`; who may manage it as a rule of its own, such as a list it checks, rather than making them site admins), and any server work (reminders, schedules, Slack messages) as functions in `functions/index.js`, using the secrets already there (e.g. `SLACK_BOT_TOKEN`) without seeing them.
- **Test in the emulators** (see Run it): they need no access to the real project.
- **Deploying:** someone with access to the Firebase project reviews the rules and deploys them, and any functions, when the PR merges.
- **Don't give contributors rules access** to deploy their own. The rules are one file for the whole database, so whoever deploys them can change any rule; reviewing them is what keeps data from leaking or being overwritten.
- **No service-account keys.** A tool that ran outside the site with its own key becomes a page or a function here; no key leaves the project.

## Shipping

- **Plan on the board:** BOLD.OS's own work, code and content, is on the BOLD OS project's **Work** tab. Add a card for what you take on, put yourself on it, and link it to its pull request or proposed change: it then moves along with it.
- **Pull requests:** work on a branch and open a PR to `main` (one approval needed). **Merging deploys the site** through GitHub Actions; there is no staging site.
- **Rules and functions deploy separately**, by someone with access to the Firebase project:
  - `npx firebase deploy --only functions:<name>` and `npx firebase deploy --only firestore:rules`, with `--project bold-d7ff2`.
  - **Never a bare `firebase deploy`**: production runs functions that aren't in this code.
  - Deploy rules together with the client code that needs them.
- **Never enable Firebase Hosting** on the project: it breaks sign-in.
- **Only Slack accounts count.** `isSignedIn()` in the rules and `signedInEmail` in the functions require a Slack identity on the account (`token.firebase.identities`, not `sign_in_provider`, which linking GitHub changes), and `onlySlackSignUps` refuses any new account that isn't a Slack one; together another provider, such as GitHub, never gives access on its own. Keep any new rule or callable behind them.
- **Sign-in:** don't change how it works without testing in private windows on desktop and phone. The setup and its history are in `docs/REFERENCE.md` under "Sign-in".
- **Public repo:** no secrets, tokens or people's email addresses in code or docs. Role lists live in Firestore.

## BOLDiquette

The ML Conference Cycle guide and the Internal Review Board implement BOLDiquette § ML Conference Cycle; the How to guides carry § Research Project Lifecycle and the How to ML docs BOLDiquette links to. Where the site differs from BOLDiquette, record it in `docs/DIFF.md` and its rendered copy `src/pages/ml-cycle/diff.html` (kept in sync by hand), never on the pages themselves.

## The lab's Google account

Project meetings, slides and notes, students' meetings with their supervisors and the welcome email to new members go through the lab's Gmail account (`GOOGLE_OAUTH`; `docs/REFERENCE.md` under "Project workspaces" says how to reconnect it). It owns every file and meeting it makes. A new function that uses it lists `GOOGLE_OAUTH` in its `secrets`.

## More detail

`docs/REFERENCE.md` has notes on every file and feature, often with the reasoning behind them. It's long, so search it for the file or feature you're touching rather than reading it top to bottom. `docs/FIREBASE.md` covers the backend design.
