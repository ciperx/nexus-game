#!/bin/sh
# NEXUS supervisor - keeps the game server and the *named* Cloudflare tunnel alive.
export TUNNEL_ORIGIN_CERT=/root/.cloudflared/cert.pem
CF=/usr/local/bin/cloudflared
cd /opt/nexus || exit 1
mkdir -p logs

while true; do
  if ! ps -eo args | grep -q "[n]ode server.js 8910"; then
    nohup node server.js 8910 >> logs/server.log 2>&1 &
  fi
  if ! ps -eo args | grep -q "[c]loudflared tunnel --config /opt/nexus/tunnel.yml"; then
    nohup "$CF" tunnel --config /opt/nexus/tunnel.yml --no-autoupdate run nexus >> logs/tunnel_named.log 2>&1 &
  fi
  sleep 15
done
