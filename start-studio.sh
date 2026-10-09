#!/usr/bin/env sh
# start-studio.sh — macOS / Linux: サーバーを裏で起動して操作パネルを開く
#   ./start-studio.sh [port]      止める: kill "$(cat output/server.pid)"
set -e
cd "$(dirname "$0")"
PORT="${1:-8811}"
PY="$(command -v python3 || command -v python)"
[ -n "$PY" ] || { echo "Python 3.10+ が必要です"; exit 1; }
mkdir -p output
if ! curl -fs "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1; then
  nohup "$PY" -B -u studio/server.py --port "$PORT" >output/server.out.log 2>output/server.err.log &
  echo $! > output/server.pid
  i=0; until curl -fs "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1; do
    i=$((i+1)); [ $i -gt 40 ] && { echo "起動できませんでした（output/server.err.log を確認）"; exit 1; }; sleep 0.25
  done
fi
echo "Studio:     http://127.0.0.1:$PORT/"
echo "Control:    http://127.0.0.1:$PORT/control.html"
echo "OBS source: http://127.0.0.1:$PORT/?output=1  (1920 x 1080)"
if command -v open >/dev/null 2>&1; then open "http://127.0.0.1:$PORT/control.html"
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "http://127.0.0.1:$PORT/control.html" >/dev/null 2>&1 || true; fi
