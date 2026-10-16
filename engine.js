'use strict';
/*
 * NEXUS — game engine.
 * Pure, dependency-free, deterministic given the sequence of actions.
 * See README.md for the rules.
 *
 * Tuning (chosen so that no single action dominates and a match ends in a few
 * minutes): growing is the efficient default but expensive (4), raiding is cheap
 * (2) and is the answer to a runaway leader, fortifying is a cheap shield (1),
 * mining (free, +3) is how you afford the others early on.
 */

const crypto = require('crypto');

const SIZE = 6;
const MAX_ROUNDS = 20;
const TURN_MS = 15000;          // per-turn clock
const HARD_CAP_MS = 9 * 60 * 1000; // absolute match cap (< 10 min requirement)

const COST = { grow: 4, strike: 2, fortify: 1, mine: 0 };
const MINE_GAIN = 3;
const CRYSTAL_BONUS = 3;
const START_ENERGY = 5;
const INCOME_PER_TILE = 1;

const CRYSTALS = [[2, 2], [2, 3], [3, 2], [3, 3]];
const STARTS = {
  2: [[0, 0], [5, 5]],
  3: [[0, 0], [5, 5], [5, 0]],
  4: [[0, 0], [5, 5], [5, 0], [0, 5]],
};

const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

const inBounds = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;
const token = () => crypto.randomBytes(12).toString('hex');

function newBoard() {
  const b = [];
  for (let r = 0; r < SIZE; r++) {
    const row = [];
    for (let c = 0; c < SIZE; c++) row.push({ owner: null, crystal: false, fortified: false });
    b.push(row);
  }
  for (const [r, c] of CRYSTALS) b[r][c].crystal = true;
  return b;
}

function countTiles(state, seat) {
  let n = 0;
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++) if (state.board[r][c].owner === seat) n++;
  return n;
}

function emptyTiles(state) {
  const out = [];
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++) if (state.board[r][c].owner === null) out.push([r, c]);
  return out;
}

/* ---- match lifecycle ---------------------------------------------------- */

function createMatch(opts = {}) {
  const id = opts.id || crypto.randomUUID();
  return {
    id,
    code: opts.code || makeCode(),
    createdAt: Date.now(),
    size: SIZE,
    maxRounds: MAX_ROUNDS,
    phase: 'lobby',
    round: 0,
    turn: 0,
    hostSeat: 0,
    seats: opts.seats || 4,      // 2..4 target player count
    players: [],                 // filled by join()
    board: newBoard(),
    log: [],
    winner: null,
    endReason: null,
    startedAt: null,
    endedAt: null,
    turnDeadline: null,
    version: 0,
  };
}

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += A[crypto.randomInt(A.length)];
  return s;
}

function findSeat(state) {
  for (let s = 0; s < state.seats; s++) {
    if (!state.players.some((p) => p.seat === s)) return s;
  }
  return -1;
}

function join(state, { name, type = 'human' }) {
  if (state.phase !== 'lobby') return { ok: false, error: 'match_already_started' };
  const seat = findSeat(state);
  if (seat === -1) return { ok: false, error: 'match_full' };
  const p = {
    seat,
    name: (name || ('Player ' + (seat + 1))).slice(0, 24),
    type,
    token: token(),
    energy: START_ENERGY,
  };
  state.players.push(p);
  state.version++;
  log(state, { kind: 'join', seat, name: p.name, type });
  return { ok: true, player: { seat: p.seat, name: p.name, token: p.token } };
}

function addBot(state, seat) {
  if (state.phase !== 'lobby') return { ok: false, error: 'match_already_started' };
  if (state.players.some((p) => p.seat === seat)) return { ok: false, error: 'seat_taken' };
  const p = { seat, name: 'Bot ' + (seat + 1), type: 'bot', token: token(), energy: START_ENERGY };
  state.players.push(p);
  state.version++;
  log(state, { kind: 'join', seat, name: p.name, type: 'bot' });
  return { ok: true };
}

function start(state) {
  if (state.phase !== 'lobby') return { ok: false, error: 'already_started' };
  if (state.players.length < 2) return { ok: false, error: 'need_two_players' };
  const starts = STARTS[state.players.length];
  state.players.forEach((p, i) => {
    const [r, c] = starts[i];
    state.board[r][c].owner = p.seat;
    p.energy = START_ENERGY;
  });
  state.phase = 'active';
  state.round = 1;
  state.turn = 0;
  state.startedAt = Date.now();
  state.turnDeadline = Date.now() + TURN_MS;
  state.version++;
  log(state, { kind: 'start', round: 1, seats: state.players.map((p) => p.seat) });
  return { ok: true };
}

