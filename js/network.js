/**
 * network.js — server communication layer
 *
 * Responsibilities:
 *   - Poll api/state.php every 100 ms, notify subscribers
 *   - Send player input to api/input.php every 50 ms
 *   - join(), leave(), sendChat() wrappers
 */

const POLL_INTERVAL  = 100;   // ms
const INPUT_INTERVAL = 50;    // ms

let _stateCallbacks  = [];
let _playerId        = null;
let _pollTimer       = null;
let _inputTimer      = null;
let _pendingInput    = null;   // latest input snapshot to send

/** Subscribe to state updates. Callback receives the full state object. */
export function onState(cb) {
    _stateCallbacks.push(cb);
}

/** Join the arena. Returns { ok, playerId, state } */
export async function join(handle) {
    const res = await fetch('api/join.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle }),
    });
    const data = await res.json();
    if (data.ok) {
        _playerId = data.playerId;
        _startPolling();
    }
    return data;
}

/** Leave the arena. */
export async function leave() {
    if (!_playerId) return;
    _stopPolling();
    await fetch('api/leave.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: _playerId }),
    }).catch(() => {});
    _playerId = null;
}

/** Queue input to be sent on the next input flush.
 *  Position/rotation take the latest value; actions are accumulated
 *  so a beam/fire action queued on frame N isn't wiped by frame N+1. */
export function queueInput(position, rotation, actions = []) {
    if (!_playerId) return;
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

/** Send chat message. */
export async function sendChat(message) {
    if (!_playerId) return;
    await fetch('api/chat.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: _playerId, message }),
    }).catch(() => {});
}

export function getPlayerId() { return _playerId; }

// ------------------------------------------------------------------
// Internal polling
// ------------------------------------------------------------------

function _startPolling() {
    _pollTimer  = setInterval(_poll,       POLL_INTERVAL);
    _inputTimer = setInterval(_flushInput, INPUT_INTERVAL);
}

function _stopPolling() {
    clearInterval(_pollTimer);
    clearInterval(_inputTimer);
    _pollTimer  = null;
    _inputTimer = null;
}

async function _poll() {
    try {
        const res   = await fetch('api/state.php', { cache: 'no-store' });
        const state = await res.json();
        for (const cb of _stateCallbacks) cb(state);
    } catch (e) {
        // Network blip — ignore, will retry
    }
}

async function _flushInput() {
    if (!_pendingInput) return;
    const payload   = _pendingInput;
    _pendingInput   = null;
    try {
        await fetch('api/input.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    } catch (e) { /* ignore */ }
}
