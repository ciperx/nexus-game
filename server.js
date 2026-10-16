'use strict';
/*
 * NEXUS — HTTP server (humans + agents). Dependency-free Node.js.
 *
 *   node server.js [port]
 *
 * Serves the browser UI at /  and a JSON API under /api.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const engine = require('./engine');
const bot = require('./bot');

const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const PUB = path.join(__dirname, 'public');
const STARTED = Date.now();

const matches = new Map(); // id -> state
const MAX_MATCHES = 500;

/* ------------------------------- helpers -------------------------------- */

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function ok(res, data, code = 200) { json(res, code, { ok: true, data }); }
function fail(res, error, code = 400) { json(res, code, { ok: false, error }); }

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (d) => { buf += d; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch { resolve({}); }
    });
  });
}

function resolveMatch(idOrCode) {
  if (matches.has(idOrCode)) return matches.get(idOrCode);
  const up = String(idOrCode || '').toUpperCase();
  for (const m of matches.values()) if (m.code === up) return m;
  return null;
}

function seatOf(state, token) {
  if (!token) return null;
  const p = state.players.find((x) => x.token === token);
  return p ? p.seat : null;
}

/* --------------------------- bot / timeout loop -------------------------- */

const TIMEOUT_FALLBACK = { type: 'mine' };

function autoPlay(state, timedOut) {
  const cur = state.players[state.turn];
  if (!cur) return;
  const acts = engine.legalActions(state, cur.seat);
  if (!acts.length) return;
  let action;
  if (timedOut && cur.type !== 'bot') {
    action = acts.find((a) => a.type === 'mine') || acts[0];
    engine.log(state, { kind: 'timeout', seat: cur.seat });
  } else {
    action = bot.chooseAction(engine.publicState(state, cur.seat), acts, cur.seat) || acts[0];
  }
  engine.apply(state, cur.seat, action);
}

function tick() {
  const now = Date.now();
  for (const m of matches.values()) {
    if (m.phase !== 'active') continue;
    if (m.turnDeadline && now > m.turnDeadline) { autoPlay(m, true); m.botAt = 0; continue; }
    const cur = m.players[m.turn];
    if (cur && cur.type === 'bot') {
      if (!m.botAt) m.botAt = now + 650;
      if (now >= m.botAt) { m.botAt = 0; autoPlay(m, false); }
    } else { m.botAt = 0; }
  }
}
setInterval(tick, 400);

function gc() {
  const now = Date.now();
  for (const [id, m] of matches) {
    const age = now - (m.endedAt || m.createdAt);
    if ((m.phase === 'finished' && age > 2 * 3600 * 1000) || age > 6 * 3600 * 1000) matches.delete(id);
  }
  if (matches.size > MAX_MATCHES) {
    const sorted = [...matches.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const m of sorted.slice(0, matches.size - MAX_MATCHES)) matches.delete(m.id);
  }
}
setInterval(gc, 60 * 1000);

/* --------------------------------- API ---------------------------------- */

async function api(req, res, u) {
  const parts = u.pathname.split('/').filter(Boolean); // ['api', ...]
  const body = req.method === 'POST' ? await readBody(req) : {};
  const method = req.method;

  // POST /api/matches
  if (parts.length === 2 && parts[1] === 'matches' && method === 'POST') {
    const seats = Math.min(4, Math.max(2, Number(body.seats) || 4));
    const m = engine.createMatch({ seats });
    matches.set(m.id, m);
    // host joins automatically
    const j = engine.join(m, { name: body.name || 'Host', type: 'human' });
    return ok(res, { id: m.id, code: m.code, seat: j.player.seat, token: j.player.token, seats });
  }

  // GET /api/matches
  if (parts.length === 2 && parts[1] === 'matches' && method === 'GET') {
    const list = [...matches.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 40)
      .map((m) => ({
        id: m.id, code: m.code, phase: m.phase, seats: m.seats,
        players: m.players.map((p) => ({ name: p.name, type: p.type })),
        round: m.round, winner: m.winner,
      }));
    return ok(res, { matches: list });
  }

  if (parts.length >= 3 && parts[1] === 'matches') {
    const m = resolveMatch(parts[2]);
    if (!m) return fail(res, 'match_not_found', 404);
    const sub = parts[3];

    // GET /api/matches/:id
    if (parts.length === 3 && method === 'GET') {
      const seat = seatOf(m, u.searchParams.get('token'));
      return ok(res, engine.publicState(m, seat));
    }
    // GET /api/matches/:id/state
    if (sub === 'state' && method === 'GET') {
      const seat = seatOf(m, u.searchParams.get('token'));
      return ok(res, engine.publicState(m, seat));
    }
    // GET /api/matches/:id/legal
    if (sub === 'legal' && method === 'GET') {
      const seat = seatOf(m, u.searchParams.get('token'));
      if (seat === null) return fail(res, 'bad_token', 403);
      return ok(res, { seat, actions: engine.legalActions(m, seat) });
    }
    // GET /api/matches/:id/replay
    if (sub === 'replay' && method === 'GET') {
      return ok(res, {
        id: m.id, code: m.code, seats: m.seats,
        players: m.players.map((p) => ({ seat: p.seat, name: p.name, type: p.type })),
        winner: m.winner, endReason: m.endReason,
        standings: m.standings, log: m.log,
      });
    }
    // POST /api/matches/:id/join
    if (sub === 'join' && method === 'POST') {
      const r = engine.join(m, { name: body.name, type: 'human' });
      if (!r.ok) return fail(res, r.error);
      return ok(res, { seat: r.player.seat, token: r.player.token, name: r.player.name });
    }
    // POST /api/matches/:id/bot
    if (sub === 'bot' && method === 'POST') {
      const seat = body.seat === undefined ? engine.findSeat(m) : Number(body.seat);
      if (seat === -1) return fail(res, 'match_full');
      const r = engine.addBot(m, seat);
      if (!r.ok) return fail(res, r.error);
      return ok(res, { seat });
    }
    // POST /api/matches/:id/start
    if (sub === 'start' && method === 'POST') {
      const seat = seatOf(m, body.token);
      if (seat === null) return fail(res, 'bad_token', 403);
      // fill empty seats with bots so a solo host can always play
      for (let s = 0; s < m.seats; s++) if (!m.players.some((p) => p.seat === s)) engine.addBot(m, s);
      const r = engine.start(m);
      if (!r.ok) return fail(res, r.error);
      return ok(res, engine.publicState(m, seat));
    }
    // POST /api/matches/:id/move
    if (sub === 'move' && method === 'POST') {
      const seat = seatOf(m, body.token);
      if (seat === null) return fail(res, 'bad_token', 403);
      const r = engine.apply(m, seat, body.action);
      if (!r.ok) return fail(res, r.error);
      return ok(res, engine.publicState(m, seat));
    }
  }

  // GET /api/docs  (machine-readable API description)
  if (parts.length === 2 && parts[1] === 'docs' && method === 'GET') {
    return ok(res, apiDescription());
  }

  return fail(res, 'not_found', 404);
}

