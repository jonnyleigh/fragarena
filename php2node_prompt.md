# FragArena: PHP → Node.js WebSocket Migration Prompt for GitHub Copilot

Use this prompt as the starting context when opening a Copilot Chat session. Feed it the relevant source files as you work through each phase.

---

## Context

You are helping migrate **FragArena**, a browser-based multiplayer 3D space shooter, from a PHP HTTP polling architecture to a Node.js WebSocket architecture.

**Current stack:**
- Frontend: Vanilla JS + ES modules (Three.js), in `js/`
- Backend: PHP 8, in `api/` and `lib/`
- State: `data/game_state.json` with `flock()` locking
- Transport: HTTP polling — clients call `GET /api/state.php` and `POST /api/input.php` repeatedly

**Target stack:**
- Frontend: Same JS — only `js/network.js` changes
- Backend: Node.js with the `ws` WebSocket library
- State: In-memory JS object (no file I/O on hot path)
- Transport: WebSocket — server pushes state to all clients at a fixed tick rate (20Hz)

**Guiding principle: faithful translation, not refactoring.** Do not simplify, optimise, or restructure logic unless explicitly asked. Translate behaviour exactly. If a PHP construct has no direct JS equivalent, add a comment explaining the difference.

---

## Target File Structure

Produce the following layout in a new `server/` directory at the project root:

```
server/
  server.js              ← Entry point: WebSocket server + game loop
  lib/
    GameState.js         ← Port of lib/GameState.php
    GameTick.js          ← Port of lib/GameTick.php
    BotAI.js             ← Port of lib/BotAI.php
    Weapons.js           ← Port of lib/Weapons.php
  handlers/
    join.js              ← Port of api/join.php
    leave.js             ← Port of api/leave.php
    input.js             ← Port of api/input.php
    state.js             ← Port of api/state.php (now unused for polling — kept for HTTP fallback)
    chat.js              ← Port of api/chat.php
    reset.js             ← Port of api/reset.php
  package.json
```

Update the existing `js/network.js` in place — do not move it.

---

## Phase 1 — Analyse Before Writing

Before writing any code, read each file I provide and produce a written summary of:

1. What data structures it defines or depends on
2. What mutations it performs on game state
3. Any timers, random number usage, or floating-point arithmetic
4. Any PHP-specific behaviour that needs special handling in JS (e.g. `intval()`, integer division, `array_splice()`, `flock()`, `microtime()`)
5. Any magic numbers or constants (damage values, speeds, timers) — list them all

Do this for each file before writing its JS equivalent.

---

## Phase 2 — Migrate `lib/` First (dependency order)

Migrate in this order. Each file should be a JS ES module (`export default class` or `export const`).

### Step 1: `lib/GameState.php` → `server/lib/GameState.js`

- Port all properties and methods exactly
- State must be a plain JS object or class instance held in memory — no file I/O
- Remove all `json_encode` / `json_decode` / `flock` / `file_get_contents` / `file_put_contents` calls
- Replace `microtime(true)` with `Date.now() / 1000` (float seconds) or `performance.now()` — be consistent throughout
- Replace PHP array functions with JS equivalents:
  - `array_splice($arr, $i, 1)` → `arr.splice(i, 1)`
  - `array_values(array_filter(...))` → `arr.filter(...)`
  - `count($arr)` → `arr.length`
  - `array_key_exists($k, $arr)` → `k in obj` or `obj.hasOwnProperty(k)`
  - `isset($x)` → `x !== undefined && x !== null`
  - `unset($arr[$k])` → `delete obj[k]`
- After porting, list every constant/magic number found and confirm it matches the PHP source

### Step 2: `lib/Weapons.php` → `server/lib/Weapons.js`

- Port all four weapon types: Pulse Laser, Instagib Laser, Rail Gun, Missiles
- Preserve all damage values, fire intervals, and ammo counts exactly:
  - Pulse Laser: 30 damage, 400ms interval, unlimited ammo
  - Instagib Laser: 200 damage, 3000ms interval, unlimited ammo, raycast
  - Rail Gun: 15 damage, 150ms interval, unlimited ammo
  - Missiles: 60 damage, 2000ms interval, 6 ammo, homing
- Homing missile logic: port the vector math exactly. Note any use of `normalize()`, `lerp()`, or angle interpolation and confirm JS equivalents are numerically identical
- Pickup weapon expiry: preserve both duration-based and ammo-based expiry logic

### Step 3: `lib/BotAI.php` → `server/lib/BotAI.js`

- This is the highest-risk file. Port with extra care.
- Do NOT change targeting logic, movement weights, or difficulty parameters
- PHP `rand($min, $max)` → `Math.floor(Math.random() * (max - min + 1)) + min` (inclusive both ends)
- PHP `mt_rand()` → same as above
- If bots use any seeded randomness, flag it — JS `Math.random()` is not seedable without a library
- Bot replacement logic (oldest bot removed when human joins): port the exact selection criterion
- After porting, write a brief plain-English description of the bot decision loop so it can be verified against observed behaviour

### Step 4: `lib/GameTick.php` → `server/lib/GameTick.js`

- This drives the simulation step. It will be called by `setInterval` in `server.js`, not by HTTP requests
- Remove any file I/O — state is passed in as an argument
- Preserve tick timing assumptions. If PHP used wall-clock deltas, JS should too (`Date.now()`)
- Ensure projectile movement, collision detection, and pickup spawning logic is unchanged

---

