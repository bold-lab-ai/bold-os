# BOLD.OS hackathon — start here

You have **2 hours** to build one feature you'd like BOLD.OS to have, then pitch it in **5 minutes**. This branch (`hackathon`) is set up so you can hack freely: you sign in with Slack as usual, but on your laptop the database, file storage and Cloud Functions run on **local emulators**. Nothing you do touches the live site or real lab data.

For how the codebase works (pages, data model, conventions), read [`docs/AGENTS.md`](docs/AGENTS.md). This file only covers the hackathon setup.

## Setup (≈5 minutes)

You need **Node 20+** and **Java 21+** (the Firestore emulator runs on Java). On a Mac: `brew install --cask temurin@21` (a prebuilt install, about a minute; not `brew install openjdk@21`, which can end up compiling from source for an hour). Otherwise, get the installer from [adoptium.net](https://adoptium.net/temurin/releases/?version=21). Check with `java -version`.

```sh
git clone https://github.com/bold-lab-ai/bold-os.git && cd bold-os
git switch hackathon
git switch -c hack/<your-team>      # your team's branch
npm run hack:setup                  # installs dependencies (once)
```

Then, in **two terminals**:

```sh
npm run emulators   # terminal 1 — leave it running; Emulator UI at http://localhost:4000
```

```sh
npm run seed -- <your Slack email>   # terminal 2 — made-up people, venues, papers, projects; makes you a PI locally
npm start                            # the site, at http://localhost:8137
```

Open **http://localhost:8137/index.html** and click **Sign in with Slack**. It's the real Slack sign-in, in a popup: allow popups for `localhost`, and sign in to the BOLD Slack in that browser beforehand (a sign-in that goes Slack → Google inside the popup can drop out).

The email you gave `npm run seed` is a **PI in your local database only**, so you can use every feature. To try the site as someone with less access, remove yourself from `roles/pis` in the Emulator UI's Firestore tab (or move yourself to `roles/admins`, `roles/seniors`, `roles/juniors`). The emulators start empty each time — re-run the seed after restarting them.

The seed also adds fictional lab members (`@bold.test`) so lists, boards and pickers aren't empty. They can't sign in; they're just data.

## What works locally, and what doesn't

- **Works:** every page, Slack sign-in, reading and writing Firestore (with the real Security Rules from `firebase/firestore.rules`), file uploads, and the Cloud Functions that only touch Firestore (e.g. "am I a PI?", "my projects").
- **Doesn't:** anything that calls Slack — DMs, notifications, creating or joining project channels, Slack profile fields. Those need real secrets, which stay off laptops. They'll fail with an error; build around them.
- **The live site is untouched:** this setup only kicks in on `localhost`, and only on this branch. Sign-in is the only thing that talks to the real project, and it only proves who you are; everything you read or write is local.

## If something's off

- **Signed in but can't edit anything:** your Slack account uses a different email from the one you gave the seed. The masthead shows the email you're signed in with; re-run `npm run seed -- <that email>`.
- **`package-lock.json` shows as changed after setup:** harmless npm noise; don't commit it.
- **`npm run emulators` complains about Java:** check that `java -version` shows 21 or higher (see Setup).

## Rules of the game

- **Work on your own branch** (`hack/<your-team>`), branched from `hackathon`.
- **Your pitch is a pull request into `hackathon`**, not `main`. Open it before you present; the PR description is your pitch. `main` (the live site) is protected and needs a reviewer's approval, so nothing you do can go live by accident.
- **Use made-up data only.** This repo is public. Never paste real lab data, emails or secrets into code, commits, PRs or the seed.
- **Commit early, commit often.** Small commits make it easy to show what you built.

## Where things live (quick map)

| You want to change… | Look at |
|---|---|
| A page's content | `src/pages/**` (front matter + HTML), page script in `src/assets/js/pages/<page>.js`, styles in `src/assets/css/pages/<page>.css` |
| The masthead, sidebar, sign-in gate | `src/_includes/` (layout + partials), `src/assets/js/bold.js`, `src/assets/css/bold.css` |
| Sidebar links | `nav` in `src/_data/site.js` |
| Who can read/write what | `firebase/firestore.rules` (the emulator reloads it as you save) |
| Server-side logic | `functions/index.js` (the emulator reloads it as you save) |
| The Internal Review Board | `src/assets/js/audit-board/*.js` (loaded in a fixed order; they share globals) |
| Collaboration Week schedule | `src/_data/collabWeek*.js` + `src/pages/events/event-collaboration-week*.njk` |

House style: plain HTML/CSS/JS, no frameworks or bundlers, no new CDN scripts; one accent colour, serif for reading, sans for UI, outlined badges (never filled). Copy an existing page rather than starting from scratch.

## Pitching (5 minutes)

1. The problem, in one sentence.
2. A live demo on `localhost`.
3. What it would take to ship for real (data, permissions, anything Slack-side).
