/**
 * network.js — server communication layer
 *
 * Phase 4: HTTP polling replaced with a persistent WebSocket connection.
 *
 * Public API is unchanged — game.js calls the same exported functions:
 *   onState(cb)                      subscribe to state updates
 *   join(handle)                     connect + join → Promise<{ ok, playerId, state }>
 *   leave()                          send leave + close socket
 *   queueInput(position, rotation, actions)   queue movement/action input
 *   sendChat(message)                send a chat message
 *   getPlayerId()                    return current player id
 *
 * Removed:
 *   - setInterval polling of api/state.php
 *   - fetch() calls to api/input.php, api/join.php, api/leave.php, api/chat.php
 *
 * Added:
 *   - WebSocket connection to ws://…:8080
 *   - Input flushed at 25 Hz over the socket
 *   - Exponential-backoff reconnection (1 s → 2 s → 4 s → … → 30 s max)
 *   - On reconnect: automatically re-joins with the same handle
 */

// Derive WebSocket URL from the page origin, defaulting port to 8080.
// e.g. http://localhost → ws://localhost:8080
const _WS_URL = (() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host  = location.hostname;
    const port  = 8080;
    return `${proto}//${host}:${port}`;
})();

const INPUT_INTERVAL = 40;   // ms — send input at 25 Hz (matches old _flushInput rate)

// Reconnection backoff: 1 s, 2 s, 4 s, 8 s, 16 s, 30 s (capped)
const _RECONNECT_BASE_MS  = 1000;
const _RECONNECT_MAX_MS   = 30000;

// ------------------------------------------------------------------
// Module state
// ------------------------------------------------------------------
let _stateCallbacks  = [];
let _playerId        = null;
let _handle          = null;   // stored so we can re-join on reconnect

let _ws              = null;
let _wsReady         = false;  // true when socket is OPEN and join was acked

let _reconnectDelay  = _RECONNECT_BASE_MS;
let _reconnectTimer  = null;
let _intentionalClose = false; // true when leave() closes the socket on purpose

let _pendingInput    = null;   // latest input snapshot to send
let _inputTimer      = null;

// Promise plumbing for the join() async API:
let _joinResolve     = null;
let _joinReject      = null;

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/** Subscribe to state updates. Callback receives the full state object. */
export function onState(cb) {
    _stateCallbacks.push(cb);
}

/**
 * Connect to the WebSocket server and join the arena.
 * Returns a Promise that resolves to { ok, playerId, state } on success,
 * or { ok: false, reason } on failure — identical shape to the old fetch() return.
 */
export function join(handle) {
    _handle          = handle;
    _intentionalClose = false;

    return new Promise((resolve, reject) => {
        _joinResolve = resolve;
        _joinReject  = reject;
        _connect();
    });
}

/** Leave the arena and close the WebSocket. */
export async function leave() {
    if (!_playerId) return;
    _intentionalClose = true;

    _stopInput();
    _cancelReconnect();

    if (_ws && _ws.readyState === WebSocket.OPEN) {
        _ws.send(JSON.stringify({ type: 'leave' }));
        _ws.close();
    }

    _playerId = null;
    _handle   = null;
    _wsReady  = false;
    _ws       = null;
}

/**
 * Queue input to be sent on the next input flush.
 * Position/rotation take the latest value; actions are accumulated
 * so a beam/fire action queued on frame N isn't wiped by frame N+1.
 * Interface unchanged from the HTTP polling version.
 */
export function queueInput(position, rotation, actions = []) {
    if (!_playerId || !_wsReady) return;
    if (_pendingInput) {
        // Keep latest position/rotation but accumulate actions
        _pendingInput.position = position;
        _pendingInput.rotation = rotation;
        if (actions.length) {
            _pendingInput.actions.push(...actions);
        }
    } else {
        _pendingInput = { playerId: _playerId, position, rotation, actions: [...actions] };
    }
}

/** Send a chat message over the WebSocket. */
export function sendChat(message) {
    if (!_playerId || !_wsReady) return;
    _wsSend({ type: 'chat', playerId: _playerId, message });
}

export function getPlayerId() { return _playerId; }

// ------------------------------------------------------------------
// WebSocket lifecycle
// ------------------------------------------------------------------

function _connect() {
    if (_ws) {
        // Tear down any existing socket before opening a new one
        _ws.onopen = _ws.onmessage = _ws.onerror = _ws.onclose = null;
        _ws.close();
        _ws = null;
    }

    _wsReady = false;

    try {
        _ws = new WebSocket(_WS_URL);
    } catch (e) {
        _scheduleReconnect();
        return;
    }

    _ws.onopen = _onOpen;
    _ws.onmessage = _onMessage;
    _ws.onerror = _onError;
    _ws.onclose = _onClose;
}

