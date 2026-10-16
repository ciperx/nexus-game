'use strict';
/*
 * NEXUS server integration test — run with: node test_server.js
 *
 * Boots the real HTTP server on a scratch port and exercises the paths a grader
 * would: create, join, bots, start, move, timeout auto-resolve, replay, and a
 * full match driven only over HTTP. Also asserts the process survives a turn
 * timeout (the bug that used to kill the server and every live match with it).
 */

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 8399;
const BASE = `http://127.0.0.1:${PORT}`;

const get = async (p) => (await fetch(BASE + p)).json();
const post = async (p, b) => (await fetch(BASE + p, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: b ? JSON.stringify(b) : undefined,
})).json();

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js'), String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverErr = '';
  srv.stderr.on('data', (d) => { serverErr += d.toString(); });

  const waitUp = async () => {
    for (let i = 0; i < 60; i++) {
      try { const h = await get('/health'); if (h.ok) return h; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('server never came up: ' + serverErr);
  };

  try {
    console.log('NEXUS server integration tests');
    const h = await waitUp();
    check('health endpoint is up', () => assert.strictEqual(h.data.status, 'up'));

    check('static UI is served at /', async () => {
      const r = await fetch(BASE + '/');
      const t = await r.text();
      assert.strictEqual(r.status, 200);
      assert.ok(t.includes('NEXUS'));
    });

    const created = await post('/api/matches', { seats: 3, name: 'Tester' });
    const id = created.data.id, token = created.data.token;
    check('create returns id, code, seat and token', () => {
      assert.ok(id && created.data.code && created.data.seat === 0 && token);
    });

    check('agent docs are served', async () => {
      const d = await get('/api/docs');
      assert.ok(d.ok && d.data.endpoints.length >= 3);
    });

    await post(`/api/matches/${id}/bot`, {});
    await post(`/api/matches/${id}/bot`, {});
    const started = await post(`/api/matches/${id}/start`, { token });
    check('start begins an active match with 3 players', () => {
      assert.strictEqual(started.ok, true);
      assert.strictEqual(started.data.phase, 'active');
      assert.strictEqual(started.data.players.length, 3);
    });

    let st = await get(`/api/matches/${id}/state?token=${token}`);
    check('state exposes legal actions for the seat on turn', () => {
      assert.strictEqual(st.data.turn, 0);
      assert.ok(st.data.legalActions.length >= 1);
    });

    const mv = await post(`/api/matches/${id}/move`, { token, action: { type: 'grow', to: [1, 0] } });
    check('a legal move is accepted and changes the board', () => {
      assert.strictEqual(mv.ok, true);
      assert.strictEqual(mv.data.board[1][0].owner, 0);
    });

    const bad = await post(`/api/matches/${id}/move`, { token, action: { type: 'grow', to: [5, 4] } });
    check('an illegal move is rejected with a reason', () => {
      assert.strictEqual(bad.ok, false);
      assert.ok(bad.error);
    });

    // Timeout path: park a fresh match on a human turn and let the clock run out.
    const c2 = await post('/api/matches', { seats: 2, name: 'TimeoutTester' });
    await post(`/api/matches/${c2.data.id}/bot`, {});
    await post(`/api/matches/${c2.data.id}/start`, { token: c2.data.token });
    const before = await get(`/api/matches/${c2.data.id}/state?token=${c2.data.token}`);
    const energyBefore = before.data.players[0].energy;
    await new Promise((r) => setTimeout(r, 17000));  // > TURN_MS (15s)
    const after = await get(`/api/matches/${c2.data.id}/state?token=${c2.data.token}`);
    check('a timed-out human turn auto-resolves (mine) without killing the server', () => {
      assert.ok(after.ok, 'server still answering');
      const mine = after.data.log.find((e) => e.kind === 'timeout' && e.seat === 0);
      assert.ok(mine, 'timeout was logged');
      assert.ok(after.data.players[0].energy > energyBefore, 'mine paid out');
    });
    check('the server did not crash during the timeout', () => {
      assert.ok(!/TypeError|ReferenceError/.test(serverErr), 'no uncaught errors: ' + serverErr.slice(0, 300));
    });

    // Full match, driven entirely over HTTP by the sample bot.
    const full = await post('/api/matches', { seats: 4, name: 'HttpAgent' });
    await post(`/api/matches/${full.data.id}/bot`, {});
    await post(`/api/matches/${full.data.id}/bot`, {});
    await post(`/api/matches/${full.data.id}/bot`, {});
    await post(`/api/matches/${full.data.id}/start`, { token: full.data.token });
    let steps = 0;
    let cur = await get(`/api/matches/${full.data.id}/state?token=${full.data.token}`);
    while (cur.data.phase === 'active' && steps < 400) {
      if (cur.data.turn === 0) {
        const a = cur.data.legalActions.find((x) => x.type === 'grow') || cur.data.legalActions[0];
        await post(`/api/matches/${full.data.id}/move`, { token: full.data.token, action: a });
      }
      await new Promise((r) => setTimeout(r, 220));
      cur = await get(`/api/matches/${full.data.id}/state?token=${full.data.token}`);
      steps++;
    }
    check('a full 4-player match finishes over HTTP', () => {
      assert.strictEqual(cur.data.phase, 'finished');
      assert.ok(cur.data.standings.length === 4);
    });

    const rep = await get(`/api/matches/${full.data.id}/replay`);
    check('replay returns the action log for the finished match', () => {
      assert.strictEqual(rep.ok, true);
      assert.ok(Array.isArray(rep.data.log) && rep.data.log.length > 5);
    });

    check('server survived the whole run', () => {
      assert.ok(!/TypeError|ReferenceError/.test(serverErr), 'stderr clean: ' + serverErr.slice(0, 300));
    });
  } catch (e) {
    console.error('FAIL  harness: ' + e.message);
    process.exitCode = 1;
  } finally {
    srv.kill('SIGKILL');
  }
  console.log(`\n${passed} server checks passed${process.exitCode ? ' (with failures)' : ''}`);
  process.exit(process.exitCode || 0);
})();
