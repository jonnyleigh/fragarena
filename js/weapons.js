/**
 * weapons.js — client-side weapon definitions + bullet management
 *
 * Mirrors lib/Weapons.php — keep in sync.
 * Client creates local bullet meshes for immediate visual feedback.
 * Server is authoritative for hit detection.
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.162.0/build/three.module.js';
import { soundManager } from './sound-manager.js';

// ------------------------------------------------------------------
// Weapon definitions (mirror of PHP Weapons::DEFS)
// ------------------------------------------------------------------

export const WEAPON_DEFS = {
    pulse: {
        label:      'Pulse Laser',
        cooldownMs: 600,
        damage:     10,
        bulletSpeed: 300,
        bulletRadius: 2,
        bulletTTL:  2.0,
        color:      0x00ffff,
        isRaycast:  false,
        isHoming:   false,
        ammo:       -1,
    },
    instagib: {
        label:      'Instagib Laser',
        cooldownMs: 3000,
        damage:     200,
        bulletSpeed: 0,
        bulletRadius: 0,
        bulletTTL:  0.25,
        color:      0xffffff,
        isRaycast:  true,
        isHoming:   false,
        ammo:       -1,
    },
    rail: {
        label:      'Rail Gun',
        cooldownMs: 150,
        damage:     15,
        bulletSpeed: 800,
        bulletRadius: 1.5,
        bulletTTL:  1.5,
        color:      0xff8800,
        isRaycast:  false,
        isHoming:   false,
        ammo:       -1,
    },
    missile: {
        label:      'Missiles',
        cooldownMs: 2000,
        damage:     60,
        bulletSpeed: 160,
        bulletRadius: 5,
        bulletTTL:  8.0,
        color:      0xff2222,
        isRaycast:  false,
        isHoming:   true,
        ammo:       6,
        homingTurnRateDeg: 90,
    },
};

// ------------------------------------------------------------------
// Pickup colours (for arena pickups glow)
// ------------------------------------------------------------------
export const PICKUP_COLORS = {
    instagib: 0xffffff,
    rail:    0xff8800,
    missile: 0xff2222,
};

// ------------------------------------------------------------------
// Bullet mesh factories
// ------------------------------------------------------------------

function makePulseMesh() {
    const geo  = new THREE.SphereGeometry(2, 6, 6);
    const mat  = new THREE.MeshBasicMaterial({ color: 0x00ffff });
    return new THREE.Mesh(geo, mat);
}

function makeRailMesh() {
    const geo = new THREE.CylinderGeometry(0.8, 0.8, 6, 5);
    geo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    const mat = new THREE.MeshBasicMaterial({ color: 0xff8800 });
    return new THREE.Mesh(geo, mat);
}

function makeMissileMesh() {
    const group = new THREE.Group();
    const body  = new THREE.Mesh(
        new THREE.ConeGeometry(3, 12, 6),
        new THREE.MeshBasicMaterial({ color: 0xff2222 })
    );
    body.rotation.x = Math.PI / 2;
    // Engine glow (point light)
    const glow = new THREE.PointLight(0xff4400, 1.5, 40);
    glow.position.set(0, 0, 6);
    group.add(body, glow);
    return group;
}

// ------------------------------------------------------------------
// ClientBullet class
// ------------------------------------------------------------------

export class ClientBullet {
    constructor(type, origin, direction, ownerId, scene) {
        this.type     = type;
        this.ownerId  = ownerId;
        this.origin   = origin.clone();
        this.velocity = direction.clone().normalize().multiplyScalar(WEAPON_DEFS[type].bulletSpeed);
        this.ttl      = WEAPON_DEFS[type].bulletTTL;
        this.elapsed  = 0;

        // Build mesh
        switch (type) {
            case 'rail':    this.mesh = makeRailMesh();    break;
            case 'missile': this.mesh = makeMissileMesh(); break;
            default:        this.mesh = makePulseMesh();   break;
        }

        this.mesh.position.copy(origin);
        scene.add(this.mesh);
    }

    /** Returns true when the bullet should be removed. */
    update(dt, enemies, shields) {
        this.elapsed += dt;
        if (this.elapsed >= this.ttl) {
            return true;
        }

        // Check local simple collision to trigger hit effects and visually remove
        // (Server remains authoritative for damage)
        const radius = WEAPON_DEFS[this.type].bulletRadius || 2;
        
        if (shields) {
            for (const s of shields) {
                const dx = Math.abs(this.mesh.position.x - s.x);
                const dy = Math.abs(this.mesh.position.y - s.y);
                const dz = Math.abs(this.mesh.position.z - s.z);
                
                if (dx <= (s.w/2 + radius) && dy <= (s.h/2 + radius) && dz <= (s.d/2 + radius)) {
                    soundManager.play('impact_shield', this.mesh.position);
                    return true;
                }
            }
        }
        
        if (enemies) {
            for (const e of enemies) {
                // assume player radius ~ 6 for visual hits
                if (this.mesh.position.distanceTo(e.position) < 6 + radius) {
                    soundManager.play('impact_hull', this.mesh.position);
                    return true;
                }
            }
        }

        // Homing
        if (WEAPON_DEFS[this.type].isHoming && enemies.length > 0) {
            let nearest = null;
            let nearDist = Infinity;
            for (const e of enemies) {
                const d = this.mesh.position.distanceTo(e.position);
                if (d < nearDist) { nearDist = d; nearest = e; }
            }
            if (nearest) {
                const maxTurn = WEAPON_DEFS.missile.homingTurnRateDeg * Math.PI / 180;
                const desired = nearest.position.clone().sub(this.mesh.position).normalize();
                const current = this.velocity.clone().normalize();
                const t       = Math.min(1, maxTurn * dt / Math.max(0.001, current.angleTo(desired)));
                const newDir  = current.lerp(desired, t).normalize();
                this.velocity.copy(newDir.multiplyScalar(WEAPON_DEFS.missile.bulletSpeed));
            }
        }

        this.mesh.position.addScaledVector(this.velocity, dt);

        // Orient rail/missile to travel direction
        if (this.type === 'rail' || this.type === 'missile') {
            const fwd = this.velocity.clone().normalize();
            this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), fwd);
        }

        return false;
    }

    dispose(scene) {
        scene.remove(this.mesh);
        this.mesh.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
        });
    }
}

