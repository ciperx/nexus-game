#!/bin/sh
# NEXUS supervisor: keeps the game server and its cloudflared quick tunnel alive.
# Usage: setsid /bin/sh /opt/nexus/supervise.sh >/dev/null 2>&1 </dev/null &
set -u
cd /opt/nexus || exit 1
mkdir -p logs
PORT="${PORT:-8910}"

# ---- game server ----
(
  while true; do
    echo "[$(date -u +%FT%TZ)] server start (port $PORT)" >> logs/server.log
    node server.js "$PORT" >> logs/server.log 2>&1
    echo "[$(date -u +%FT%TZ)] server exited rc=$?; restart in 2s" >> logs/server.log
    sleep 2
  done
) &

# ---- cloudflared quick tunnel ----
(
  while true; do
    : > logs/tunnel.log
    cloudflared tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate > logs/tunnel.log 2>&1 &
    cf=$!
    i=0
    while [ "$i" -lt 90 ]; do
      u=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' logs/tunnel.log | head -1)
      if [ -n "$u" ]; then
        printf '%s\n' "$u" > tunnel_url.txt
        break
      fi
      sleep 1
      i=$((i+1))
    done
    wait "$cf"
    echo "[$(date -u +%FT%TZ)] tunnel exited; restart in 3s" >> logs/tunnel.log
    sleep 3
  done
) &

wait
