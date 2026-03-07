/**
 * input.js — keyboard + mouse input capture
 *
 * Mouse captured via Pointer Lock API → pitch + yaw.
 * Roll auto-levels to 0 over ~1 s (exponential decay).
 * WSAD + Space/Shift → movement intent.
 * T → chat, Esc → quit.
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.162.0/build/three.module.js';

const MOUSE_SENSITIVITY = 0.0015;   // rad per pixel
const ROLL_DECAY        = 3.0;       // higher = faster auto-level

// Euler angles (world accumulation, then rebuilt to quaternion each frame)
let _yaw   = 0;
let _pitch = 0;
let _roll  = 0;

// Current movement intent (each component -1..0..1)
const _keys = {};
let _chatMode  = false;

// Queued mouse delta for this frame
let _mouseDX = 0;
let _mouseDY = 0;

// Callbacks
let _onChatOpen  = null;
let _onQuit      = null;

// Whether pointer lock is active
let _locked = false;

/** Call once to attach all listeners. */
export function init(canvas, { onChatOpen, onQuit }) {
    _onChatOpen = onChatOpen;
    _onQuit     = onQuit;

    canvas.addEventListener('click', () => {
        if (!_chatMode) canvas.requestPointerLock();
    });

    document.addEventListener('pointerlockchange', () => {
        _locked = document.pointerLockElement === canvas;
    });

    document.addEventListener('mousemove', (e) => {
        if (!_locked || _chatMode) return;
        _mouseDX += e.movementX;
        _mouseDY += e.movementY;
    });

    document.addEventListener('keydown', (e) => {
        if (_chatMode) return;
        _keys[e.code] = true;

        if (e.code === 'KeyT') {
            e.preventDefault();
            _chatMode = true;
            _onChatOpen?.();
        }
        if (e.code === 'Escape') {
            _onQuit?.();
        }
    });

    document.addEventListener('keyup', (e) => {
        _keys[e.code] = false;
    });

    document.addEventListener('mousedown', (e) => {
        if (!_locked || _chatMode) return;
        if (e.button === 0) _keys['MouseLeft'] = true;
    });
    document.addEventListener('mouseup', (e) => {
        if (e.button === 0) _keys['MouseLeft'] = false;
    });
}

/** Called each frame — returns current input state and resets mouse delta. */
export function getFrameInput(dt) {
    // Apply mouse look
    _yaw   -= _mouseDX * MOUSE_SENSITIVITY;
    _pitch -= _mouseDY * MOUSE_SENSITIVITY;
    _pitch  = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, _pitch));
    _mouseDX = 0;
    _mouseDY = 0;

    // Auto-level roll
    _roll *= Math.exp(-ROLL_DECAY * dt);
    if (Math.abs(_roll) < 0.0001) _roll = 0;

    // Build local-space movement vector (before rotation applied in player.js)
    const move = new THREE.Vector3(
        (_keys['KeyD'] ? 1 : 0) - (_keys['KeyA'] ? 1 : 0),
        (_keys['Space'] ? 1 : 0) - (_keys['ShiftLeft'] || _keys['ShiftRight'] ? 1 : 0),
        (_keys['KeyS'] ? 1 : 0) - (_keys['KeyW'] ? 1 : 0)   // forward = -Z in Three.js
    );
    if (move.lengthSq() > 0) move.normalize();

    return {
        moveLocal: move,
        yaw:   _yaw,
        pitch: _pitch,
        roll:  _roll,
        firing: !_chatMode && (_keys['Space'] === true ? false : !!_keys['MouseLeft']),
    };
}

/** Set initial angles (e.g. after respawn). */
export function setAngles(yaw, pitch) {
    _yaw   = yaw;
    _pitch = pitch;
    _roll  = 0;
}

export function exitChatMode() { _chatMode = false; }
export function isChatMode()   { return _chatMode; }
