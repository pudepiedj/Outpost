#!/bin/bash
# Double-click to play: serves the game locally and opens it in your browser.
cd "$(dirname "$0")"
PORT=8642
if ! lsof -i :$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  python3 serve.py $PORT >/dev/null 2>&1 &
  sleep 0.7
fi
open "http://127.0.0.1:$PORT/"
echo "Outpost is running at http://127.0.0.1:$PORT/  (close this window to stop the server)"
wait
