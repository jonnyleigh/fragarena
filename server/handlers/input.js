import { GameState } from '../lib/GameState.js';

/**
 * handlers/input.js — port of api/input.php
 *
 * Message: {
 *   type:     'input',
 *   playerId: string,
 *   position: { x, y, z },
 *   rotation: { x, y, z, w },
 *   actions:  [ { type: 'fire'|'beam'|'pickup', ... } ]
 * }
 *
 * The client sends this every ~50 ms with its latest position, rotation,
 * and any queued actions (fire, beam, pickup).
 *
 * The server accepts the player's position/rotation (client-authoritative for
 * their own movement) and queues the actions for the next game tick.
 *
 * Responds: { type: 'input', ok: true } or { type: 'error', ... }
 *
 * NOTE: In the WebSocket architecture playerId is still sent in the message
 * (matching the PHP POST body) for simplicity. An alternative would be to
 * look it up from the clients Map, which is more secure.
 */
export function handleInput(ws, msg, state, clients) {
    // Port of: $playerId = $body['playerId'] ?? ''
    const playerId = msg.playerId ?? '';

    if (!playerId) {
        ws.send(JSON.stringify({ type: 'error', code: 400, message: 'playerId required' }));
        return;
    }

    const idx = GameState.findPlayerIndex(state, playerId);
    if (idx < 0) {
        ws.send(JSON.stringify({ type: 'error', code: 404, message: 'Player not found' }));
        return;
    }

    const p          = state.players[idx];
    const arenaHalf  = state.arena.size / 2;
    const now        = Date.now() / 1000;

    // Heartbeat — used for disconnect detection in GameTick._checkDisconnects
    state.players[idx].lastInputAt = now;

    // Update position (validate it's within arena bounds)
    // Port of the isset($body['position']) block in api/input.php
    if (msg.position != null) {
        const pos = msg.position;
        state.players[idx].position = {
            x: Math.max(-arenaHalf, Math.min(arenaHalf, parseFloat(pos.x ?? 0))),
            y: Math.max(-arenaHalf, Math.min(arenaHalf, parseFloat(pos.y ?? 0))),
            z: Math.max(-arenaHalf, Math.min(arenaHalf, parseFloat(pos.z ?? 0))),
        };
    }

    // Update rotation
    if (msg.rotation != null) {
        const rot = msg.rotation;
        state.players[idx].rotation = {
            x: parseFloat(rot.x ?? 0),
            y: parseFloat(rot.y ?? 0),
            z: parseFloat(rot.z ?? 0),
            w: parseFloat(rot.w ?? 1),
        };
    }

    // Queue actions (cap at 10 per input frame to prevent abuse)
    // Port of the !empty($body['actions']) block in api/input.php
    if (Array.isArray(msg.actions) && msg.actions.length > 0) {
        const allowed = ['fire', 'beam', 'pickup'];

        // NOTE: array_slice($body['actions'], 0, 10) → msg.actions.slice(0, 10)
        for (const action of msg.actions.slice(0, 10)) {
            if (!allowed.includes(action.type ?? '')) continue;

            // Sanitise fire/beam direction — normalise server-side
            if (['fire', 'beam'].includes(action.type) && action.dir != null) {
                const d  = action.dir;
                const dx = parseFloat(d.x ?? 0);
                const dy = parseFloat(d.y ?? 0);
                const dz = parseFloat(d.z ?? 0);
                const l  = Math.sqrt(dx*dx + dy*dy + dz*dz);
                if (l < 1e-6) continue;
                action.dir = { x: dx / l, y: dy / l, z: dz / l };
            }

            state.players[idx].pendingActions.push(action);
        }
    }

    // Second heartbeat write — matches PHP's double assignment of lastInputAt
    state.players[idx].lastInputAt = now;

    ws.send(JSON.stringify({ type: 'input', ok: true }));
}
