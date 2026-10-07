#!/bin/zsh
# Host a Paralax meeting from this Mac.
#
#   deploy/meeting.sh [seats] [hostname]
#
# Starts the server with seat tokens (a fresh session) and prints the two links: the join link
# to send to people, and the researcher link for you.
#
# With a hostname (default: meet.chrisantha.uk) it relies on the named Cloudflare Tunnel that
# already runs on this Mac and routes that hostname to localhost:8808 (see deploy/README.md).
# With "quick" as the hostname it starts a temporary tunnel with a random trycloudflare.com
# address instead (needs deploy/bin/cloudflared; takes a few minutes to become reachable).
#
# Keys: the server reads GEMINI_API_KEY from the environment or paralax/.env (gitignored).
# Nothing here writes a key anywhere.
set -e
cd "$(dirname "$0")/.."
SEATS=${1:-10}
HOST=${2:-meet.chrisantha.uk}
if [[ -z "$GEMINI_API_KEY$GEMINI_API_KEY_POOL$GEMINI_API_KEYS$GOOGLE_API_KEY" && ! -f .env && -z "$PARALAX_ENV" ]]; then
  echo "No Gemini key: put GEMINI_API_KEY=... in paralax/.env (gitignored) or export it." >&2
  exit 1
fi
mkdir -p deploy/logs
[[ -f deploy/logs/server.pid ]] && kill "$(cat deploy/logs/server.pid)" 2>/dev/null || true
[[ -f deploy/logs/tunnel.pid ]] && kill "$(cat deploy/logs/tunnel.pid)" 2>/dev/null || true
sleep 1

echo "Starting the Paralax server with $SEATS seats (fresh session, new tokens, algorithm ${PARALAX_VARIANT:-v7})..."
nohup caffeinate -i python3 -W ignore server.py --new --new-tokens --panes "$SEATS" --host 127.0.0.1 --port 8808 > deploy/logs/server.log 2>&1 &
echo $! > deploy/logs/server.pid
for i in {1..30}; do grep -q "join link" deploy/logs/server.log 2>/dev/null && break; sleep 0.5; done
ROOM=$(python3 -c "import json; print(json.load(open('sessions/tokens.json'))['room'])")
KEY=$(python3 -c "import json; print(json.load(open('sessions/tokens.json'))['researcher'])")

if [[ "$HOST" == "quick" ]]; then
  BIN=deploy/bin/cloudflared
  [[ -x "$BIN" ]] || { echo "cloudflared not found at $BIN; see deploy/README.md" >&2; exit 1; }
  printf '# no ingress here: the --url flag sets the origin\n' > deploy/logs/quick.yml
  nohup "$BIN" tunnel --no-autoupdate --config deploy/logs/quick.yml --url http://127.0.0.1:8808 > deploy/logs/tunnel.log 2>&1 &
  echo $! > deploy/logs/tunnel.pid
  BASE=""
  for i in {1..60}; do
    BASE=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" deploy/logs/tunnel.log | head -1)
    [[ -n "$BASE" ]] && break
    sleep 0.5
  done
  [[ -n "$BASE" ]] || { echo "The quick tunnel did not come up; see deploy/logs/tunnel.log" >&2; exit 1; }
  NOTE="A quick tunnel takes one to three minutes to become reachable. Open the researcher link yourself first."
else
  BASE="https://$HOST"
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$BASE/" || true)
  if [[ "$code" != "403" ]]; then
    echo "Warning: $BASE answered '$code' rather than the server's own page. Is the named tunnel running?" >&2
    echo "  check: launchctl list | grep vera-tunnel ; tail ~/Library/Logs/vera-study/tunnel.log" >&2
  fi
  NOTE="Served through the named tunnel already running on this Mac."
fi

cat <<EOF

  Paralax is live.  $NOTE

  Join link, send to people (each click takes the next free seat; $SEATS seats):
    $BASE/join?room=$ROOM

  Researcher view, for you only (every chat, the mode switch, the seat links):
    $BASE/workspace?key=$KEY
  Recorded sessions:
    $BASE/viewer?key=$KEY

  Set the shared problem in the researcher view before people join.
  Stop with deploy/stop.sh. Logs in deploy/logs/.
EOF
