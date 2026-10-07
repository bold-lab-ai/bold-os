#!/bin/zsh
# Stop the meeting server and the tunnel started by deploy/meeting.sh.
cd "$(dirname "$0")/.."
for f in server tunnel; do
  if [[ -f deploy/logs/$f.pid ]]; then
    kill "$(cat deploy/logs/$f.pid)" 2>/dev/null && echo "stopped $f" || echo "$f was not running"
    rm -f deploy/logs/$f.pid
  fi
done
