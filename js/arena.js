/**
 * arena.js — builds and manages the 3D arena scene
 *
 * The arena is a 500-unit cube.  Six interior wall faces are rendered
 * with a procedural brick pattern via a canvas texture.
 * Shields are stone-textured box clusters.
 * Pickups are glowing, slowly-rotating meshes.
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.162.0/build/three.module.js';
import { generateShipGeometry, generateShieldMesh } from './procedural.js';
import { PICKUP_COLORS } from './weapons.js';
import { soundManager } from './sound-manager.js';

// ------------------------------------------------------------------
// Procedural brick texture
// ------------------------------------------------------------------

function makeBrickTexture(size = 512) {
    const canvas = document.createElement('canvas');
    canvas.width  = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    const brickW = 64, brickH = 32, mortar = 4;
    const brickColor  = '#8B4513';
    const mortarColor = '#696969';

    ctx.fillStyle = mortarColor;
    ctx.fillRect(0, 0, size, size);

    for (let row = 0; row < size / brickH; row++) {
        const offset = (row % 2) * (brickW / 2);
        for (let col = -1; col < size / brickW + 1; col++) {
            const x = col * brickW + offset + mortar / 2;
            const y = row  * brickH + mortar / 2;
            const w = brickW - mortar;
            const h = brickH - mortar;
            // Slight random tint per brick
            const v = Math.floor(Math.random() * 30 - 15);
            ctx.fillStyle = shiftColor(brickColor, v);
            ctx.fillRect(x, y, w, h);
        }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(8, 8);
    return tex;
}

function shiftColor(hex, amount) {
    const r = parseInt(hex.slice(1, 3), 16) + amount;
    const g = parseInt(hex.slice(3, 5), 16) + amount;
    const b = parseInt(hex.slice(5, 7), 16) + amount;
    const clamp = v => Math.max(0, Math.min(255, v));
    return `rgb(${clamp(r)},${clamp(g)},${clamp(b)})`;
}

// ------------------------------------------------------------------
// Stone texture (for shields)
// ------------------------------------------------------------------

function makeStoneTexture(size = 256) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#888';
    ctx.fillRect(0, 0, size, size);

    for (let i = 0; i < 400; i++) {
        const x = Math.random() * size;
        const y = Math.random() * size;
        const r = Math.random() * 20 + 5;
        const v = Math.floor(Math.random() * 60 - 30);
        ctx.fillStyle = shiftColor('#888888', v);
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * 0.6, Math.random() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2, 2);
    return tex;
}

// ------------------------------------------------------------------
// Arena class
// ------------------------------------------------------------------

export class Arena {
    constructor(scene, arenaData) {
        this.scene       = scene;
        this.size        = arenaData.size;
        this._shields       = arenaData.shields;  // [{x,y,z,w,h,d,id}, ...]
        this._shieldMeshes  = {};
        this._pickupMeshes  = {};
        this._pickupLights  = {};
        this._remotePlayers = {};  // id → { mesh, targetPos, targetRot }

        // Textures
        this._brickTex = makeBrickTexture();
        this._stoneTex = makeStoneTexture();

        this._buildWalls();
        this._buildShields(arenaData.shields);
    }

    // ------------------------------------------------------------------
    // Walls
    // ------------------------------------------------------------------

    _buildWalls() {
        const s   = this.size;
        const mat = new THREE.MeshLambertMaterial({ map: this._brickTex, side: THREE.BackSide });
        const geo = new THREE.BoxGeometry(s, s, s);
        const mesh = new THREE.Mesh(geo, mat);
        this.scene.add(mesh);

        // Edge highlight lines
        const edges = new THREE.EdgesGeometry(geo);
        const line  = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.3, transparent: true }));
        this.scene.add(line);
    }

    // ------------------------------------------------------------------
    // Shields
    // ------------------------------------------------------------------

    _buildShields(shields) {
        for (const s of shields) {
            const mesh = generateShieldMesh(s, this._stoneTex);
            this.scene.add(mesh);
            this._shieldMeshes[s.id] = mesh;
        }
    }

    /**
     * Push `pos` (THREE.Vector3) out of all shield AABBs.
     * Call after every local player movement step.
     * @param {THREE.Vector3} pos
     * @param {number} radius  — player collision radius (units)
     */
    resolveShieldCollision(pos, radius) {
        for (const s of this._shields) {
            const halfW = s.w / 2 + radius;
            const halfH = s.h / 2 + radius;
            const halfD = s.d / 2 + radius;
            const dx = pos.x - s.x;
            const dy = pos.y - s.y;
            const dz = pos.z - s.z;
            const absDx = Math.abs(dx);
            const absDy = Math.abs(dy);
            const absDz = Math.abs(dz);

            if (absDx < halfW && absDy < halfH && absDz < halfD) {
                // Penetrating — push out along minimum overlap axis
                const overlapX = halfW - absDx;
                const overlapY = halfH - absDy;
                const overlapZ = halfD - absDz;
                if (overlapX <= overlapY && overlapX <= overlapZ) {
                    pos.x += dx >= 0 ? overlapX : -overlapX;
                } else if (overlapY <= overlapX && overlapY <= overlapZ) {
                    pos.y += dy >= 0 ? overlapY : -overlapY;
                } else {
                    pos.z += dz >= 0 ? overlapZ : -overlapZ;
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Pickups
    // ------------------------------------------------------------------

    syncPickups(pickups) {
        const seen = new Set();

        for (const pu of pickups) {
            seen.add(pu.id);
            if (!this._pickupMeshes[pu.id]) {
                this._addPickup(pu);
            }
        }

        // Remove stale pickups
        for (const id of Object.keys(this._pickupMeshes)) {
            if (!seen.has(id)) {
                this._removePickup(id);
            }
        }
    }

    _addPickup(pu) {
        const color = PICKUP_COLORS[pu.type] ?? 0xffffff;
        const geo   = new THREE.OctahedronGeometry(10, 0);
        const mat   = new THREE.MeshBasicMaterial({ color, wireframe: true });
        const mesh  = new THREE.Mesh(geo, mat);
        mesh.position.set(pu.pos.x, pu.pos.y, pu.pos.z);  // note: PHP stores as pos.x etc.

        // Outer glow sphere
        const glow = new THREE.PointLight(color, 2, 80);
        mesh.add(glow);

        this.scene.add(mesh);
        this._pickupMeshes[pu.id] = mesh;
    }

    _removePickup(id) {
        const mesh = this._pickupMeshes[id];
        if (mesh) {
            this.scene.remove(mesh);
            mesh.geometry.dispose();
            mesh.material.dispose();
            delete this._pickupMeshes[id];
        }
    }

    // ------------------------------------------------------------------
    // Remote players
    // ------------------------------------------------------------------

    syncRemotePlayers(players, localPlayerId) {
        const seen = new Set();

        for (const p of players) {
            if (p.id === localPlayerId || p.isDead) continue;
            seen.add(p.id);

            if (!this._remotePlayers[p.id]) {
                this._addRemotePlayer(p);
            }

            const rp = this._remotePlayers[p.id];
            rp.targetPos.set(p.position.x, p.position.y, p.position.z);
            rp.targetRot.set(p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w);
            rp.handle = p.handle;

            // Detect health change → show health bar
            const newHealth = p.health ?? 100;
            if (newHealth !== rp.health) {
                rp.health         = newHealth;
                rp.maxHealth      = p.maxHealth ?? 100;
                rp.healthOpacity  = 1.0;
                rp.lastDamagedAt  = performance.now();
                this._drawLabel(rp.labelCanvas, rp.handle, rp.health, rp.maxHealth, rp.healthOpacity);
                rp.labelTex.needsUpdate = true;
            }
        }

        // Remove disconnected players
        for (const id of Object.keys(this._remotePlayers)) {
            if (!seen.has(id)) {
                // Determine if they died or disconnected
                const stateP = players.find(p => p.id === id);
                if (stateP && stateP.isDead) {
                    // Play explosion sound at their last known position
                    const rp = this._remotePlayers[id];
                    soundManager.play('explosion_ship', {
                        x: rp.mesh.position.x,
                        y: rp.mesh.position.y,
                        z: rp.mesh.position.z
                    });
                }
                this._removeRemotePlayer(id);
            }
        }
    }

    _addRemotePlayer(p) {
        const geo  = generateShipGeometry(p.seed ?? 1234);
        const mat  = new THREE.MeshLambertMaterial({ color: p.isBot ? 0xff4444 : 0x44aaff });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(p.position.x, p.position.y, p.position.z);

        // Label sprite (name always visible; health bar fades in on damage)
        const { sprite, canvas, tex } = this._makeLabelSprite(p.handle, p.health ?? 100, p.maxHealth ?? 100, 0);
        mesh.add(sprite);

        this.scene.add(mesh);

        this._remotePlayers[p.id] = {
            mesh,
            targetPos:    new THREE.Vector3(p.position.x, p.position.y, p.position.z),
            targetRot:    new THREE.Quaternion(p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w),
            handle:       p.handle,
            health:       p.health ?? 100,
            maxHealth:    p.maxHealth ?? 100,
            labelSprite:  sprite,
            labelCanvas:  canvas,
            labelTex:     tex,
            healthOpacity:  0,        // health bar starts hidden
            lastDamagedAt:  -Infinity, // ms (performance.now() scale)
        };
    }

    // ------------------------------------------------------------------
    // Label helpers
    // ------------------------------------------------------------------

    _makeLabelSprite(handle, health, maxHealth, healthOpacity) {
        const canvas = document.createElement('canvas');
        canvas.width  = 256;
        canvas.height = 56;
        const tex = new THREE.CanvasTexture(canvas);
        this._drawLabel(canvas, handle, health, maxHealth, healthOpacity);
        tex.needsUpdate = true;
        const mat    = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
        const sprite = new THREE.Sprite(mat);
        sprite.scale.set(90, 20, 1);   // world-unit dimensions
        sprite.position.set(0, 28, 0); // 28 units above ship centre
        return { sprite, canvas, tex };
    }

    _drawLabel(canvas, handle, health, maxHealth, healthOpacity) {
        const ctx = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);

        // Name — always drawn
        ctx.globalAlpha  = 1.0;
        ctx.font         = 'bold 20px "Courier New", monospace';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'top';
        ctx.shadowColor  = '#000000';
        ctx.shadowBlur   = 6;
        ctx.fillStyle    = '#dde8ff';
        ctx.fillText(handle, W / 2, 2);

        // Health bar — opacity-controlled
        if (healthOpacity > 0.01) {
            const pct  = Math.max(0, Math.min(1, health / maxHealth));
            const barW = Math.floor(W * 0.68);
            const barH = 9;
            const bx   = Math.floor((W - barW) / 2);
            const by   = 29;

            ctx.shadowBlur = 0;

            ctx.globalAlpha = healthOpacity * 0.75;
            ctx.fillStyle   = '#111111';
            ctx.fillRect(bx, by, barW, barH);

            ctx.globalAlpha = healthOpacity;
            ctx.fillStyle   = pct > 0.5 ? '#33ee44' : pct > 0.25 ? '#ffaa00' : '#ff2222';
            ctx.fillRect(bx, by, Math.floor(barW * pct), barH);

            ctx.globalAlpha = healthOpacity * 0.55;
            ctx.strokeStyle = '#888888';
            ctx.lineWidth   = 1;
            ctx.strokeRect(bx + 0.5, by + 0.5, barW - 1, barH - 1);
        }
    }

    _removeRemotePlayer(id) {
        const rp = this._remotePlayers[id];
        if (rp) {
            this.scene.remove(rp.mesh);
            rp.mesh.geometry.dispose();
            rp.mesh.material.dispose();
            if (rp.labelTex) rp.labelTex.dispose();
            if (rp.labelSprite) rp.labelSprite.material.dispose();
            delete this._remotePlayers[id];
        }
    }

    /** Called each frame to smoothly interpolate remote players. */
    update(dt) {
        const lerp = Math.min(1, dt * 10);

        // Rotate pickups
        for (const mesh of Object.values(this._pickupMeshes)) {
            mesh.rotation.y += dt * 1.2;
            mesh.rotation.x += dt * 0.7;
        }

        // Interpolate remote players + fade health bars
        const now = performance.now();
        for (const rp of Object.values(this._remotePlayers)) {
            rp.mesh.position.lerp(rp.targetPos, lerp);
            rp.mesh.quaternion.slerp(rp.targetRot, lerp);

            // Fade out health bar 2.5 s after last damage event
            if (rp.healthOpacity > 0) {
                const age = (now - rp.lastDamagedAt) / 1000;
                if (age > 2.5) {
                    rp.healthOpacity = Math.max(0, rp.healthOpacity - dt * 1.2);
                    this._drawLabel(rp.labelCanvas, rp.handle, rp.health, rp.maxHealth, rp.healthOpacity);
                    rp.labelTex.needsUpdate = true;
                }
            }
        }
    }

    /** Returns array of { position } for enemy tracking (missiles/radar). */
    getRemotePlayerPositions() {
        return Object.values(this._remotePlayers).map(rp => ({ position: rp.mesh.position }));
    }

    getShields() {
        return this._shields || [];
    }

    /** Returns array of { id, position, handle } for HUD/radar. */
    getRemotePlayerInfo() {
        return Object.entries(this._remotePlayers).map(([id, rp]) => ({
            id,
            handle:   rp.handle,
            position: rp.mesh.position,
        }));
    }
}

