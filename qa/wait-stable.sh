#!/bin/sh
# Wait until dist/FBAR-Max-Balance.html exists, tests/e2e.mjs exists, and the HTML's modification time has not
# changed for STABLE seconds (default 120). Gives up after MAX seconds (default 570). Exit 0 = stable.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
F="$ROOT/dist/FBAR-Max-Balance.html"; E="$ROOT/tests/e2e.mjs"
STABLE=${STABLE:-120}; MAX=${MAX:-570}; start=$(date +%s)
while :; do
  now=$(date +%s)
  if [ -f "$F" ] && [ -f "$E" ]; then
    age=$(( now - $(stat -f %m "$F") ))
    if [ "$age" -ge "$STABLE" ]; then echo "stable: unchanged for ${age}s ($(stat -f '%Sm' "$F"))"; exit 0; fi
  else age=-1; fi
  if [ $(( now - start )) -ge "$MAX" ]; then echo "not stable after ${MAX}s (last change ${age}s ago)"; exit 1; fi
  sleep 10
done