/* ---- actions ------------------------------------------------------------ */

function neighbors(r, c) {
  const out = [];
  for (const [dr, dc] of DIRS) {
    const rr = r + dr, cc = c + dc;
    if (inBounds(rr, cc)) out.push([rr, cc]);
  }
  return out;
}

function territoryFrontier(state, seat) {
  // empty tiles adjacent to a tile owned by `seat`
  const seen = new Set();
  const out = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (state.board[r][c].owner !== seat) continue;
      for (const [rr, cc] of neighbors(r, c)) {
        const k = rr + ',' + cc;
        if (state.board[rr][cc].owner === null && !seen.has(k)) {
          seen.add(k);
          out.push([rr, cc]);
        }
      }
    }
  }
  return out;
}

function strikeTargets(state, seat) {
  const seen = new Set();
  const out = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (state.board[r][c].owner !== seat) continue;
      for (const [rr, cc] of neighbors(r, c)) {
        const t = state.board[rr][cc];
        const k = rr + ',' + cc;
        if (t.owner !== null && t.owner !== seat && !t.fortified && !seen.has(k)) {
          seen.add(k);
          out.push([rr, cc]);
        }
      }
    }
  }
  return out;
}

function legalActions(state, seat) {
  if (state.phase !== 'active') return [];
  const me = state.players.find((p) => p.seat === seat);
  if (!me) return [];
  if (state.players[state.turn].seat !== seat) return [];
  const acts = [];
  const tiles = countTiles(state, seat);

  if (me.energy >= COST.mine) acts.push({ type: 'mine' });

  if (me.energy >= COST.grow) {
    const targets = tiles === 0 ? emptyTiles(state) : territoryFrontier(state, seat);
    for (const [r, c] of targets) acts.push({ type: 'grow', to: [r, c] });
  }

  if (me.energy >= COST.strike) {
    for (const [r, c] of strikeTargets(state, seat)) acts.push({ type: 'strike', to: [r, c] });
  }

  if (me.energy >= COST.fortify) {
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++)
        if (state.board[r][c].owner === seat && !state.board[r][c].fortified)
          acts.push({ type: 'fortify', at: [r, c] });
  }
  return acts;
}

function validate(state, seat, action) {
  const me = state.players.find((p) => p.seat === seat);
  if (!me) return 'not_a_player';
  if (state.phase !== 'active') return 'match_not_active';
  if (state.players[state.turn].seat !== seat) return 'not_your_turn';
  if (!action || typeof action.type !== 'string') return 'bad_action';
  const cost = COST[action.type];
  if (cost === undefined) return 'unknown_action';
  if (me.energy < cost) return 'not_enough_energy';

  const tiles = countTiles(state, seat);

  if (action.type === 'grow') {
    const [r, c] = action.to || [];
    if (!inBounds(r, c)) return 'out_of_bounds';
    if (state.board[r][c].owner !== null) return 'tile_not_empty';
    const frontier = tiles === 0 ? emptyTiles(state) : territoryFrontier(state, seat);
    if (!frontier.some(([fr, fc]) => fr === r && fc === c)) return 'not_adjacent';
    return null;
  }
  if (action.type === 'strike') {
    const [r, c] = action.to || [];
    if (!inBounds(r, c)) return 'out_of_bounds';
    const t = state.board[r][c];
    if (t.owner === null || t.owner === seat) return 'no_enemy_tile';
    if (t.fortified) return 'tile_fortified';
    if (!strikeTargets(state, seat).some(([fr, fc]) => fr === r && fc === c)) return 'not_adjacent';
    return null;
  }
  if (action.type === 'fortify') {
    const [r, c] = action.at || [];
    if (!inBounds(r, c)) return 'out_of_bounds';
    if (state.board[r][c].owner !== seat) return 'not_your_tile';
    if (state.board[r][c].fortified) return 'already_fortified';
    return null;
  }
  return null; // mine
}

