#!/bin/sh
# BOLD.OS, a local test copy to click through as anyone (2026-11-02): the Auth, Firestore and
# Functions emulators on the demo project demo-bold-os (nothing real behind it: Slack calls land
# in the emulator's slackOutbox, Google and email fail), demo data (scripts/test-seed.cjs), and
# the site built with BOLD_TEST=1 on http://localhost:8150, where Sign in offers test accounts
# (src/assets/js/test-mode.js). Needs Java, for the emulators. Stop it with Ctrl-C.
# BOLDIQUETTE_PARTS=<file> seeds the real BOLDiquette (keep that file outside the repo).
set -e
cd "$(dirname "$0")/.."
# Java, for the emulators: on the PATH, Homebrew's (not on the PATH by itself), or one unpacked
# in ~/.local/jdk (a Temurin JDK from adoptium.net: no Homebrew or admin rights needed).
if ! java -version >/dev/null 2>&1; then
  for d in /opt/homebrew/opt/openjdk/bin /usr/local/opt/openjdk/bin "$HOME"/.local/jdk/*/Contents/Home/bin "$HOME"/.local/jdk/*/bin; do
    [ -x "$d/java" ] && PATH="$d:$PATH" && export PATH && break
  done
fi
java -version >/dev/null 2>&1 || { echo 'The emulators need Java 11 or later: unpack a JDK from adoptium.net into ~/.local/jdk'; exit 1; }
cp src/assets/js/card-model.js src/assets/js/search-rank.js functions/
if [ ! -f functions/.secret.local ]; then
  printf 'SLACK_BOT_TOKEN=outbox\nSLACK_SIGNING_SECRET=outbox\nGOOGLE_OAUTH={}\nGITHUB_APP={}\nANTHROPIC_API_KEY=none\n' > functions/.secret.local
fi
(cd functions && npm install --silent)
npx firebase emulators:start --only auth,firestore,functions --project demo-bold-os &
EMU=$!
trap 'kill $EMU 2>/dev/null' EXIT INT TERM
until curl -s http://127.0.0.1:8080 >/dev/null 2>&1 && curl -s http://127.0.0.1:9099 >/dev/null 2>&1; do sleep 1; done
GCLOUD_PROJECT=demo-bold-os node scripts/test-seed.cjs
BOLD_TEST=1 npx eleventy --serve --port=8150 --output=_site-test
