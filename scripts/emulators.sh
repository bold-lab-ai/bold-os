#!/bin/sh
# BOLD.OS, run locally with nothing real behind it (AGENTS.md "Developing a Slack feature"):
# the Firestore and Functions emulators on a demo project, so nothing can reach the real
# database, and Slack pretended (functions/slack-outbox.js: every call lands in the
# emulator's slackOutbox collection). Needs Java, for the Firestore emulator.
set -e
cd "$(dirname "$0")/.."
# The files the deploy copies into functions/ (firebase.json predeploy).
cp src/assets/js/card-model.js src/assets/js/search-rank.js functions/
# Stand-in secrets: no real token, so the outbox is all Slack it can reach.
if [ ! -f functions/.secret.local ]; then
  printf 'SLACK_BOT_TOKEN=outbox\nSLACK_SIGNING_SECRET=outbox\nGOOGLE_OAUTH={}\nGITHUB_APP={}\nANTHROPIC_API_KEY=none\n' > functions/.secret.local
fi
(cd functions && npm install --silent)
exec npx firebase emulators:start --only firestore,functions --project demo-bold-os
