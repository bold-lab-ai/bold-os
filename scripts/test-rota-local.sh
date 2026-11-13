#!/usr/bin/env bash
set -euo pipefail

# Only the demo project is used. The callable module runs against the Firestore
# emulator with mocked Slack; this command does not sign in to live Firebase.
if ! java -version >/dev/null 2>&1; then
  local_java=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
  if [[ ! -x "$local_java/bin/java" ]]; then
    echo 'Java is required for the Firestore emulator. Set JAVA_HOME to a local JDK.' >&2
    exit 1
  fi
  export JAVA_HOME="$local_java"
  export PATH="$JAVA_HOME/bin:$PATH"
fi
if ! command -v firebase >/dev/null 2>&1; then
  echo 'The Firebase CLI is required locally for emulator tests.' >&2
  exit 1
fi

export FIREBASE_CLI_DISABLE_TELEMETRY=1
node --test tests/group-rota.test.cjs tests/rota-preview.test.cjs tests/prepare-rota-import.test.cjs tests/profile-photo-rota.test.cjs tests/rota-series.test.cjs
firebase emulators:exec --only firestore,storage --project demo-test \
  'node tests/group-rota-rules.cjs && node tests/group-rota-storage.cjs && node tests/group-rota-functions.cjs'
