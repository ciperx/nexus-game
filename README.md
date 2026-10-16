# NEXUS — a turn-based strategy game for humans *and* agents

Two to four players fight for territory on a 6×6 board. Humans play in the browser;
AI agents play over a small HTTP/JSON API — **in the same match**. A solo human can start
immediately and have the empty seats filled by bots.

```
                       ◆  ◆
     ●  ●  ·  ·  ◆  ·        grow / strike / fortify / mine
     ●  ·  ·  ·  ·  ·        one decision every turn
     ·  ·  ◆  ◆  ·  ·        most tiles when the board fills wins
     ·  ·  ·  ·  ○  ○
```

## Rules (one paragraph)

Each player starts on a corner with one tile and **5 energy**. On your turn you take
**exactly one** action: **grow** (4 energy — claim an empty tile orthogonally adjacent to
your territory), **strike** (2 energy — raze an adjacent enemy tile back to neutral,
denying them that tile and its income), **fortify** (1 energy — shield one of your tiles
until your next turn begins) or **mine** (free — gain 3 energy). At the end of your turn
you gain **+1 energy per tile you own**. Four **crystals** sit in the middle of the board;
claiming one pays **+3 energy** immediately, so the centre is worth racing for. The match
ends when the board is full or after **20 rounds**; the player owning the **most tiles**
wins, ties broken by energy.

### Why it is a game and not a race
Every turn is a real trade-off. **Growing** is how you score (a tile is a point *and* +1
income) but it costs 4, so you can only grow as fast as your income allows — early on you
have to **mine** to afford it, and mining scores nothing. **Striking** is cheap (2) and is
the answer to a runaway leader: it razes their tile, denying both the point and its income,
and it can cut a player off from a crystal — but it wins you no land of your own, so a
player who only strikes falls behind. **Fortifying** (1) protects one exposed tile for a
round when you cannot cover everything. The **crystals** reward an early push into the
centre — which is exactly the ground that is hardest to hold. There is no action that is
always right.

## Play

| | |
|---|---|
| **Browser (humans)** | open the public URL, create a match or join with a 5-character code. No install, no login. |
| **Agents** | HTTP/JSON — create a match, poll `/state`, submit `/move`. See below. |
| **Bots** | any empty seat can be filled by a bot, so you can always start a game. |

Public game URL: **`<<GAME_URL>>`**
API docs: `<<GAME_URL>>/docs` (human) and `<<GAME_URL>>/api/docs` (JSON).

## Run it locally

Requires **Node.js ≥ 18**. No dependencies, no build step.

```bash
node server.js          # serves http://127.0.0.1:8080
node server.js 3000     # custom port
node test.js            # run the engine test suite (15 tests)
```

Layout:

```
engine.js   pure game rules (no I/O) — the single source of truth
server.js   dependency-free HTTP server: static UI + JSON API + bot/timeout driver
bot.js      the sample bot (also a standalone HTTP agent)
public/     browser UI (index.html) and API docs (docs.html)
test.js     engine tests
```

## Play as an agent

Every response is `{"ok":true,"data":…}` or `{"ok":false,"error":"…"}`. Each seat gets a
**token**; pass it as `?token=` on reads or `"token"` in writes.

```bash
HOST=https://your-host

# 1. create a 2-seat match (you become seat 0 / host)
curl -s -XPOST $HOST/api/matches -H 'content-type: application/json' \
     -d '{"seats":2,"name":"MyAgent"}'
# -> {"ok":true,"data":{"id":"...","code":"7KQ2M","seat":0,"token":"..."}}

# 2. start it — empty seats are auto-filled with bots
curl -s -XPOST $HOST/api/matches/$ID/start -H 'content-type: application/json' \
     -d '{"token":"'$TOKEN'"}'

# 3. loop: read state (+ your legal moves) and submit a move on your turn
curl -s "$HOST/api/matches/$ID/state?token=$TOKEN"
curl -s -XPOST $HOST/api/matches/$ID/move -H 'content-type: application/json' \
     -d '{"token":"'$TOKEN'","action":{"type":"grow","to":[1,1]}}'
```

### Endpoints

| Method | Path | Body / query | Returns |
|---|---|---|---|
| POST | `/api/matches` | `{"seats":2-4,"name":?}` | `{id, code, seat, token}` |
| GET | `/api/matches` | — | recent matches |
| GET | `/api/matches/:id` | `?token=` optional | public state |
| GET | `/api/matches/:id/state` | `?token=` | state + **your** `legalActions` |
| GET | `/api/matches/:id/legal` | `?token=` | `{seat, actions}` |
| GET | `/api/matches/:id/replay` | — | full move log + final standings |
| POST | `/api/matches/:id/join` | `{"name":?}` | `{seat, token}` |
| POST | `/api/matches/:id/bot` | `{"seat":?}` | `{seat}` |
| POST | `/api/matches/:id/start` | `{"token"}` | state (fills empty seats with bots) |
| POST | `/api/matches/:id/move` | `{"token","action"}` | state |

`:id` accepts the match id **or** the 5-character match code. `GET /api/docs` returns the
whole description as JSON.

### Actions

| type | cost | fields | meaning |
|---|---|---|---|
| `grow` | 4 | `to:[row,col]` | claim an empty tile adjacent to your territory |
| `strike` | 2 | `to:[row,col]` | raze an adjacent enemy tile back to neutral (deny it) |
| `fortify` | 1 | `at:[row,col]` | shield one of your tiles for one round |
| `mine` | 0 | — | gain 3 energy |

State shape (abridged):

```json
{
  "id": "…", "code": "7KQ2M", "phase": "active",
  "round": 3, "maxRounds": 20, "turn": 0, "turnDeadline": 1699999999999,
  "players": [{"seat":0,"name":"MyAgent","type":"human","energy":7,"tiles":4,"isTurn":true}],
  "board": [[{"owner":null,"crystal":true,"fortified":false}, "…"], "…"],
  "yourSeat": 0,
  "legalActions": [{"type":"grow","to":[1,1]}, {"type":"mine"}],
  "log": [{"round":1,"kind":"action","seat":0,"action":"grow","detail":"grew to 1,1"}]
}
```

Use `legalActions` and you never have to guess: it is empty unless it is your turn, and it
only contains actions you can currently afford. Invalid moves are rejected with a reason
(`not_your_turn`, `not_adjacent`, `tile_fortified`, `not_enough_energy`, …).

## The sample bot

`bot.js` is a small, readable heuristic agent — it scores every legal action (crystals are
worth a lot, mining when broke, striking the leader) and plays the best one. It is exported
so the server can use it to fill seats, and it can also run as a standalone HTTP agent:

```bash
# join an existing match and play until it ends
node bot.js --server https://your-host --join 7KQ2M --name Robo

# create a 4-seat match, play it out against itself
node bot.js --server https://your-host --create 4
```

## Notes

* Turn clock: 15 s. If a player does not move in time the turn is auto-resolved as `mine`,
  so one idle client cannot stall a match. There is also a hard 9-minute cap per match.
* Matches are held in memory; restarting the server clears them. The UI keeps your seat
  (match + token) in `localStorage`, so a refresh drops you back into your game.
* Everything is dependency-free and runs on a single Node process.

## License

MIT — see `LICENSE`.
