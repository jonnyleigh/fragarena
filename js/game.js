/**
 * game.js — master game loop
 *
 * Called by main.js after the player has joined.
 * Owns the requestAnimationFrame loop that:
 *   1. Reads input
 *   2. Updates local player predict
 *   3. Sends input to server
 *   4. Syncs remote players / pickups / beams from latest server state
 *   5. Updates weapon system (local bullets)
 *   6. Renders
 *   7. Updates HUD + radar
 */

import * as THREE  from 'https://cdn.jsdelivr.net/npm/three@0.162.0/build/three.module.js';
import * as Network from './network.js';
import * as Input   from './input.js';
import { LocalPlayer }  from './player.js';
import { WeaponSystem } from './weapons.js';
import { WEAPON_DEFS }  from './weapons.js';
import { Arena }        from './arena.js';
import { Renderer }     from './renderer.js';
import { Radar }        from './radar.js';
import { HUD }          from './hud.js';
import { Chat }         from './chat.js';
import { soundManager } from './sound-manager.js';

export class Game {
    constructor(playerId, initialState) {
        this._playerId = playerId;
        this._state    = initialState;
        this._running  = false;
        this._lastTime = performance.now();

        // Find our player record
        const me = this._findMe();

        // Core subsystems
        this._localPlayer  = new LocalPlayer();
        if (me) {
            this._localPlayer.position.set(me.position.x, me.position.y, me.position.z);
            this._localPlayer.reconcile(me);
        }

        this._renderer    = new Renderer(document.getElementById('game-canvas'), me?.seed ?? 1234);
        this._weaponSys   = new WeaponSystem(this._renderer.scene);
        this._arena       = new Arena(this._renderer.scene, initialState.arena);
        this._radar       = new Radar(document.getElementById('radar-canvas'));
        this._hud         = new HUD();
        this._chat        = new Chat();

        // Input
        Input.init(document.getElementById('game-canvas'), {
            onChatOpen: () => this._chat.open(),
            onQuit:     () => this._quit(),
        });

        // Network state subscription
        Network.onState(s => this._onServerState(s));

        // Track death to trigger flash + explosion
        this._wasDead = false;
        this._lastWeapon = 'pulse';

        // Queued actions for next network send
        this._pendingActions = [];

        // Firing state
        this._isFiring = false;

        // Respawn flash counter
        this._deathFlashDone = false;

        // Constrol: last fire time (client-side gating for quick feel)
        this._clientCanFireAt = 0;

        // Damage direction indicators
        this._dmgIndicators = [];   // { angle, alpha }
        this._lastHealth    = null; // health on previous frame for delta detection
        this._dmgCanvas     = document.getElementById('dmg-dir-canvas');
        this._dmgCtx        = this._dmgCanvas ? this._dmgCanvas.getContext('2d') : null;
        this._audioListenerErrorLogged = false;

        // Setup debug console commands
        this._setupDebugConsole();
    }

    _setupDebugConsole() {
        /** Debug console API exposed to window for dev testing */
        window.debug = {
            weapon: (name) => {
                const me = this._findMe();
                if (!me) {
                    console.log('❌ Player not found');
                    return;
                }
                if (!WEAPON_DEFS[name]) {
                    console.log(`❌ Invalid weapon: "${name}"`);
                    console.log('Available:', Object.keys(WEAPON_DEFS).join(', '));
                    return;
                }
                me.weapon = name;
                me.weaponExpiry = null;
                me.ammo = WEAPON_DEFS[name].ammo;
                console.log(`✓ Switched to: ${WEAPON_DEFS[name].label}`);
            },
            weapons: () => {
                console.table(
                    Object.entries(WEAPON_DEFS).map(([key, def]) => ({
                        Weapon: def.label,
                        Damage: def.damage,
                        Cooldown: `${def.cooldownMs}ms`,
                        Speed: def.bulletSpeed === 0 ? 'Instant' : `${def.bulletSpeed} u/s`,
                        Type: def.isRaycast ? 'Raycast' : 'Projectile',
                        Homing: def.isHoming ? 'Yes' : 'No',
                    }))
                );
                console.log('Usage: debug.weapon("weapon_name")');
                console.log('Example: debug.weapon("instagib")');
            },
            setHealth: (hp) => {
                const me = this._findMe();
                if (!me) {
                    console.log('❌ Player not found');
                    return;
                }
                me.health = Math.max(0, Math.min(100, hp));
                console.log(`✓ Health set to: ${me.health}`);
            },
            info: () => {
                const me = this._findMe();
                if (!me) {
                    console.log('❌ Player not found');
                    return;
                }
                console.log({
                    'Player ID': me.id,
                    'Health': me.health,
                    'Weapon': WEAPON_DEFS[me.weapon]?.label || me.weapon,
                    'Ammo': me.ammo === -1 ? 'Unlimited' : me.ammo,
                    'Firing': this._isFiring ? 'Yes' : 'No',
                    'Dead': me.isDead ? 'Yes' : 'No',
                });
            },
            help: () => {
                console.log(`
╔════════════════════════════════════════════╗
║       FRAG ARENA DEBUG COMMANDS            ║
╚════════════════════════════════════════════╝

debug.weapons()          List all weapons and stats
debug.weapon(name)       Switch to a weapon
                        Example: debug.weapon("instagib")

debug.setHealth(hp)      Set player health (0-100)

debug.info()             Show current player info

debug.help()             Show this message
                `);
            },
        };
        console.log('💡 Type debug.help() for console commands');
    }

