# BOLD OS

BOLD Lab's internal site — an operating system and research model for fundamental AI research. Today it hosts the ML Conference Paper Cycle tooling (an implementation of BOLDiquette § ML Conference Cycle), lab events, and profiles.

**Live:** https://bold-lab-ai.github.io/bold-os/

## Layout

```
src/
  pages/            one HTML file per page (front matter + body); ml-cycle/, events/, index, profile
  _includes/        layouts/base.njk + partials/ — the shared chrome (head, masthead, gate, sidebar, footer)
  _data/site.js     Firebase config, SDK version, repo URL, sidebar navigation
  assets/css/       bold.css (design system + chrome) and pages/<page>.css
  assets/js/        bold.js (auth, gating, sidebar), pages/<page>.js, audit-board/*.js
functions/          Cloud Functions (Slack notifications, App Home, profile/project lookups)
firebase/           Firestore + Storage rules, Firestore indexes  (firebase.json / .firebaserc stay at the root)
checklists/         instructions for authors'/reviewers' coding agents (linked by raw URL from the site — don't move)
docs/               contributor docs, BOLDiquette diff, Firebase design + build log
.github/workflows/  build + deploy to GitHub Pages
```

Pages are built with [Eleventy](https://www.11ty.dev/) — layouts and partials in Nunjucks, page bodies plain HTML, no client-side framework. Add a nav link in `src/_data/site.js`; change the masthead, sidebar or footer once in `src/_includes/`.

## Running locally

```
npm install
npm start          # http://localhost:8137, rebuilds on change
npm run build      # one-off build into _site/
```

## Contributing

Start with **[`docs/AGENTS.md`](docs/AGENTS.md)** — the conventions, constraints and how the pieces fit together. `docs/FIREBASE.md` covers the backend.
