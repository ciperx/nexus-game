'use strict';
/* NEXUS engine tests — run with: node test.js */

const assert = require('assert');
const engine = require('./engine');
const bot = require('./bot');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

function fresh(seats = 2) {
  const m = engine.createMatch({ seats });
  for (let i = 0; i < seats; i++) engine.join(m, { name: 'P' + i });
  engine.start(m);
  return m;
}
const seatOf = (m, i) => m.players[i].seat;

console.log('NEXUS engine tests');

test('setup: two players start on corners with 1 tile and starting energy', () => {
  const m = fresh(2);
  assert.strictEqual(m.phase, 'active');
  assert.strictEqual(engine.countTiles(m, 0), 1);
  assert.strictEqual(engine.countTiles(m, 1), 1);
  assert.strictEqual(m.players[0].energy, engine.START_ENERGY);
  assert.strictEqual(m.board[0][0].owner, 0);
  assert.strictEqual(m.board[5][5].owner, 1);
});

test('start positions differ for 3 and 4 players', () => {
  const m3 = fresh(3); assert.strictEqual(m3.board[5][0].owner, 2);
  const m4 = fresh(4); assert.strictEqual(m4.board[0][5].owner, 3);
});

test('grow: only adjacent empty tiles are legal; cost is applied', () => {
  const m = fresh(2);
  const acts = engine.legalActions(m, 0);
  const grows = acts.filter((a) => a.type === 'grow');
  assert.ok(grows.length >= 2, 'expected frontier tiles');
  assert.ok(grows.every((g) => (g.to[0] === 1 && g.to[1] === 0) || (g.to[0] === 0 && g.to[1] === 1)));
  const before = m.players[0].energy;
  assert.strictEqual(engine.apply(m, 0, { type: 'grow', to: [1, 0] }).ok, true);
  assert.strictEqual(engine.countTiles(m, 0), 2);
  // -COST.grow for the action, then end-of-turn income of +1 per owned tile (now 2)
  assert.strictEqual(m.players[0].energy, before - engine.COST.grow + 2);
});

test('grow: far-away tile is rejected', () => {
  const m = fresh(2);
  assert.strictEqual(engine.apply(m, 0, { type: 'grow', to: [4, 4] }).error, 'not_adjacent');
});

test('turn order: you cannot move out of turn', () => {
  const m = fresh(2);
  assert.strictEqual(engine.apply(m, 1, { type: 'mine' }).error, 'not_your_turn');
});