function _onOpen() {
    // Reset backoff on successful connection
    _reconnectDelay = _RECONNECT_BASE_MS;

    // Send join message — server will respond with { type:'join', ok, playerId, state }
    _wsSend({ type: 'join', handle: _handle });
}

function _onMessage(event) {
    let msg;
    try {
        msg = JSON.parse(event.data);
    } catch {
        return;
    }

    switch (msg.type) {
        case 'join':
            _handleJoinAck(msg);
            break;

        case 'state':
            // Server pushes full state every tick. msg.data matches the
            // shape previously returned by api/state.php JSON, so downstream
            // code in game.js is unchanged.
            if (_wsReady) {
                for (const cb of _stateCallbacks) cb(msg.data);
            }
            break;

        case 'chat':
            // Immediate chat broadcast (sent by server on join/leave/chat events
            // ahead of the next tick). Update state.chat in any cached state if
            // needed — game.js reads chat from the state snapshot so this is
            // informational only. No-op here; the next 'state' push will include it.
            break;

        case 'reset':
            // Server was reset — treat as a disconnect + reconnect
            _playerId = null;
            _wsReady  = false;
            if (_handle) {
                // Re-join with same handle to get a fresh state
                _wsSend({ type: 'join', handle: _handle });
            }
            break;

        case 'error':
            // Pass errors up as a synthetic state-callback argument with an
            // _error sentinel, or simply log. game.js can check for msg._error.
            console.warn('[network] Server error:', msg.code, msg.message);
            // If we got an error during the join handshake, reject the promise
            if (_joinReject && !_wsReady) {
                const reject = _joinReject;
                _joinResolve = null;
                _joinReject  = null;
                reject(new Error(msg.message));
            }
            break;
    }
}

function _handleJoinAck(msg) {
    if (!msg.ok) {
        // Join refused (game full, bad handle etc.)
        _wsReady = false;
        if (_joinResolve) {
            const resolve = _joinResolve;
            _joinResolve = null;
            _joinReject  = null;
            resolve({ ok: false, reason: msg.reason });
        }
        return;
    }

    _playerId = msg.playerId;
    _wsReady  = true;

    // Start the input flush loop now that we are connected and joined
    _startInput();

    // Resolve the join() Promise — same shape as the old fetch() response
    if (_joinResolve) {
        const resolve = _joinResolve;
        _joinResolve  = null;
        _joinReject   = null;
        resolve({ ok: true, playerId: msg.playerId, state: msg.state });
    }

    // Deliver the initial state to any subscribers immediately
    if (msg.state) {
        for (const cb of _stateCallbacks) cb(msg.state);
    }
}

function _onError(/* event */) {
    // onclose fires immediately after onerror — handle reconnect there
}

function _onClose() {
    _wsReady = false;
    _stopInput();

    if (_intentionalClose) return;

    // Unexpected disconnect — schedule reconnect with exponential backoff
    _scheduleReconnect();
}

// ------------------------------------------------------------------
// Reconnection
// ------------------------------------------------------------------

function _scheduleReconnect() {
    _cancelReconnect();
    _reconnectTimer = setTimeout(() => {
        _reconnectTimer = null;
        // If we had a playerId when we dropped, reconnect and re-join
        if (_handle) {
            _connect();
        }
    }, _reconnectDelay);

    // Exponential backoff: 1 s → 2 s → 4 s → … → 30 s
    _reconnectDelay = Math.min(_reconnectDelay * 2, _RECONNECT_MAX_MS);
}

function _cancelReconnect() {
    if (_reconnectTimer !== null) {
        clearTimeout(_reconnectTimer);
        _reconnectTimer = null;
    }
}

// ------------------------------------------------------------------
// Input flushing (25 Hz) — same rate as the old HTTP polling version
// ------------------------------------------------------------------

function _startInput() {
    _stopInput();
    _inputTimer = setInterval(_flushInput, INPUT_INTERVAL);
}

function _stopInput() {
    if (_inputTimer !== null) {
        clearInterval(_inputTimer);
        _inputTimer   = null;
    }
    _pendingInput = null;
}

function _flushInput() {
    if (!_pendingInput || !_wsReady) return;

    const payload = _pendingInput;
    _pendingInput = null;

    _wsSend({ type: 'input', ...payload });
}

// ------------------------------------------------------------------
// Utility
// ------------------------------------------------------------------

function _wsSend(obj) {
    if (_ws && _ws.readyState === WebSocket.OPEN) {
        _ws.send(JSON.stringify(obj));
    }
}
