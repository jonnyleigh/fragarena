import { GameState } from '../lib/GameState.js';

/**
 * handlers/leave.js — port of api/leave.php
 *
 * Triggered by:
 *   - Explicit message: { type: 'leave' }
 *   - WebSocket 'close' event (server.js calls this on disconnect)
 *
 * Removes the human player from the arena and spawns a bot replacement.
 * Broadcasts a System chat message to all remaining clients.
 */
export function handleLeave(ws, state, clients) {
    const clientInfo = clients.get(ws);
    if (!clientInfo) {
        // Socket was never successfully joined — nothing to clean up
        clients.delete(ws);
        return;
    }

    const { playerId } = clientInfo;
    clients.delete(ws);

    const idx = GameState.findPlayerIndex(state, playerId);
    if (idx < 0) {
        // Player already removed (e.g. disconnect timeout fired first)
        return;
    }

    const handle = state.players[idx].handle;
    // NOTE: array_splice($state['players'], $idx, 1) → state.players.splice(idx, 1)
    state.players.splice(idx, 1);

    GameState.addChat(state, 'System', `${handle} left the arena.`);

    // Spawn a bot to keep count at MAX_PLAYERS
    if (state.players.length < GameState.MAX_PLAYERS) {
        const bot = GameState.makeBotPlayer(state);
        state.players.push(bot);
        GameState.addChat(state, 'System', `${bot.handle} (bot) entered the arena.`);
    }

    // Broadcast chat update to all remaining clients
    _broadcastAll(clients, JSON.stringify({ type: 'chat', chat: state.chat }));
}

// ------------------------------------------------------------------
// Internal: broadcast to all open clients
// ------------------------------------------------------------------
function _broadcastAll(clients, payload) {
    for (const [clientWs] of clients) {
        if (clientWs.readyState === clientWs.OPEN) {
            clientWs.send(payload);
        }
    }
}