test('crystal pays a one-off +3 when claimed', () => {
  const m = fresh(2);
  // teleport player 0 next to a crystal at (2,2)
  m.board[1][2].owner = 0;
  m.turn = 0;
  const e = m.players[0].energy;
  const r = engine.apply(m, 0, { type: 'grow', to: [2, 2] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(m.board[2][2].owner, 0);
  assert.strictEqual(m.board[2][2].crystal, false);
  // spent 2 on grow, gained 3 crystal, gained income for new tiles
  assert.ok(m.players[0].energy >= e - 2 + 3);
});

test('strike razes an adjacent enemy tile back to neutral', () => {
  const m = fresh(2);
  m.board[1][0].owner = 0;   // mine
  m.board[1][1].owner = 1;   // enemy next to mine
  m.turn = 0;
  const e = m.players[0].energy;
  const r = engine.apply(m, 0, { type: 'strike', to: [1, 1] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(m.board[1][1].owner, null);        // razed, not captured
  assert.strictEqual(engine.countTiles(m, 0), 2);       // start tile + [1,0]; striking gains no territory
  assert.strictEqual(m.players[0].energy, e - engine.COST.strike + 2); // -cost, +income (2 tiles)
});

test('strike rejects your own tiles and empty tiles', () => {
  const m = fresh(2);
  m.board[1][0].owner = 0;
  m.turn = 0;
  assert.strictEqual(engine.apply(m, 0, { type: 'strike', to: [1, 0] }).error, 'no_enemy_tile');
  assert.strictEqual(engine.apply(m, 0, { type: 'strike', to: [2, 0] }).error, 'no_enemy_tile');
});

test('fortified tiles cannot be struck until the owner is on turn again', () => {
  const m = fresh(2);
  m.board[1][0].owner = 0;
  m.board[1][1].owner = 1;
  m.turn = 0;
  // player 1 fortifies (2,1)... set turn to 1 first
  m.board[2][1].owner = 1;
  m.turn = 1;
  assert.strictEqual(engine.apply(m, 1, { type: 'fortify', at: [1, 1] }).ok, true);
  assert.strictEqual(m.board[1][1].fortified, true);
  // now player 0 tries to strike the fortified tile
  m.turn = 0;
  assert.strictEqual(engine.apply(m, 0, { type: 'strike', to: [1, 1] }).error, 'tile_fortified');
});

test('energy never goes negative and unaffordable actions are rejected', () => {
  const m = fresh(2);
  m.players[0].energy = 1;
  assert.strictEqual(engine.apply(m, 0, { type: 'grow', to: [1, 0] }).error, 'not_enough_energy');
  assert.strictEqual(engine.apply(m, 0, { type: 'strike', to: [1, 1] }).error, 'not_enough_energy');
  assert.ok(engine.legalActions(m, 0).every((a) => a.type === 'mine' || a.type === 'fortify'));
});

test('income: +1 per owned tile at end of turn', () => {
  const m = fresh(2);
  m.board[0][1].owner = 0; // 2 tiles for player 0
  m.turn = 0;
  const before = m.players[0].energy;
  engine.apply(m, 0, { type: 'mine' }); // +3 mine, +2 income
  assert.strictEqual(m.players[0].energy, before + 3 + 2);
});

test('board full ends the match and the tile leader wins', () => {
  const m = fresh(2);
  for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) m.board[r][c].owner = 0;
  m.board[5][5].owner = 1;
  engine.checkEnd(m);
  assert.strictEqual(m.phase, 'finished');
  assert.strictEqual(m.endReason, 'board_full');
  assert.strictEqual(m.winner, 0);
});

test('round limit ends the match', () => {
  const m = fresh(2);
  m.round = m.maxRounds + 1;
  engine.checkEnd(m);
  assert.strictEqual(m.phase, 'finished');
  assert.strictEqual(m.endReason, 'round_limit');
});

test('public state hides tokens', () => {
  const m = fresh(2);
  const s = engine.publicState(m, 0);
  assert.ok(!JSON.stringify(s).includes(m.players[0].token));
  assert.strictEqual(s.yourSeat, 0);
  assert.ok(Array.isArray(s.legalActions));
});

test('bot always returns a legal action when one exists', () => {
  const m = fresh(4);
  for (let i = 0; i < 200 && m.phase === 'active'; i++) {
    const seat = m.players[m.turn].seat;
    const acts = engine.legalActions(m, seat);
    const a = bot.chooseAction(engine.publicState(m, seat), acts, seat);
    assert.ok(a, 'bot produced no action');
    assert.strictEqual(engine.apply(m, seat, a).ok, true);
  }
  assert.strictEqual(m.phase, 'finished', 'bot-vs-bot match should terminate');
  assert.ok(m.standings.length === 4);
});

test('a full 4-bot match terminates well under the turn budget', () => {
  const m = engine.createMatch({ seats: 4 });
  for (let i = 0; i < 4; i++) engine.addBot(m, i);
  engine.start(m);
  let steps = 0;
  while (m.phase === 'active' && steps < 2000) {
    const seat = m.players[m.turn].seat;
    const acts = engine.legalActions(m, seat);
    engine.apply(m, seat, bot.chooseAction(engine.publicState(m, seat), acts, seat) || acts[0]);
    steps++;
  }
  assert.strictEqual(m.phase, 'finished');
  assert.ok(steps < 2000);
});

test('no single action dominates: a bot match uses grow, strike and mine', () => {
  const used = new Set();
  for (let t = 0; t < 6; t++) {
    const m = engine.createMatch({ seats: 3 });
    for (let i = 0; i < 3; i++) engine.addBot(m, i);
    engine.start(m);
    let steps = 0;
    while (m.phase === 'active' && steps < 3000) {
      const seat = m.players[m.turn].seat;
      const acts = engine.legalActions(m, seat);
      const a = bot.chooseAction(engine.publicState(m, seat), acts, seat) || acts[0];
      used.add(a.type);
      engine.apply(m, seat, a);
      steps++;
    }
  }
  assert.ok(used.has('grow'), 'grow should be used');
  assert.ok(used.has('strike'), 'strike/raid should be used');
  assert.ok(used.has('mine'), 'mine should be used when energy is tight');
});

test('costs are the documented ones', () => {
  assert.deepStrictEqual(engine.COST, { grow: 4, strike: 2, fortify: 1, mine: 0 });
  assert.strictEqual(engine.MINE_GAIN, 3);
  assert.strictEqual(engine.CRYSTAL_BONUS, 3);
  assert.strictEqual(engine.INCOME_PER_TILE, 1);
});

test('every engine symbol the server and bot use is exported', () => {
  // Regression guard: a missing export only shows up at runtime (and only on the
  // path that uses it), which is how the log helper crashed the server on a turn
  // timeout. Parse the callers and assert every referenced member resolves.
  const fs = require('fs');
  const path = require('path');
  const seen = new Set();
  for (const f of ['server.js', 'bot.js', 'test.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    for (const m of src.matchAll(/\bengine\.([A-Za-z_][A-Za-z0-9_]*)/g)) seen.add(m[1]);
  }
  assert.ok(seen.size > 5, 'should find engine usages');
  for (const name of seen) {
    assert.ok(name in engine, `engine.${name} is used but not exported`);
  }
  assert.strictEqual(typeof engine.log, 'function');
});

test('a human turn that times out is auto-resolved as mine and logged', () => {
  const m = fresh(2);
  const seat = m.turn;
  const tiles = engine.countTiles(m, seat);
  // This is exactly what server.js autoPlay(state, true) does on the timeout path.
  engine.log(m, { kind: 'timeout', seat });
  engine.apply(m, seat, { type: 'mine' });
  const last = m.log[m.log.length - 1];
  assert.ok(m.log.some((e) => e.kind === 'timeout' && e.seat === seat), 'timeout should be logged');
  assert.ok(m.players[seat].energy > engine.START_ENERGY, 'mine should have paid +3');
  assert.strictEqual(engine.countTiles(m, seat), tiles, 'mine takes no territory');
  assert.ok(last, 'log is append-only');
});

test('publicState never leaks another seat\'s token', () => {
  const m = fresh(3);
  const view = engine.publicState(m, 0);
  const tokens = m.players.map((p) => p.token);
  const blob = JSON.stringify(view);
  for (const t of tokens) assert.ok(!blob.includes(t), 'token leaked in public state');
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
