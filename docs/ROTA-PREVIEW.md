# Local group meeting rota preview

The group meeting rota is in development. To rebuild its local preview from an existing snapshot, run:

```sh
npm run preview:rota
npm start
```

Open <http://localhost:8137/group-meetings-preview.html>. It shows Sam in a simulated local signed-in session. The Archive link shows past meetings. Search checks every meeting, and Show more reveals ten at a time.

`preview:rota` reuses the ignored `_site/group-meetings-preview.html` snapshot. Building and opening it make no network request; clicking an added Slides link opens the HTTPS URL entered by the user. The page uses local mock sign-in and data. Open short and long slots can be claimed, Sam's title, slides and project can be edited, and Sam can decline a slot; these changes are saved in this browser's local storage and can be cleared with **Reset local changes**. The preview includes an Example project for trying the project selector; its link opens a local example page. Other actions do not save. Sam's short slot is identified in the snapshot so the swap icon opens its request form for review; submission is disabled. To build from a separately saved export, run `npm run build && node scripts/build-rota-preview.mjs path/to/export.json`. On a fresh checkout, a saved export is needed because `_site/` is ignored. The branch does not import data into the live BOLD.OS database, deploy functions or rules, or send Slack messages.

The 67 available legacy portraits are preserved in `src/assets/img/rota-profiles/`; `docs/ROTA-PHOTO-SHA256.txt` records their checksums. The preview loads only those local files, including after a fresh build. Four names in the saved preview have no portrait: Ravi Hammond, Andrei Vascan, Thomas Linder and Zehuan Sheng; they show initials. The name-based filenames are a migration inventory, **not** verified identity matches. Match each to a Slack ID before any authorised Storage import. The live page shows the shared `profilePhotos/{slackId}` portrait first, then the existing `groupRotaPhotos/{slackId}` image if the shared portrait is missing, then initials. An explicit shared-photo removal leaves initials. Existing rota portraits remain owner-editable as a fallback until their separately authorised migration.

For emulator-only verification, run `npm run test:rota:local` with a local Firebase CLI and Java installed. It runs the pure tests, then starts the Firestore and Storage emulators for project `demo-test`, exercises rules and callable logic with synthetic people and mocked Slack, and shuts the emulators down. The regular `npm start` site still uses production Firebase; use the offline preview above for interface work and the emulator command for write-path testing.