    start() {
        this._running  = true;
        this._lastTime = performance.now();
        this._loop(this._lastTime);
    }

    stop() {
        this._running = false;
    }

    _updateAudioListenerSafe(camera) {
        try {
            soundManager.updateAudioListener(camera);
        } catch (err) {
            if (!this._audioListenerErrorLogged) {
                console.error('Audio listener update failed:', err);
                this._audioListenerErrorLogged = true;
            }
        }
    }

    // ------------------------------------------------------------------
    // Main loop
    // ------------------------------------------------------------------

    _loop(now) {
        if (!this._running) return;
        requestAnimationFrame(t => this._loop(t));

        const dt = Math.min((now - this._lastTime) / 1000, 0.1);
        this._lastTime = now;

        const frameInput = Input.getFrameInput(dt);
        const me         = this._findMe();
        const isDead     = me?.isDead ?? false;

        // Detect transitions BEFORE the early-return so _wasDead is always current.
        const justDied      = isDead    && !this._wasDead;
        const justRespawned = !isDead   && this._wasDead;
        this._wasDead = isDead;

        const currentWeapon = me?.weapon ?? 'pulse';
        if (me && !isDead && currentWeapon !== this._lastWeapon) {
            if (currentWeapon === 'pulse') {
                soundManager.play('weapon_expired');
            } else {
                soundManager.play('pickup_weapon');
            }
            this._lastWeapon = currentWeapon;
        }

        if (justDied) {
            this._renderer.triggerDeathFlash();
            this._renderer.spawnExplosion(this._localPlayer.position.clone());
            soundManager.play('explosion_ship', this._localPlayer.position);
            soundManager.play('explosion_ship'); // non-positional louder layer
        }

        // Track incoming damage direction (runs whether alive or dying)
        this._detectDamageDirection(me, justRespawned);
        
        if (justRespawned) {
            soundManager.play('player_respawn', this._localPlayer.position);
        }

        if (!me || isDead) {
            // Render with frozen camera while dead
            this._renderer.render(dt);

              const cam = this._renderer.camera;
              const fw = new THREE.Vector3();
              cam.getWorldDirection(fw);
              this._updateAudioListenerSafe({
                  position: cam.position,
                  forward: fw,
                  up: cam.up
              });
        } else {
            // Only process input if alive
            // On respawn the server assigns a new spawn position — snap to it immediately
            // before any movement this frame so the player starts from the right place.
            if (justRespawned) {
                this._localPlayer.position.set(me.position.x, me.position.y, me.position.z);
            }

            // 1. Update local player
            this._localPlayer.applyInput(
                frameInput.moveLocal,
                frameInput.yaw,
                frameInput.pitch,
                frameInput.roll,
                dt,
            );
            // Resolve shield AABB collision client-side so movement feels solid
            this._arena.resolveShieldCollision(this._localPlayer.position, 15);
            // Sync metadata (health, weapon, ammo, etc.) from server — NOT position.
            // Position is client-authoritative; the server just echoes our own stale
            // position back, so correcting against it causes snap-back glitches.
            if (me) this._localPlayer.reconcile(me);

            // 2. Fire
            if (frameInput.firing && !Input.isChatMode()) {
                this._tryFire();
            }

            // 3. Send input to server
            Network.queueInput(
                this._localPlayer.toJSON(),
                this._localPlayer.rotationJSON(),
                this._pendingActions.splice(0),
            );
        }

        // 4. Sync scene from server state (runs whether alive or dead)
        if (this._state) {
            this._arena.syncPickups(this._state.pickups ?? []);
            this._arena.syncRemotePlayers(this._state.players ?? [], this._playerId);

            // Render server beam strikes
            for (const beam of this._state.beams ?? []) {
                if (!this._seenBeams) this._seenBeams = new Set();
                if (!this._seenBeams.has(beam.id)) {
                    this._seenBeams.add(beam.id);
                    this._weaponSys.addBeamFromServer(beam);
                }
            }
        }

        // 5. Update weapon system bullets
        const enemies = this._arena.getRemotePlayerPositions();
        const shields = this._arena.getShields();
        this._weaponSys.update(dt, enemies, shields);

        // 6. Arena update (interpolation, pickup spin)
        this._arena.update(dt);

        // 7. Sync camera
        if (!isDead) {
            this._renderer.syncCamera(this._localPlayer.position, this._localPlayer.rotation);
        }

        // 8. Render
        if (!isDead) {
            this._renderer.render(dt);
            const cam = this._renderer.camera;
            const fw = new THREE.Vector3();
            cam.getWorldDirection(fw);
            this._updateAudioListenerSafe({
                position: cam.position,
                forward: fw,
                up: cam.up
            });
        }
        // 8b. Damage direction indicators
        this._drawDmgIndicators(dt);

        // 9. Radar
        this._radar.draw(
            this._localPlayer.position,
            this._localPlayer.rotation,
            this._state?.players ?? [],
            this._playerId,
        );

        // 10. HUD
        this._hud.update(
            me,
            this._state?.players ?? [],
            this._state?.chat    ?? [],
            now / 1000,
        );
    }

