#!/usr/bin/env bash
# Ollama GUI — opens a local web server and your browser.
cd "$(dirname "$0")"
PORT="${1:-8899}"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install it from https://nodejs.org" >&2
  exit 1
fi
node server.js --port "$PORT" &
SERVER_PID=$!
sleep 1.5
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://127.0.0.1:$PORT"
elif command -v open >/dev/null 2>&1; then
  open "http://127.0.0.1:$PORT"
fi
wait "$SERVER_PID"