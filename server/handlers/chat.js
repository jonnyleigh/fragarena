import { GameState } from '../lib/GameState.js';

/**
 * handlers/chat.js — port of api/chat.php
 *
 * Message: { type: 'chat', playerId: string, message: string }
 *
 * Appends a chat message (from a human player) to the shared state,
 * then broadcasts the updated chat log to all connected clients.
 *
 * Responds to sender: { type: 'chat', ok: true }
 *                  or { type: 'error', ... }
 */
export function handleChat(ws, msg, state, clients) {
    const playerId = msg.playerId ?? '';

    // Port of: $message = trim($body['message'] ?? '')
    let message = String(msg.message ?? '').trim();

    if (!playerId || message === '') {
        ws.send(JSON.stringify({ type: 'error', code: 400, message: 'playerId and message required' }));
        return;
    }

    // Rate-limit: message must be ≤200 chars
    // Port of: mb_strlen / mb_substr — JS strings are UTF-16; slice() is close enough
    // for the 200-char cap. NOTE: mb_substr counts Unicode code points; JS slice()
    // counts UTF-16 code units. For the vast majority of chat text this is identical.
    if (message.length > 200) {
        message = message.slice(0, 200);
    }

    const idx = GameState.findPlayerIndex(state, playerId);
    if (idx < 0) {
        ws.send(JSON.stringify({ type: 'error', code: 404, message: 'Player not found' }));
        return;
    }

    const handle = state.players[idx].handle;
    GameState.addChat(state, handle, message);

    // Acknowledge to sender
    ws.send(JSON.stringify({ type: 'chat', ok: true }));

    // Broadcast updated chat log to all clients (including sender, so their
    // UI updates consistently even if they echoed the message optimistically)
    const payload = JSON.stringify({ type: 'chat', chat: state.chat });
    for (const [clientWs] of clients) {
        if (clientWs.readyState === clientWs.OPEN) {
            clientWs.send(payload);
        }
    }
}
