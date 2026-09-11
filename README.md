# ML Conference Paper Cycle

BOLD Lab's tool suite for taking a paper from venue choice to conference presentation — an implementation of BOLDiquette § ML Conference Cycle.

**Live:** https://bold-lab-ai.github.io/ml-conference-cycle/

- `index.html` — homepage
- `how-to-submit-a-paper.html` — the guide
- `internal-qa-review.html` — Internal Review (pre-submission checklist)
- `audit-board.html` — Internal Review Board (kanban tracker, Firebase-backed)
- `diff.html` — where this tooling diverges from BOLDiquette, and why

Static HTML/CSS/JS, no build step, no framework. `audit-board.html` talks to a Firebase backend (Firestore, Auth, Storage) for shared state and Sign-in-with-Slack; everything else is self-contained.

## Contributing

Start with **[`docs/AGENTS.md`](docs/AGENTS.md)** — the real guide to this repo's conventions, constraints, and how the pieces fit together. `docs/FIREBASE.md` covers the backend specifically.

## Running locally

```
python3 -m http.server 8137
```

Then open `index.html`. The guide, Internal Review, and diff pages also work opened as plain `file://` pages; `audit-board.html` needs to be served (it talks to Firebase, and Slack sign-in needs a real `http(s)` origin).