function apiDescription() {
  return {
    name: 'NEXUS API',
    version: 1,
    auth: 'Each seat has a token. Pass it as ?token= on GETs or {"token": ...} in POST bodies.',
    rules: '6x6 board, 2-4 players. Each turn take ONE action: grow(4), strike(2, razes an adjacent enemy tile to neutral), fortify(1) or mine(+3). End of turn you gain +1 energy per tile owned. Crystals give +3 when claimed. Most tiles when the board fills or after 20 rounds wins (ties broken by energy).',
    endpoints: [
      { method: 'POST', path: '/api/matches', body: { seats: '2-4', name: 'string?' }, returns: '{id, code, seat, token}' },
      { method: 'GET', path: '/api/matches', returns: '{matches:[...]}' },
      { method: 'GET', path: '/api/matches/:id', returns: 'public state' },
      { method: 'GET', path: '/api/matches/:id/state?token=', returns: 'state + your legalActions' },
      { method: 'GET', path: '/api/matches/:id/legal?token=', returns: '{seat, actions}' },
      { method: 'GET', path: '/api/matches/:id/replay', returns: 'full log + standings' },
      { method: 'POST', path: '/api/matches/:id/join', body: { name: 'string?' }, returns: '{seat, token}' },
      { method: 'POST', path: '/api/matches/:id/bot', body: { seat: 'int?' }, returns: '{seat}' },
      { method: 'POST', path: '/api/matches/:id/start', body: { token: 'string' }, returns: 'state (empty seats auto-filled with bots)' },
      { method: 'POST', path: '/api/matches/:id/move', body: { token: 'string', action: '{...}' }, returns: 'state' },
    ],
    actions: {
      grow: { cost: 4, fields: { to: '[row,col] adjacent to your territory, empty' } },
      strike: { cost: 2, fields: { to: '[row,col] adjacent to your territory, owned by an enemy, not fortified' }, effect: 'razes the tile to neutral' },
      fortify: { cost: 1, fields: { at: '[row,col] your tile' } },
      mine: { cost: 0, gain: 3 },
    },
    example: {
      create: 'curl -s -XPOST localhost:8080/api/matches -H "content-type: application/json" -d \'{"seats":2}\'',
      poll: 'curl -s "localhost:8080/api/matches/MATCH/state?token=TOKEN"',
      move: 'curl -s -XPOST localhost:8080/api/matches/MATCH/move -H "content-type: application/json" -d \'{"token":"TOKEN","action":{"type":"mine"}}\'',
    },
  };
}

/* ------------------------------- static --------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (rel === '/docs') rel = '/docs.html';
  const full = path.join(PUB, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(PUB)) return fail(res, 'forbidden', 403);
  fs.readFile(full, (err, data) => {
    if (err) return fail(res, 'not_found', 404);
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream',
      'access-control-allow-origin': '*', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }
  try {
    if (u.pathname === '/health') return ok(res, { status: 'up', uptimeMs: Date.now() - STARTED, matches: matches.size });
    if (u.pathname.startsWith('/api/')) return await api(req, res, u);
    return serveStatic(req, res, u.pathname);
  } catch (e) {
    return fail(res, 'internal_error', 500);
  }
});

server.listen(PORT, () => {
  console.log(`NEXUS listening on http://127.0.0.1:${PORT}  (ui: /, docs: /docs, api: /api/docs)`);
});
