import { GameState } from '../lib/GameState.js';
import { GameTick }  from '../lib/GameTick.js';

/**
 * handlers/state.js — port of api/state.php
 *
 * NOTE: This handler is NOT used in the WebSocket architecture.
 * State is pushed to all clients every tick by the setInterval loop in server.js.
 *
 * This file is retained as an HTTP fallback / compatibility shim only,
 * as specified in the migration prompt (Phase 2 Step 3 target structure).
 *
 * If you add an HTTP server alongside the WebSocket server, you can call
 * handleStateHttp(req, res, state) to serve a one-shot state response
 * and optionally run a tick — replicating the PHP hot-path exactly.
 *
 * Port of api/state.php:
 *   - Fast path: return state without ticking if tick is not yet due
 *   - Slow path: run tick then return state
 * The flock() exclusive/shared lock logic is removed; in a single-threaded
 * Node process there is no concurrent access risk.
 */
export function handleStateHttp(req, res, state) {
    const now  = Date.now() / 1000;
    const prev = parseFloat(state.lastTick ?? 0.0);

    // Fast path — tick not yet due
    if (now - prev < GameTick.TICK_INTERVAL) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state));
        return;
    }

    // Tick is due — run it
    // NOTE: PHP re-read the file with an exclusive lock and re-checked the
    // condition. In Node there is no concurrent writer via this path, so we
    // skip the double-check.
    GameTick.runTick(state, now);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state));
}

/**
 * WebSocket variant: send the current state snapshot to a single client.
 * Optionally runs a tick first if one is due.
 * Not called by server.js (the loop handles this), but available for testing.
 */
export function handleStateWs(ws, state) {
    const now  = Date.now() / 1000;
    const prev = parseFloat(state.lastTick ?? 0.0);

    if (now - prev >= GameTick.TICK_INTERVAL) {
        GameTick.runTick(state, now);
    }

    ws.send(JSON.stringify({ type: 'state', data: state }));
}