## Phase 3 — Build the WebSocket Server

### `server/server.js`

Create the main server with this structure:

```js
import { WebSocketServer } from 'ws';
import { GameState } from './lib/GameState.js';
import { GameTick } from './lib/GameTick.js';
import { handleJoin } from './handlers/join.js';
import { handleInput } from './handlers/input.js';
import { handleLeave } from './handlers/leave.js';
import { handleChat } from './handlers/chat.js';
import { handleReset } from './handlers/reset.js';

const TICK_RATE_HZ = 20;
const TICK_MS = 1000 / TICK_RATE_HZ;

const state = new GameState();        // single in-memory instance
const clients = new Map();            // ws → { playerId, handle }

const wss = new WebSocketServer({ port: 8080 });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    switch (msg.type) {
      case 'join':  handleJoin(ws, msg, state, clients); break;
      case 'input': handleInput(ws, msg, state, clients); break;
      case 'chat':  handleChat(ws, msg, state, clients); break;
      case 'leave': handleLeave(ws, state, clients); break;
      case 'reset': handleReset(ws, state, clients); break;
    }
  });
  ws.on('close', () => handleLeave(ws, state, clients));
});

// Server-side game loop — runs continuously regardless of client activity
setInterval(() => {
  GameTick.tick(state);
  const snapshot = state.getSnapshot();
  const payload = JSON.stringify({ type: 'state', data: snapshot });
  for (const [ws] of clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}, TICK_MS);
```

Key requirements:
- `clients` map tracks which WebSocket belongs to which player — use this in handlers instead of session/cookie logic
- `state.getSnapshot()` should return the same JSON structure currently returned by `api/state.php` so the client needs minimal changes
- The game loop runs unconditionally — bots advance, missiles fly, and pickups spawn even with zero connected players

### `server/handlers/*.js`

Each handler receives `(ws, msg, state, clients)` and mutates state directly. No return value — responses are sent via `ws.send(JSON.stringify(...))`.

Port the logic from the corresponding PHP file exactly. Replace:
- `$_POST['field']` → `msg.field`
- `http_response_code(400)` → `ws.send(JSON.stringify({ type: 'error', code: 400, message: '...' }))`
- `echo json_encode(...)` → `ws.send(JSON.stringify(...))`
- `exit` / `die` → `return`

For actions that affect all players (e.g. a kill, a chat message), broadcast to all clients in `clients` map, not just the sender.

### `server/package.json`

```json
{
  "name": "fragarena-server",
  "type": "module",
  "dependencies": {
    "ws": "^8.0.0"
  },
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  }
}
```

---

## Phase 4 — Update the Client (`js/network.js`)

Replace HTTP polling with a WebSocket connection. The rest of `js/` is untouched.

Requirements:
- On `connect`: open `new WebSocket(url)` and send `{ type: 'join', handle: playerHandle }`
- On `message`: parse JSON and dispatch by `msg.type` — `'state'` updates the game world, `'error'` shows the HUD error, etc.
- Replace `sendInput(data)` (was `fetch('/api/input.php', ...)`) with `ws.send(JSON.stringify({ type: 'input', ...data }))`
- Replace `sendChat(text)` with `ws.send(JSON.stringify({ type: 'chat', text }))`
- Handle reconnection: if the socket closes unexpectedly, attempt to reconnect with exponential backoff (1s, 2s, 4s, max 30s)
- The polling loop (`setInterval` calling `fetch('/api/state.php')`) must be completely removed
- Preserve the same callback/event interface that `game.js` uses to receive state updates — do not change the shape of data delivered to the rest of the client

---

## Phase 5 — Verification Checklist

After completing the migration, work through this checklist and confirm each item passes:

**Correctness**
- [ ] All weapon damage values match PHP source exactly
- [ ] All weapon fire intervals match PHP source exactly
- [ ] Missile ammo count (6) is correct
- [ ] Pickup weapon expiry (duration and ammo-based) works
- [ ] Bot respawn and replacement logic behaves identically
- [ ] Player respawn delay matches PHP source
- [ ] Max players (6) is enforced correctly
- [ ] Oldest bot is removed when a human joins a full-bot lobby
- [ ] Kill scoring and K/D tracking is correct

**Networking**
- [ ] State is broadcast to all connected clients every tick
- [ ] A player disconnecting mid-game is handled gracefully (no crash, slot freed)
- [ ] A player joining while game is in progress works correctly
- [ ] Chat messages are broadcast to all players

**Performance**
- [ ] No file I/O occurs during normal gameplay (no reads/writes to game_state.json)
- [ ] The game loop continues running with zero connected players
- [ ] No memory leaks — disconnected player data is cleaned up from `clients` map and `state`

---

## Important Notes for Copilot

1. **Do not optimise.** If the PHP does something in an unusual way, port it as-is and add a comment. Optimisation is a separate task.

2. **Flag uncertainties.** If you make any assumption about PHP behaviour, or if a PHP construct has no exact JS equivalent, add a `// NOTE:` comment explaining what you did and why.

3. **Preserve all magic numbers.** Do not replace `200` with `MAX_HEALTH` or similar. Constants can be extracted later. First priority is a faithful, verifiable translation.

4. **One file at a time.** Complete and confirm each file before moving to the next. Do not generate the entire codebase at once.

5. **After each file, self-review.** Once you have produced a JS file, re-read the original PHP and the output together and explicitly state: "I believe the following behaviours are equivalent" and "I am uncertain about the following".