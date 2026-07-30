#!/bin/sh
# Firestarter: dev launcher (macOS / Linux).
#
# Replaces any server already holding the port, because a stale one serves
# old code and looks like the new code failing. Stops the server again when
# the application exits, rather than leaving it behind: a background process
# that outlives the thing that started it is somebody else's problem later.
cd "$(dirname "$0")" || exit 1

port="${STUDIO_PORT:-8787}"
stale=$(lsof -ti "tcp:$port" 2>/dev/null)
if [ -n "$stale" ]; then
  echo "Stopping old server on $port [$stale]"
  kill -9 $stale 2>/dev/null
fi

# Prefer the CUDA interpreter if one was made, so the local engine is
# available; otherwise whatever python3 is on the path.
PY=python3
[ -x ".venv-image/bin/python" ] && PY=".venv-image/bin/python"

echo "Starting generation server with $PY"
"$PY" -m server.gen_server &
server=$!
trap 'kill $server 2>/dev/null' EXIT INT TERM

cd studio || exit 1
[ -d node_modules ] || npm install --no-audit --no-fund
npm start
