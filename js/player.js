/**
 * player.js — local player state + client-side movement prediction
 *
 * applyInput() advances the player's position using instant movement (no momentum).
 * reconcile() snaps or blends the position to match the server's authoritative state.
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.162.0/build/three.module.js';

export const MOVE_SPEED        = 100;   // units per second
export const SNAP_THRESHOLD    = 300;   // units — only used for forced teleport (respawn)
export const BLEND_SPEED       = 8;     // lerp speed for small corrections (unused — client-auth)

export class LocalPlayer {
    constructor() {
        this.position  = new THREE.Vector3();
        this.rotation  = new THREE.Quaternion();

        this.health    = 200;
        this.maxHealth = 200;
        this.weapon    = 'pulse';
        this.ammo      = -1;
        this.canFireAt = 0;
        this.score     = 0;
        this.kills     = 0;
        this.deaths    = 0;
        this.timeInGame = 0;
        this.isDead    = false;
        this.respawnAt = null;

        this._euler    = new THREE.Euler(0, 0, 0, 'YXZ');
        this._forward  = new THREE.Vector3();
        this._right    = new THREE.Vector3();
        this._up       = new THREE.Vector3();
    }

    /**
     * Apply a frame of movement based on keyboard input.
     * @param {THREE.Vector3} moveLocal  — normalised local-space movement intent
     * @param {number} yaw   — accumulated yaw in radians
     * @param {number} pitch — accumulated pitch in radians
     * @param {number} roll  — current roll (auto-levelled)
     * @param {number} dt    — delta time in seconds
     */
    applyInput(moveLocal, yaw, pitch, roll, dt) {
        // Build rotation from Euler(pitch, yaw, roll) in YXZ order
        this._euler.set(pitch, yaw, roll, 'YXZ');
        this.rotation.setFromEuler(this._euler);

        if (moveLocal.lengthSq() < 0.001) return;

        // Rotate local movement vector into world space
        const worldMove = moveLocal.clone().applyQuaternion(this.rotation);
        this.position.addScaledVector(worldMove, MOVE_SPEED * dt);

        // Clamp to arena (will be corrected server-side too, just for client feel)
        const half = 490;   // 1000/2 - 10 margin
        this.position.clampScalar(-half, half);
    }

    /**
     * Sync game-state metadata from a server snapshot.
     * Position is intentionally NOT touched here — movement is client-authoritative.
     * The server echoes whatever position we last sent, so reconciling against it
     * just snaps the player back to where they were 50-150 ms ago.
     * Respawn position sync is done explicitly in game.js.
     * @param {object} serverPlayer  — player record from server state
     */
    reconcile(serverPlayer) {
        // Sync game state fields only — no position correction
        this.health     = serverPlayer.health;
        this.maxHealth  = serverPlayer.maxHealth;
        this.weapon     = serverPlayer.weapon;
        this.ammo       = serverPlayer.ammo;
        this.score      = serverPlayer.score;
        this.kills      = serverPlayer.kills;
        this.deaths     = serverPlayer.deaths;
        this.timeInGame = serverPlayer.timeInGame;
        this.isDead     = serverPlayer.isDead;
        this.respawnAt  = serverPlayer.respawnAt;
    }

    /** Direction the player is facing (world space). */
    getForward() {
        return new THREE.Vector3(0, 0, -1).applyQuaternion(this.rotation);
    }

    toJSON() {
        return {
            x: this.position.x,
            y: this.position.y,
            z: this.position.z,
        };
    }

    rotationJSON() {
        return {
            x: this.rotation.x,
            y: this.rotation.y,
            z: this.rotation.z,
            w: this.rotation.w,
        };
    }
}
