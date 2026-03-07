import { GameState } from '../lib/GameState.js';

/**
 * handlers/join.js — port of api/join.php
 *
 * Message: { type: 'join', handle: string }
 *
 * Validates the arena has room, kicks the oldest bot if at capacity,
 * creates a human player record.
 *
 * Responds to sender: { type: 'join', ok: true, playerId, state }
 *                  or { type: 'join', ok: false, reason }
 *
 * Also broadcasts a System chat message to all connected clients.
 */
export function handleJoin(ws, msg, state, clients) {
    // Port of: $handle = trim($body['handle'] ?? '')
    const handle = String(msg.handle ?? '').trim();

    if (handle === '') {
        ws.send(JSON.stringify({ type: 'join', ok: false, reason: 'Handle is required.' }));
        return;
    }

    const humanCount = GameState.countHumans(state);

    if (humanCount >= GameState.MAX_PLAYERS) {
        ws.send(JSON.stringify({ type: 'join', ok: false, reason: 'Game is full. Try again later.' }));
        return;
    }

    // Kick the oldest bot to make room if arena is at capacity
    if (state.players.length >= GameState.MAX_PLAYERS) {
        const bi = GameState.findOldestBot(state);
        if (bi >= 0) {
            const kickedName = state.players[bi].handle;
            // NOTE: array_splice($state['players'], $bi, 1) → state.players.splice(bi, 1)
            state.players.splice(bi, 1);
            GameState.addChat(state, 'System', `${kickedName} (bot) was kicked to make room.`);
        }
    }

    // Create and insert the human player
    const player = GameState.makeHumanPlayer(handle);
    player.position = GameState.randomFreePosition(state);
    state.players.push(player);

    GameState.addChat(state, 'System', `${player.handle} joined the arena.`);

    // Track this WebSocket in the clients map
    clients.set(ws, { playerId: player.id, handle: player.handle });

    // Respond to the joining client with their id and full state snapshot
    ws.send(JSON.stringify({
        type:     'join',
        ok:       true,
        playerId: player.id,
        state,
    }));

    // Broadcast the chat update to all *other* connected clients so they see the join message.
    // (Full state is broadcast every tick — this is just the immediate chat notification.)
    _broadcast(clients, ws, JSON.stringify({ type: 'chat', chat: state.chat }));
}

// ------------------------------------------------------------------
// Internal: broadcast to all clients except optionally one exclusion
// ------------------------------------------------------------------
function _broadcast(clients, exclude, payload) {
    for (const [clientWs] of clients) {
        if (clientWs === exclude) continue;
        if (clientWs.readyState === clientWs.OPEN) {
            clientWs.send(payload);
        }
    }
}
