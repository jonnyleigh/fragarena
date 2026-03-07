import { GameState } from '../lib/GameState.js';

/**
 * handlers/reset.js — port of api/reset.php
 *
 * Message: { type: 'reset' }
 *
 * Debug endpoint: resets the in-memory state to a fresh arena.
 * Should be disabled or access-controlled in production.
 *
 * Port notes:
 *   PHP deleted the state file and relied on the next request to call freshState().
 *   In the Node WebSocket server there is no file — we replace the live state
 *   object's contents in-place so that all handler references remain valid.
 *
 * Broadcasts { type: 'reset' } to all clients so they can re-initialise their
 * local state (replaces the "next request regenerates state" PHP behaviour).
 */
export function handleReset(ws, state, clients) {
    // Build a fresh state
    const fresh = GameState.freshState();

    // Replace every key on the existing state object in-place.
    // We cannot reassign the reference (handlers/server.js hold it),
    // so we clear + copy — equivalent to the PHP file-wipe + reload pattern.
    for (const key of Object.keys(state)) {
        delete state[key];
    }
    Object.assign(state, fresh);

    // Acknowledge to sender
    ws.send(JSON.stringify({
        type:    'reset',
        ok:      true,
        message: 'State reset. Fresh arena generated.',
    }));

    // Broadcast reset event to all connected clients so they can reload their view
    const payload = JSON.stringify({ type: 'reset' });
    for (const [clientWs] of clients) {
        if (clientWs === ws) continue; // sender already got the ack above
        if (clientWs.readyState === clientWs.OPEN) {
            clientWs.send(payload);
        }
    }
}
