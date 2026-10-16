'use strict';
/*
 * NEXUS sample bot.
 *
 * Two uses:
 *   1) In-process:  const { chooseAction } = require('./bot');  -> used by the server
 *      to fill empty seats ("bots") so a solo human always has opponents.
 *   2) Standalone agent over HTTP:
 *        node bot.js --server http://localhost:8080 --join <matchIdOrCode> [--name MyBot]
 *        node bot.js --server http://localhost:8080 --create 4
 *
 * How it plays: for every legal action it simulates the move on a copy of the game
 * state, then scores the resulting position with a small positional evaluation
 * (territory, income potential, expansion frontier, how far ahead the leader is).
 * It picks the best. That is a few dozen lines of "AI" — a readable starting point
 * for a stronger agent, not a grandmaster.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const engine = require('./engine');

const SIZE = engine.SIZE;
const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

const inB = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;

function frontierSize(state, seat) {
  const seen = new Set();
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++)
      if (state.board[r][c].owner === seat)
        for (const [dr, dc] of DIRS) {
          const rr = r + dr, cc = c + dc;
          if (inB(rr, cc) && state.board[rr][cc].owner === null) seen.add(rr + ',' + cc);
        }
  return seen.size;
}

function crystalsInReach(state, seat) {
  const seen = new Set();
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++) {
      if (state.board[r][c].owner !== seat) continue;
      for (const [dr, dc] of DIRS) {
        const rr = r + dr, cc = c + dc;
        if (inB(rr, cc) && state.board[rr][cc].crystal) seen.add(rr + ',' + cc);
      }
    }
  return seen.size;
}

/** My unfortified tiles that sit next to an enemy tile — i.e. raidable. */
function exposedTiles(state, seat) {
  let n = 0;
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++) {
      const t = state.board[r][c];
      if (t.owner !== seat || t.fortified) continue;
      for (const [dr, dc] of DIRS) {
        const rr = r + dr, cc = c + dc;
        if (inB(rr, cc) && state.board[rr][cc].owner !== null && state.board[rr][cc].owner !== seat) { n++; break; }
      }
    }
  return n;
}

/** Positional score of `state` from `seat`'s point of view. Higher is better. */
function evaluate(state, seat) {
  const me = state.players.find((p) => p.seat === seat);
  if (!me) return -1e9;
  const mine = engine.countTiles(state, seat);
  const oppTiles = state.players.filter((p) => p.seat !== seat).map((p) => engine.countTiles(state, p.seat));
  const leader = Math.max(0, ...oppTiles);
  const oppSum = oppTiles.reduce((a, b) => a + b, 0);

  let v = (mine - oppSum) * 12 + me.energy * 1.0;
  v += frontierSize(state, seat) * 2.5;      // room to keep growing
  v += crystalsInReach(state, seat) * 3.5;   // nearby prizes
  v -= exposedTiles(state, seat) * 3.0;      // tiles a raid could take
  v -= leader * 4;                           // keep an eye on the leader

  if (state.phase === 'finished') {
    if (state.winner === seat) v += 1e6;
    else if (state.winner === null) v += 2e5;
    else v -= 1e6;
  }
  return v;
}

function chooseAction(state, actions, seat, rng = Math.random) {
  if (!actions || actions.length === 0) return null;
  let best = null, bestV = -Infinity;
  for (const a of actions) {
    let clone;
    try { clone = JSON.parse(JSON.stringify(state)); } catch { continue; }
    if (!engine.apply(clone, seat, a).ok) continue;
    const v = evaluate(clone, seat) + rng() * 0.9; // a little noise = variety
    if (v > bestV) { bestV = v; best = a; }
  }
  return best || actions[0];
}

/* ------------------------- standalone HTTP agent ------------------------- */

function request(method, urlStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const req = lib.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
        headers: Object.assign({ 'content-type': 'application/json' },
          data ? { 'content-length': Buffer.byteLength(data) } : {}) },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') }); }
          catch (e) { resolve({ status: res.statusCode, json: null, raw: buf }); }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function playOverHttp({ server, join, create, name }) {
  const base = server.replace(/\/$/, '');
  let matchId = join;
  let token, seat;
  if (create) {
    const r = await request('POST', `${base}/api/matches`, { seats: Number(create) || 4, name });
    if (!r.json?.ok) throw new Error('create failed: ' + JSON.stringify(r.json));
    matchId = r.json.data.id;
    token = r.json.data.token;
    seat = r.json.data.seat;
    console.log('created match', matchId, 'code', r.json.data.code, 'as seat', seat);
  }
  if (!matchId) throw new Error('pass --join <id|code> or --create <2-4>');

  if (token === undefined) {
    const j = await request('POST', `${base}/api/matches/${matchId}/join`, { name: name || 'HttpBot' });
    if (!j.json?.ok) throw new Error('join failed: ' + JSON.stringify(j.json));
    token = j.json.data.token;
    seat = j.json.data.seat;
    console.log(`joined ${matchId} as seat ${seat}`);
  }

  // if we are the host and no one else joined, start with bots
  for (let i = 0; i < 3; i++) {
    const st = await request('GET', `${base}/api/matches/${matchId}`);
    if (!st.json?.ok) break;
    const d = st.json.data;
    if (d.phase === 'lobby') {
      if (seat === 0) {
        const s = await request('POST', `${base}/api/matches/${matchId}/start`, { token });
        if (!s.json?.ok && s.json.error !== 'need_two_players') console.log('start:', s.json?.error);
      }
    }
    await new Promise((r) => setTimeout(r, 1200));
  }

  let seen = -1;
  for (let steps = 0; steps < 500; steps++) {
    const st = await request('GET', `${base}/api/matches/${matchId}/state?token=${token}`);
    if (!st.json?.ok) { await sleep(1000); continue; }
    const d = st.json.data;
    if (d.phase === 'finished') {
      console.log('match finished. winner:', d.winner, 'reason:', d.endReason);
      console.log(JSON.stringify(d.standings, null, 2));
      return d;
    }
    if (d.phase === 'active' && d.yourSeat === d.turn && d.legalActions?.length) {
      const act = chooseAction(d, d.legalActions, seat);
      if (act) {
        const mv = await request('POST', `${base}/api/matches/${matchId}/move`, { token, action: act });
        if (!mv.json?.ok) console.log('move rejected:', mv.json?.error);
      }
    }
    await sleep(400);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  playOverHttp({
    server: get('--server') || 'http://127.0.0.1:8080',
    join: get('--join'),
    create: get('--create'),
    name: get('--name') || 'SampleBot',
  }).catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { chooseAction, evaluate, frontierSize, playOverHttp };
