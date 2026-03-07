import { WebSocketServer }        from 'ws';
import { createServer }           from 'http';
import { readFile, readdir }       from 'fs/promises';
import { extname, join, resolve } from 'path';
import { fileURLToPath }          from 'url';
import { GameState }              from './lib/GameState.js';
import { GameTick }               from './lib/GameTick.js';
import { handleJoin }             from './handlers/join.js';
import { handleInput }            from './handlers/input.js';
import { handleLeave }            from './handlers/leave.js';
import { handleChat }             from './handlers/chat.js';
import { handleReset }            from './handlers/reset.js';

const TICK_RATE_HZ = 20;
const TICK_MS      = 1000 / TICK_RATE_HZ; // 50 ms
const PORT         = process.env.PORT ? parseInt(process.env.PORT) : 8080;

// Project root is one directory above server/
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const WEB_ROOT  = resolve(__dirname, '..');

const MIME_TYPES = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.gif':  'image/gif',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.woff': 'font/woff',
    '.woff2':'font/woff2',
};

// ------------------------------------------------------------------
// HTTP static file server — serves the project root (index.html, js/, etc.)
// ------------------------------------------------------------------
const httpServer = createServer(async (req, res) => {
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/index.html';

    // Dynamic music manifest — replaces music/manifest.php
    if (urlPath === '/music/manifest.php') {
        try {
            const musicDir = join(WEB_ROOT, 'music');
            const files    = await readdir(musicDir);
            const tracks   = files.filter(f => f.toLowerCase().endsWith('.mp3'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ tracks }));
        } catch {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ tracks: [] }));
        }
        return;
    }

    const filePath = join(WEB_ROOT, urlPath);

    // Security: ensure the resolved path stays inside WEB_ROOT
    if (!filePath.startsWith(WEB_ROOT)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    try {
        const data = await readFile(filePath);
        const mime = MIME_TYPES[extname(filePath)] ?? 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
    } catch {
        res.writeHead(404);
        res.end('Not found');
    }
});

// Single in-memory state instance — replaces data/game_state.json
const gameState = new GameState();

// Map of WebSocket → { playerId, handle }
// Used by handlers instead of PHP session/cookie logic
const clients = new Map();

// ------------------------------------------------------------------
// WebSocket server — attached to the same HTTP server so both run on
// the same port. Browser loads http://localhost:8080 and connects to
// ws://localhost:8080 simultaneously.
// ------------------------------------------------------------------
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            ws.send(JSON.stringify({ type: 'error', code: 400, message: 'Invalid JSON' }));
            return;
        }

        const state = gameState.getState();

        switch (msg.type) {
            case 'join':  handleJoin(ws, msg, state, clients);  break;
            case 'input': handleInput(ws, msg, state, clients); break;
            case 'chat':  handleChat(ws, msg, state, clients);  break;
            case 'leave': handleLeave(ws, state, clients);      break;
            case 'reset': handleReset(ws, state, clients);      break;
            default:
                ws.send(JSON.stringify({ type: 'error', code: 400, message: `Unknown message type: ${msg.type}` }));
        }
    });

    ws.on('close', () => {
        handleLeave(ws, gameState.getState(), clients);
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
        handleLeave(ws, gameState.getState(), clients);
    });
});

// ------------------------------------------------------------------
// Server-side game loop — runs continuously regardless of client activity.
// Replaces the tick-on-demand logic in api/state.php.
// Bots advance, missiles fly, and pickups spawn even with zero connected players.
// ------------------------------------------------------------------
setInterval(() => {
    const state   = gameState.getState();
    const now     = Date.now() / 1000;

    GameTick.runTick(state, now);

    const snapshot = gameState.getSnapshot();
    const payload  = JSON.stringify({ type: 'state', data: snapshot });

    for (const [ws] of clients) {
        if (ws.readyState === ws.OPEN) {
            ws.send(payload);
        }
    }
}, TICK_MS);

// ------------------------------------------------------------------
// Start listening — HTTP and WebSocket on the same port
// ------------------------------------------------------------------
httpServer.listen(PORT, () => {
    console.log(`FragArena server listening on http://localhost:${PORT}`);
    console.log(`WebSocket endpoint:      ws://localhost:${PORT}`);
});