// ------------------------------------------------------------------
// Beam strike visual
// ------------------------------------------------------------------

export class BeamStrike {
    constructor(origin, direction, dist, scene) {
        const end   = origin.clone().addScaledVector(direction, dist);
        const points = [origin, end];
        const geo   = new THREE.BufferGeometry().setFromPoints(points);
        const mat   = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2 });
        this.line   = new THREE.Line(geo, mat);
        this.ttl    = 0.25;
        this.elapsed = 0;
        scene.add(this.line);
    }

    update(dt) {
        this.elapsed += dt;
        const alpha = 1 - this.elapsed / this.ttl;
        this.line.material.opacity = Math.max(0, alpha);
        this.line.material.transparent = true;
        return this.elapsed >= this.ttl;
    }

    dispose(scene) {
        scene.remove(this.line);
        this.line.geometry.dispose();
        this.line.material.dispose();
    }
}

// ------------------------------------------------------------------
// Weapon system facade
// ------------------------------------------------------------------

export class WeaponSystem {
    constructor(scene) {
        this.scene   = scene;
        this.bullets = [];
        this.beams   = [];
    }

    /**
     * Fire a bullet visually.
     * Cooldown gating is handled in game.js (_clientCanFireAt).
     * Returns the action payload to queue to the server.
     */
    fire(player, weapon) {
        const def = WEAPON_DEFS[weapon];
        if (!def) return null;

        const origin    = player.position.clone();
        const direction = player.getForward();

        if (def.isRaycast) {
            // Instagib Laser — play sonic boom
            soundManager.play('sonic_boom', origin);
            return { type: 'beam', dir: { x: direction.x, y: direction.y, z: direction.z } };
        }

        if (weapon === 'pulse') soundManager.play('pulse_laser_fire', origin);
        else if (weapon === 'rail') soundManager.play('railgun_fire', origin);
        else if (weapon === 'missile') soundManager.play('missile_launch', origin);

        const bullet = new ClientBullet(weapon, origin, direction, player.id, this.scene);
        this.bullets.push(bullet);

        return { type: 'fire', dir: { x: direction.x, y: direction.y, z: direction.z } };
    }

    /** Show beam from server state */
    addBeamFromServer(beamData) {
        const origin = new THREE.Vector3(beamData.ox, beamData.oy, beamData.oz);
        const dir    = new THREE.Vector3(beamData.dx, beamData.dy, beamData.dz);
        const strike = new BeamStrike(origin, dir, beamData.dist, this.scene);
        this.beams.push(strike);
        
        soundManager.play('sonic_boom', origin);
    }

    /** Update all active bullets and beams. */
    update(dt, enemyPositions, shields) {
        this.bullets = this.bullets.filter(b => {
            const done = b.update(dt, enemyPositions, shields);
            if (done) b.dispose(this.scene);
            return !done;
        });
        this.beams = this.beams.filter(b => {
            const done = b.update(dt);
            if (done) b.dispose(this.scene);
            return !done;
        });
    }
}