    // ------------------------------------------------------------------
    // Damage direction indicators
    // ------------------------------------------------------------------

    /**
     * Compare current health to last frame's health; when a drop is detected
     * compute the attacker's bearing in local camera space and queue an indicator.
     */
    _detectDamageDirection(me, justRespawned) {
        if (!me) return;

        const hp = me.health;

        if (justRespawned) {
            this._lastHealth = hp;
            return;
        }

        if (this._lastHealth !== null && hp < this._lastHealth) {
            soundManager.play('player_hurt');
            const attackerId = me.lastDamagedBy;
            if (attackerId && this._state) {
                const attacker = this._state.players.find(p => p.id === attackerId);
                if (attacker?.position) {
                    const dx  = attacker.position.x - this._localPlayer.position.x;
                    const dy  = attacker.position.y - this._localPlayer.position.y;
                    const dz  = attacker.position.z - this._localPlayer.position.z;
                    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    if (len > 0.1) {
                        // Direction to attacker in world space
                        const dir = new THREE.Vector3(dx / len, dy / len, dz / len);
                        // Rotate into local camera space so we get a screen-relative angle
                        dir.applyQuaternion(this._localPlayer.rotation.clone().invert());
                        // Screen-space angle: 0 = top, π/2 = right, ±π = bottom, -π/2 = left
                        const angle = Math.atan2(dir.x, dir.y);
                        this._dmgIndicators.push({ angle, alpha: 1.0 });
                    }
                }
            }
        }

        this._lastHealth = hp;
    }

    /**
     * Draw all active damage direction indicators on the overlay canvas and
     * fade them out over ~1.4 seconds.
     */
    _drawDmgIndicators(dt) {
        const canvas = this._dmgCanvas;
        const ctx    = this._dmgCtx;
        if (!canvas || !ctx) return;

        const W = window.innerWidth;
        const H = window.innerHeight;
        if (canvas.width  !== W) canvas.width  = W;
        if (canvas.height !== H) canvas.height = H;

        ctx.clearRect(0, 0, W, H);

        if (!this._dmgIndicators.length) return;

        const cx       = W / 2;
        const cy       = H / 2;
        const radius   = Math.min(cx, cy) * 0.80;  // ring radius
        const arcHalf  = Math.PI / 6;              // ±30° spread per indicator

        for (const ind of this._dmgIndicators) {
            const a = ind.alpha;
            if (a <= 0) continue;

            // Our convention: 0=top, +π/2=right
            // Canvas arc convention: 0=right, -π/2=top  →  canvasAngle = ourAngle - π/2
            const ca = ind.angle - Math.PI / 2;

            ctx.save();
            ctx.shadowColor = `rgba(255,40,0,${a})`;
            ctx.shadowBlur  = 28;
            ctx.strokeStyle = `rgba(255,80,0,${a})`;
            ctx.lineWidth   = Math.round(14 * a + 4);
            ctx.lineCap     = 'round';
            ctx.beginPath();
            ctx.arc(cx, cy, radius, ca - arcHalf, ca + arcHalf);
            ctx.stroke();
            ctx.restore();

            ind.alpha = Math.max(0, a - dt * 0.72);
        }

        // Prune fully-faded indicators
        this._dmgIndicators = this._dmgIndicators.filter(i => i.alpha > 0);
    }

    // ------------------------------------------------------------------
    // Firing
    // ------------------------------------------------------------------

    _tryFire() {
        const me  = this._findMe();
        if (!me) return;

        const weapon = me.weapon ?? 'pulse';
        const def    = WEAPON_DEFS[weapon];
        const now    = performance.now();

        if (now < this._clientCanFireAt) return;

        const action = this._weaponSys.fire(this._localPlayer, weapon);
        if (action) {
            this._pendingActions.push(action);
            this._clientCanFireAt = now + def.cooldownMs;
        }
    }

    // ------------------------------------------------------------------
    // Server state handler
    // ------------------------------------------------------------------

    _onServerState(state) {
        if (this._state && state.chat) {
            const oldLen = this._state.chat.length;
            const newLen = state.chat.length;
            if (newLen > oldLen && oldLen > 0) { // Don't play for initial catch-up
                soundManager.play('chat_message');
            }
        }
        this._state = state;
    }

    // ------------------------------------------------------------------
    // Quit
    // ------------------------------------------------------------------

    async _quit() {
        const confirmed = confirm('Leave the arena?');
        if (!confirmed) return;
        this.stop();
        await Network.leave();
        document.getElementById('join-screen').style.display = 'flex';
        document.getElementById('game-ui').style.display     = 'none';
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    _findMe() {
        if (!this._state) return null;
        return this._state.players.find(p => p.id === this._playerId) ?? null;
    }
}

