#!/bin/sh
# prod-imagen studio: dev launcher (macOS / Linux).
cd "$(dirname "$0")"
python3 -m server.gen_server &
cd studio
[ -d node_modules ] || npm install --no-audit --no-fund
npm start
