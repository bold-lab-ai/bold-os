# Local group meeting rota preview

The group meeting rota is in development. To rebuild its local preview from an existing snapshot, run:

```sh
npm run preview:rota
npm start
```

Open <http://localhost:8137/group-meetings-preview.html>. It shows Sam in a simulated local signed-in session. The Archive link shows past meetings. Search checks every meeting, and Show more reveals ten at a time.

`preview:rota` reuses the ignored `_site/group-meetings-preview.html` snapshot. It makes no network request and uses a local mock for sign-in, data and actions, so edit controls cannot save. To build from a separately saved export, run `npm run build && node scripts/build-rota-preview.mjs path/to/export.json`. On a fresh checkout, a saved export is needed because `_site/` is ignored. The branch does not import data into the live BOLD.OS database, deploy functions or rules, or send Slack messages.