function apply(state, seat, action) {
  const err = validate(state, seat, action);
  if (err) return { ok: false, error: err };
  const me = state.players.find((p) => p.seat === seat);
  let detail = '';

  if (action.type === 'grow') {
    const [r, c] = action.to;
    me.energy -= COST.grow;
    state.board[r][c].owner = seat;
    if (state.board[r][c].crystal) {
      state.board[r][c].crystal = false;
      me.energy += CRYSTAL_BONUS;
      detail = `claimed crystal at ${r},${c} (+${CRYSTAL_BONUS})`;
    } else {
      detail = `grew to ${r},${c}`;
    }
  } else if (action.type === 'strike') {
    const [r, c] = action.to;
    const victim = state.board[r][c].owner;
    me.energy -= COST.strike;
    // A strike is a RAID: the tile is razed back to neutral, not captured. It denies
    // the owner the tile (and its income) without handing you free territory, so
    // expanding is the efficient default and raids are a targeted tool.
    state.board[r][c].owner = null;
    state.board[r][c].fortified = false;
    detail = `razed ${r},${c} (was seat ${victim})`;
  } else if (action.type === 'fortify') {
    const [r, c] = action.at;
    me.energy -= COST.fortify;
    state.board[r][c].fortified = true;
    detail = `fortified ${r},${c}`;
  } else {
    me.energy += MINE_GAIN;
    detail = `mined (+${MINE_GAIN})`;
  }

  log(state, { kind: 'action', seat, action: action.type, detail, energy: me.energy, tiles: countTiles(state, seat) });
  endTurn(state);
  state.version++;
  return { ok: true };
}

/* ---- turn / end --------------------------------------------------------- */

function log(state, entry) {
  state.log.push({ t: Date.now(), round: state.round, ...entry });
  if (state.log.length > 4000) state.log.splice(0, state.log.length - 4000);
}

function boardFull(state) {
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++) if (state.board[r][c].owner === null) return false;
  return true;
}

function endTurn(state) {
  // income for the player who just acted
  const cur = state.players[state.turn];
  const inc = countTiles(state, cur.seat) * INCOME_PER_TILE;
  if (inc > 0) {
    cur.energy += inc;
    log(state, { kind: 'income', seat: cur.seat, gain: inc, energy: cur.energy });
  }

  if (checkEnd(state)) return;

  // advance to next seat (players are ordered by seat; skip none since all play)
  state.turn = (state.turn + 1) % state.players.length;
  if (state.turn === 0) state.round++;
  // clear fortifications belonging to the player whose turn is starting
  const nextSeat = state.players[state.turn].seat;
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++)
      if (state.board[r][c].owner === nextSeat) state.board[r][c].fortified = false;
  state.turnDeadline = Date.now() + TURN_MS;

  if (checkEnd(state)) return;
}

function standings(state) {
  return state.players
    .map((p) => ({ seat: p.seat, name: p.name, tiles: countTiles(state, p.seat), energy: p.energy }))
    .sort((a, b) => b.tiles - a.tiles || b.energy - a.energy);
}

function finish(state, reason) {
  state.phase = 'finished';
  state.endedAt = Date.now();
  state.endReason = reason;
  const st = standings(state);
  const top = st[0];
  const tie = st.filter((s) => s.tiles === top.tiles && s.energy === top.energy);
  state.winner = tie.length === 1 ? top.seat : null; // null => draw
  state.standings = st;
  state.turnDeadline = null;
  log(state, { kind: 'end', reason, winner: state.winner, standings: st });
}

function checkEnd(state) {
  if (state.phase !== 'active') return true;
  if (boardFull(state)) return finish(state, 'board_full') || true;
  if (state.round > state.maxRounds) return finish(state, 'round_limit') || true;
  if (state.startedAt && Date.now() - state.startedAt > HARD_CAP_MS) return finish(state, 'time_cap') || true;
  return false;
}

/* ---- views -------------------------------------------------------------- */

function publicState(state, viewerSeat = null) {
  return {
    id: state.id,
    code: state.code,
    phase: state.phase,
    round: state.round,
    maxRounds: state.maxRounds,
    turn: state.phase === 'active' ? state.players[state.turn].seat : null,
    turnDeadline: state.turnDeadline,
    seats: state.seats,
    size: SIZE,
    players: state.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      type: p.type,
      energy: p.energy,
      tiles: countTiles(state, p.seat),
      isTurn: state.phase === 'active' && state.players[state.turn].seat === p.seat,
    })),
    board: state.board.map((row) => row.map((t) => ({ owner: t.owner, crystal: t.crystal, fortified: t.fortified }))),
    winner: state.winner,
    endReason: state.endReason,
    standings: state.standings || null,
    version: state.version,
    log: state.log.slice(-60),
    yourSeat: viewerSeat,
    legalActions: viewerSeat === null ? undefined : legalActions(state, viewerSeat),
  };
}

module.exports = {
  SIZE, MAX_ROUNDS, TURN_MS, HARD_CAP_MS, COST, MINE_GAIN, CRYSTAL_BONUS,
  START_ENERGY, INCOME_PER_TILE, CRYSTALS, STARTS,
  createMatch, join, addBot, start, legalActions, validate, apply, endTurn,
  publicState, standings, countTiles, boardFull, findSeat, checkEnd, token,
};
