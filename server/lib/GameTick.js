import { GameState } from './GameState.js';
import { Weapons }   from './Weapons.js';
import { BotAI }     from './BotAI.js';

/**
 * GameTick — server-side game simulation.
 * Faithful port of lib/GameTick.php.
 *
 * runTick() is called by the setInterval game loop in server.js, not by HTTP requests.
 * All file I/O has been removed — state is passed as a plain in-memory JS object.
 *
 * Order of operations per tick:
 *   0. Drop timed-out human players
 *   1. Expire stale held weapons
 *   2. Process queued player actions (fire, beam, pickup)
 *   3. Run bot AI (move + generate actions), then process their new actions
 *   4. Advance bullet positions; apply homing on missiles
 *   5+6. Swept bullet–shield and bullet–player collision
 *   5b. Proximity auto-collect pickups for nearby human players
 *   7. Kill processing, score update, respawn scheduling
 *   8. Execute pending respawns
 *   9. Ensure pickup count is maintained (spawn replacements)
 *  10. Kick bots alive > 20 min; spawn replacements / fill to MAX_PLAYERS
 *  11. Update player timeInGame
 */

export class GameTick {
    static TICK_INTERVAL      = 0.05;  // 50 ms minimum between ticks
    static DISCONNECT_TIMEOUT = 30.0;  // seconds without input before a human is removed

    /**
     * Main tick entry point.
     * Port of GameTick::runTick().
     * @param {object} state  The shared in-memory game state (mutated in-place)
     * @param {number} now    Current time as float seconds (Date.now() / 1000)
     */
    static runTick(state, now) {
        const prev = parseFloat(state.lastTick ?? 0.0);
        // Cap dt at 250 ms to avoid spiral-of-death after a server stall
        const dt   = Math.min(now - prev, 0.25);
        state.lastTick = now;

        // 0. Drop timed-out human players
        GameTick._checkDisconnects(state, now);

        // 1. Expire held weapons
        GameTick._expireWeapons(state, now);

        // 2. Process player actions (humans have queued actions via input handler)
        GameTick._processActions(state, now, dt);

        // 3. Bot AI
        // NOTE: PHP iterated with foreach ($state['players'] as $i => $p).
        // We iterate by index so that mutations to state.players[i] are live.
        for (let i = 0; i < state.players.length; i++) {
            const p = state.players[i];
            if (p.isBot && !p.isDead) {
                BotAI.tick(i, state, dt);
                // Process any actions the bot just generated
                GameTick._processActions(state, now, dt, i);
            }
        }

        // 4. Advance bullets
        GameTick._advanceBullets(state, dt, now);

        // 5+6. Collisions (swept segment tests so fast bullets don't tunnel)
        GameTick._checkBulletCollisions(state, dt, now);

        // 5b. Auto-collect pickups for nearby human players
        GameTick._checkPickupProximity(state);

        // 7. Kill processing
        GameTick._processDeaths(state, now);

        // 8. Respawns
        GameTick._processRespawns(state, now);

        // 9. Pickup count
        GameTick._maintainPickups(state);

        // 10. Bot rotation (kick old bots, replace with fresh ones)
        GameTick._rotateBots(state, now);

        // 11. Time in game
        for (let i = 0; i < state.players.length; i++) {
            if (!state.players[i].isDead) {
                state.players[i].timeInGame = (state.players[i].timeInGame ?? 0) + dt;
            }
        }
    }

    // ------------------------------------------------------------------
    // 0. Disconnect detection
    // ------------------------------------------------------------------

    /**
     * Port of GameTick::checkDisconnects().
     * NOTE: PHP collected indices then used array_reverse($timedOut) to remove
     * in reverse order so earlier indices stay valid. We do the same.
     */
    static _checkDisconnects(state, now) {
        const timedOut = [];
        for (let i = 0; i < state.players.length; i++) {
            const p = state.players[i];
            if (p.isBot) continue;
            const idle = now - parseFloat(p.lastInputAt ?? now);
            if (idle > GameTick.DISCONNECT_TIMEOUT) {
                timedOut.push(i);
            }
        }

        // Remove in reverse order so indices stay valid
        // NOTE: PHP used array_reverse() + array_splice() — JS equivalent below
        for (let j = timedOut.length - 1; j >= 0; j--) {
            const i      = timedOut[j];
            const handle = state.players[i].handle;
            GameState.addChat(state, 'System', `${handle} disconnected.`);
            // NOTE: array_splice($arr, $i, 1) → arr.splice(i, 1)
            state.players.splice(i, 1);
        }

        // Fill empty slots with bots
        const botsNeeded = GameState.MAX_PLAYERS - state.players.length;
        for (let b = 0; b < botsNeeded; b++) {
            state.players.push(GameState.makeBotPlayer(state));
        }
    }

    // ------------------------------------------------------------------
    // 1. Expire held weapons
    // ------------------------------------------------------------------

    /**
     * Port of GameTick::expireWeapons().
     * NOTE: PHP used `foreach (&$p)` reference loop → we use index-based access.
     */
    static _expireWeapons(state, now) {
        for (let i = 0; i < state.players.length; i++) {
            const p = state.players[i];
            if (p.weaponExpiry !== null && now >= p.weaponExpiry) {
                p.weapon       = Weapons.PULSE;
                p.weaponExpiry = null;
                p.ammo         = -1;
            }
        }
    }

    // ------------------------------------------------------------------
    // 2. Process queued actions
    // ------------------------------------------------------------------

    /**
     * Port of GameTick::processActions().
     * @param {number} onlyIndex  If >= 0, only process that player's actions.
     *                            Defaults to -1 (all players) matching PHP behaviour.
     */
    static _processActions(state, now, dt, onlyIndex = -1) {
        // NOTE: PHP used array_keys($state['players']) for all, or [$onlyIndex].
        const indices = onlyIndex >= 0
            ? [onlyIndex]
            : state.players.map((_, i) => i);

        for (const i of indices) {
            const p = state.players[i];
            if (p.isDead || !p.pendingActions || p.pendingActions.length === 0) continue;

            for (const action of p.pendingActions) {
                switch (action.type ?? '') {
                    case 'fire':
                        GameTick._spawnBullet(state, i, action, now);
                        break;
                    case 'beam':
                        GameTick._resolveBeam(state, i, action, now);
                        break;
                    case 'pickup':
                        GameTick._resolvePickup(state, i, action.pickupId ?? '');
                        break;
                }
            }
            state.players[i].pendingActions = [];
        }
    }

    // ------------------------------------------------------------------
    // Bullet spawning
    // ------------------------------------------------------------------

    /**
     * Port of GameTick::spawnBullet().
     */
    static _spawnBullet(state, pi, action, now) {
        const p   = state.players[pi];
        const def = Weapons.getDef(p.weapon);

        if (def.isRaycast) {
            // Beam is handled separately
            GameTick._resolveBeam(state, pi, action, now);
            return;
        }

        if (now < (p.canFireAt ?? 0)) return;

        const dir = action.dir ?? { x: 0, y: 0, z: 1 };
        const spd = def.bulletSpeed;

        state.bullets.push({
            id:       GameState.uuid(),
            ownerId:  p.id,
            type:     p.weapon,
            x:        p.position.x,
            y:        p.position.y,
            z:        p.position.z,
            vx:       dir.x * spd,
            vy:       dir.y * spd,
            vz:       dir.z * spd,
            r:        def.bulletRadius,
            damage:   def.damage,
            expiry:   now + def.bulletTTL,
            isHoming: def.isHoming,
        });

        state.players[pi].canFireAt = now + Weapons.cooldownSeconds(p.weapon);

        // Ammo management
        if (def.ammo > 0 && p.ammo > 0) {
            state.players[pi].ammo--;
            if (state.players[pi].ammo <= 0) {
                state.players[pi].weapon       = Weapons.PULSE;
                state.players[pi].weaponExpiry = null;
                state.players[pi].ammo         = -1;
            }
        }
    }

    /**
     * Port of GameTick::resolveBeam().
     * Performs a raycast for the instagib laser, stores a beam event for clients.
     * NOTE: PHP_FLOAT_MAX → Infinity; PHP_FLOAT_EPSILON → Number.EPSILON
     */
    static _resolveBeam(state, pi, action, now) {
        const p = state.players[pi];
        if (now < (p.canFireAt ?? 0)) return;

        const def     = Weapons.getDef(p.weapon);
        const origin  = p.position;
        const dir     = action.dir ?? { x: 0, y: 0, z: 1 };
        const maxDist = state.arena.size * 1.5;

        // Cast vs shields first, find minimum distance
        let hitDist = maxDist;

        for (const s of state.arena.shields) {
            const d = GameTick.rayBoxIntersect(origin, dir, s);
            if (d !== null && d < hitDist) {
                hitDist = d;
            }
        }

        // Cast vs players
        let hitPlayer = null;
        for (let j = 0; j < state.players.length; j++) {
            const target = state.players[j];
            if (target.id === p.id || target.isDead) continue;
            const d = GameTick.raySphereIntersect(origin, dir, target.position, GameState.PLAYER_RADIUS);
            if (d !== null && d < hitDist) {
                hitDist   = d;
                hitPlayer = j;
            }
        }

        // Store beam event for clients to render
        if (!state.beams) state.beams = []; // safety — should always exist from freshState
        state.beams.push({
            id:      GameState.uuid(),
            ownerId: p.id,
            ox:      origin.x, oy: origin.y, oz: origin.z,
            dx:      dir.x,    dy: dir.y,    dz: dir.z,
            dist:    hitDist,
            expiry:  now + 0.25,
        });

        if (hitPlayer !== null) {
            GameTick._damagePlayer(state, hitPlayer, def.damage, pi, p.weapon);
        }

        state.players[pi].canFireAt = now + Weapons.cooldownSeconds(p.weapon);
    }

    // ------------------------------------------------------------------
    // Pickup resolution
    // ------------------------------------------------------------------

    /**
     * Port of GameTick::resolvePickup().
     * Server-side sanity-checks distance (> 60 units → reject).
     * NOTE: array_splice($state['pickups'], $idx, 1) → state.pickups.splice(idx, 1)
     */
    static _resolvePickup(state, pi, pickupId) {
        if (!pickupId) return;

        const p = state.players[pi];

        for (let idx = 0; idx < state.pickups.length; idx++) {
            const pu = state.pickups[idx];
            if (pu.id !== pickupId) continue;

            // Verify the player is close enough (server-side sanity check)
            const dx   = p.position.x - pu.pos.x;
            const dy   = p.position.y - pu.pos.y;
            const dz   = p.position.z - pu.pos.z;
            const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);

            if (dist > 60) return; // too far — reject

            const def = Weapons.getDef(pu.type);
            state.players[pi].weapon       = pu.type;
            state.players[pi].ammo         = def.ammo;
            state.players[pi].weaponExpiry = Date.now() / 1000 + def.pickupDuration;
            state.players[pi].canFireAt    = 0;

            // Remove the pickup; _maintainPickups() will spawn a replacement
            state.pickups.splice(idx, 1);
            return;
        }
    }

    // ------------------------------------------------------------------
    // 4. Advance bullets
    // ------------------------------------------------------------------

    /**
     * Port of GameTick::advanceBullets().
     * NOTE: PHP built a new $alive array and assigned back — we do the same
     * to avoid mutating the array while iterating it.
     * NOTE: PHP used array_values(array_filter(...)) for beams → filter() already
     * produces a dense array in JS.
     */
    static _advanceBullets(state, dt, now) {
        const halfArena = state.arena.size / 2;

        // Expire old beams
        if (state.beams) {
            state.beams = state.beams.filter(b => b.expiry > now);
        }

        const alive = [];

        for (let b of state.bullets) {
            if (b.expiry <= now) continue;

            // Homing (missiles) — steer toward nearest enemy of owner
            if (b.isHoming) {
                b = GameTick._applyHoming(b, state, dt);
            }

            b.x += b.vx * dt;
            b.y += b.vy * dt;
            b.z += b.vz * dt;

            // Out of bounds check
            if (
                Math.abs(b.x) > halfArena ||
                Math.abs(b.y) > halfArena ||
                Math.abs(b.z) > halfArena
            ) continue;

            alive.push(b);
        }

        // NOTE: array_values($alive) in PHP re-indexes — JS array is always dense
        state.bullets = alive;
    }

    /**
     * Port of GameTick::applyHoming().
     * Slerp-like: rotates current velocity direction toward target by at most
     * maxTurn*dt radians. Uses linear interpolation + re-normalisation (not true
     * slerp) — matches the PHP source exactly.
     * NOTE: M_PI → Math.PI; PHP_FLOAT_MAX → Infinity; ** → **
     */
    static _applyHoming(b, state, dt) {
        // Find nearest enemy of the shooter
        let target = null;
        let bestD  = Infinity;
        for (const p of state.players) {
            if (p.id === b.ownerId || p.isDead) continue;
            const dx = p.position.x - b.x;
            const dy = p.position.y - b.y;
            const dz = p.position.z - b.z;
            const d  = Math.sqrt(dx*dx + dy*dy + dz*dz);
            if (d < bestD) { bestD = d; target = p; }
        }
        if (!target) return b;

        const def     = Weapons.getDef(Weapons.MISSILE);
        const maxTurn = def.homingTurnRateDeg * Math.PI / 180.0; // rad/s
        const spd     = Math.sqrt(b.vx*b.vx + b.vy*b.vy + b.vz*b.vz);

        const curDir = { x: b.vx / spd, y: b.vy / spd, z: b.vz / spd };
        const toTarget = {
            x: target.position.x - b.x,
            y: target.position.y - b.y,
            z: target.position.z - b.z,
        };
        const tLen = Math.sqrt(toTarget.x**2 + toTarget.y**2 + toTarget.z**2);
        if (tLen < 1) return b;
        const desDir = { x: toTarget.x / tLen, y: toTarget.y / tLen, z: toTarget.z / tLen };

        // Slerp-like: rotate curDir toward desDir by at most maxTurn*dt radians
        const cosA  = Math.min(1, Math.max(-1, curDir.x*desDir.x + curDir.y*desDir.y + curDir.z*desDir.z));
        const angle = Math.acos(cosA);
        const t     = angle > 1e-6 ? Math.min(1.0, maxTurn * dt / angle) : 1.0;
        const newDir = {
            x: curDir.x + (desDir.x - curDir.x) * t,
            y: curDir.y + (desDir.y - curDir.y) * t,
            z: curDir.z + (desDir.z - curDir.z) * t,
        };
        const nl = Math.sqrt(newDir.x**2 + newDir.y**2 + newDir.z**2);
        if (nl > 1e-6) {
            b.vx = newDir.x / nl * spd;
            b.vy = newDir.y / nl * spd;
            b.vz = newDir.z / nl * spd;
        }
        return b;
    }

    // ------------------------------------------------------------------
    // 5+6. Bullet collision
    // ------------------------------------------------------------------

    /**
     * Port of GameTick::checkBulletCollisions().
     * Uses swept segment tests (segment start = bullet pos at start of tick)
     * so fast bullets don't tunnel through thin shields or players.
     * NOTE: PHP collected $toRemove indices then used array_reverse() to splice
     * in reverse order — we do the same to preserve index validity.
     */
    static _checkBulletCollisions(state, dt, now) {
        const toRemove = [];

        for (let bi = 0; bi < state.bullets.length; bi++) {
            const b  = state.bullets[bi];
            let hit  = false;
            const br = parseFloat(b.r ?? 2.0);

            // Compute segment start — where the bullet was at the START of this tick
            const px = b.x - b.vx * dt;
            const py = b.y - b.vy * dt;
            const pz = b.z - b.vz * dt;

            // Find the earliest shield hit along the bullet segment
            let shieldT = Infinity; // NOTE: PHP_FLOAT_MAX → Infinity
            for (const s of state.arena.shields) {
                const t = GameTick._segmentBoxIntersectT(
                    px, py, pz, b.x, b.y, b.z, br,
                    s.x - s.w/2, s.y - s.h/2, s.z - s.d/2,
                    s.x + s.w/2, s.y + s.h/2, s.z + s.d/2
                );
                if (t !== null && t < shieldT) {
                    shieldT = t;
                    hit = true;
                }
            }

            // Player sphere — only register hit if player is reached before any shield
            for (let pi = 0; pi < state.players.length; pi++) {
                const p = state.players[pi];
                if (p.id === b.ownerId || p.isDead) continue;
                const r = GameState.PLAYER_RADIUS + br;
                const t = GameTick._segmentSphereIntersectT(
                    px, py, pz, b.x, b.y, b.z,
                    p.position.x, p.position.y, p.position.z, r
                );
                if (t !== null && t < shieldT) {
                    const shooterIndex = GameState.findPlayerIndex(state, b.ownerId);
                    const shooterWeapon = shooterIndex >= 0 ? state.players[shooterIndex].weapon : null;
                    GameTick._damagePlayer(state, pi, b.damage, shooterIndex, shooterWeapon);
                    hit = true;
                    break;
                }
            }

            if (hit) toRemove.push(bi);
        }

        // Remove in reverse order to keep earlier indices valid
        // NOTE: PHP used array_reverse($toRemove) then array_splice()
        for (let j = toRemove.length - 1; j >= 0; j--) {
            state.bullets.splice(toRemove[j], 1);
        }
    }

    // ------------------------------------------------------------------
    // 5b. Proximity pickup for human players
    // ------------------------------------------------------------------

    /**
     * Port of GameTick::checkPickupProximity().
     * Human players (non-bots) holding pulse laser auto-collect nearby pickups.
     * Collection radius: 45 units.
     * NOTE: PHP used squared-distance comparison (r2 = radius*radius) to avoid sqrt.
     * NOTE: PHP used foreach (&$p) reference — we use index-based access.
     * NOTE: array_splice during inner loop is safe here because we break after
     * the first collection (one pickup per player per tick), so the outer loop
     * index is not affected.
     */
    static _checkPickupProximity(state) {
        const radius = 45.0; // collection radius in units
        const r2     = radius * radius;

        for (let pi = 0; pi < state.players.length; pi++) {
            const p = state.players[pi];
            if (p.isDead || p.isBot || p.weapon !== Weapons.PULSE) continue;

            for (let idx = 0; idx < state.pickups.length; idx++) {
                const pu = state.pickups[idx];
                const dx = p.position.x - pu.pos.x;
                const dy = p.position.y - pu.pos.y;
                const dz = p.position.z - pu.pos.z;
                if (dx*dx + dy*dy + dz*dz <= r2) {
                    const def = Weapons.getDef(pu.type);
                    state.players[pi].weapon       = pu.type;
                    state.players[pi].weaponExpiry = Date.now() / 1000 + def.pickupDuration;
                    state.players[pi].ammo         = def.ammo;
                    state.pickups.splice(idx, 1);
                    break; // one pickup per player per tick
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Damage helper
    // ------------------------------------------------------------------

    /**
     * Port of GameTick::damagePlayer().
     * Applies damage and records the shooter's id as lastDamagedBy.
     * NOTE: health is clamped to 0 minimum (not below).
     */
    static _damagePlayer(state, pi, damage, shooterIndex, weaponType = null) {
        state.players[pi].health -= damage;
        if (state.players[pi].health < 0) {
            state.players[pi].health = 0;
        }
        if (shooterIndex >= 0) {
            state.players[pi].lastDamagedBy       = state.players[shooterIndex].id;
            state.players[pi].lastDamagedByWeapon = weaponType ?? state.players[shooterIndex].weapon;
        }
    }

    // ------------------------------------------------------------------
    // 7. Kill processing
    // ------------------------------------------------------------------

    /**
     * Port of GameTick::processDeaths().
     * On death: set isDead, schedule respawn, award kill to attacker,
     * drop held weapon as a pickup, reset weapon to pulse.
     * NOTE: PHP used foreach (&$p) — we use index-based access.
     */
    static _processDeaths(state, now) {
        for (let pi = 0; pi < state.players.length; pi++) {
            const p = state.players[pi];
            if (p.isDead || p.health > 0) continue;

            state.players[pi].isDead    = true;
            state.players[pi].respawnAt = now + GameState.RESPAWN_DELAY;
            state.players[pi].deaths    = (p.deaths ?? 0) + 1;

            // Award kill to the last attacker (tracked via lastDamagedBy)
            if (p.lastDamagedBy) {
                const killerIdx = GameState.findPlayerIndex(state, p.lastDamagedBy);
                if (killerIdx >= 0) {
                    state.players[killerIdx].score = (state.players[killerIdx].score ?? 0) + 1;
                    state.players[killerIdx].kills = (state.players[killerIdx].kills ?? 0) + 1;
                    const weaponLabel = Weapons.DEFS[p.lastDamagedByWeapon]?.label ?? p.lastDamagedByWeapon ?? 'unknown weapon';
                    GameState.addChat(state, 'System',
                        `${state.players[killerIdx].handle} fragged ${p.handle} with the ${weaponLabel}`);
                }
            }

            // Drop weapon pickup on death
            if (p.weapon !== Weapons.PULSE) {
                state.pickups.push({
                    id:   GameState.uuid(),
                    type: p.weapon,
                    pos:  p.position,
                });
            }

            // Reset weapon
            state.players[pi].weapon       = Weapons.PULSE;
            state.players[pi].weaponExpiry = null;
            state.players[pi].ammo         = -1;
        }
    }

    // ------------------------------------------------------------------
    // 8. Respawns
    // ------------------------------------------------------------------

    /**
     * Port of GameTick::processRespawns().
     * NOTE: PHP used foreach (&$p) — we use index-based access.
     */
    static _processRespawns(state, now) {
        for (let i = 0; i < state.players.length; i++) {
            const p = state.players[i];
            if (!p.isDead || p.respawnAt === null) continue;
            if (now < p.respawnAt) continue;

            state.players[i].isDead    = false;
            state.players[i].respawnAt = null;
            state.players[i].health    = p.maxHealth;
            state.players[i].position  = GameState.randomFreePosition(state);
        }
    }

    // ------------------------------------------------------------------
    // 9. Pickup maintenance
    // ------------------------------------------------------------------

    /**
     * Port of GameTick::maintainPickups().
     * Ensures at least one of each pickup type exists, capped at MAX_PICKUPS.
     * NOTE: PHP array_column($arr, 'type') → state.pickups.map(p => p.type)
     * NOTE: PHP in_array($type, $present, true) → present.includes(type)
     */
    static _maintainPickups(state) {
        const types   = Weapons.PICKUP_TYPES;
        const present = state.pickups.map(p => p.type);

        // Cap total pickups
        if (state.pickups.length >= GameState.MAX_PICKUPS) return;

        // Ensure at least one of each type exists
        for (const type of types) {
            if (!present.includes(type)) {
                state.pickups.push(GameState.makePickup(type, state));
                present.push(type);
                if (state.pickups.length >= GameState.MAX_PICKUPS) break;
            }
        }
    }

    // ------------------------------------------------------------------
    // 10. Bot rotation
    // ------------------------------------------------------------------

    /**
     * Port of GameTick::rotateBots().
     * Kicks bots alive > BOT_LIFETIME seconds and spawns replacements.
     * Also fills any empty slots up to MAX_PLAYERS.
     * NOTE: PHP broke after rotating one bot per tick to avoid index chaos during
     * the loop. We replicate that — only one rotation per call.
     * NOTE: PHP used array_splice($state['players'], $i, 1) inside a foreach —
     * safe because PHP breaks immediately after. We do the same.
     */
    static _rotateBots(state, now) {
        for (let i = 0; i < state.players.length; i++) {
            const p = state.players[i];
            if (!p.isBot) continue;
            if (now - p.botJoinedAt >= GameState.BOT_LIFETIME) {
                GameState.addChat(state, 'System', `${p.handle} (bot) rotated out.`);
                state.players.splice(i, 1);
                // Spawn replacement
                state.players.push(GameState.makeBotPlayer(state));
                break; // Only rotate one per tick to avoid index chaos
            }
        }

        // Ensure bot count fills arena
        const humanCount = GameState.countHumans(state);
        const needed     = GameState.MAX_PLAYERS - humanCount;
        let   bots       = GameState.countBots(state);
        let   current    = state.players.length;

        while (bots < needed && current < GameState.MAX_PLAYERS) {
            state.players.push(GameState.makeBotPlayer(state));
            bots++;
            current++;
        }
    }

    // ------------------------------------------------------------------
    // Swept collision helpers
    // ------------------------------------------------------------------

    /**
     * Segment AB vs sphere (centre C, radius r).
     * Returns the parametric entry t in [0,1] of the first intersection, or null.
     * Port of GameTick::segmentSphereIntersectT().
     * NOTE: PHP used 1e-12 as the zero-length segment epsilon.
     */
    static _segmentSphereIntersectT(ax, ay, az, bx, by, bz, cx, cy, cz, r) {
        const dx = bx - ax; const dy = by - ay; const dz = bz - az;
        const fx = ax - cx; const fy = ay - cy; const fz = az - cz;
        const a  = dx*dx + dy*dy + dz*dz;
        if (a < 1e-12) {
            return (fx*fx + fy*fy + fz*fz) < r*r ? 0.0 : null;
        }
        const b    = 2.0 * (fx*dx + fy*dy + fz*dz);
        const c    = (fx*fx + fy*fy + fz*fz) - r*r;
        const disc = b*b - 4.0*a*c;
        if (disc < 0) return null;
        const sq  = Math.sqrt(disc);
        const t0  = (-b - sq) / (2.0 * a);
        const t1  = (-b + sq) / (2.0 * a);
        if (t1 < 0.0 || t0 > 1.0) return null;
        return Math.max(0.0, t0);
    }

    /**
     * Segment AB vs AABB (min/max corners), with box expanded by br on all sides.
     * Returns the parametric entry t in [0,1], or null if no intersection.
     * Uses the slab method.
     * Port of GameTick::segmentBoxIntersectT().
     * NOTE: PHP used a foreach over axis tuples — we use explicit per-axis blocks
     * for clarity but identical arithmetic.
     * NOTE: PHP_FLOAT_EPSILON used in original segmentBoxIntersect (non-T variant)
     * but the T variant uses 1e-12 for the parallel-ray epsilon.
     */
    static _segmentBoxIntersectT(ax, ay, az, bx, by, bz, br, minX, minY, minZ, maxX, maxY, maxZ) {
        minX -= br; minY -= br; minZ -= br;
        maxX += br; maxY += br; maxZ += br;

        const ddx = bx - ax; const ddy = by - ay; const ddz = bz - az;
        let tMin = 0.0;
        let tMax = 1.0;

        // NOTE: PHP iterated over [[$dx,$ax,$minX,$maxX], ...] — we unroll the loop.
        for (const [d, o, mn, mx] of [
            [ddx, ax, minX, maxX],
            [ddy, ay, minY, maxY],
            [ddz, az, minZ, maxZ],
        ]) {
            if (Math.abs(d) < 1e-12) {
                if (o < mn || o > mx) return null;
            } else {
                let t1 = (mn - o) / d;
                let t2 = (mx - o) / d;
                if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
                tMin = Math.max(tMin, t1);
                tMax = Math.min(tMax, t2);
                if (tMin > tMax) return null;
            }
        }
        return tMin;
    }

    // ------------------------------------------------------------------
    // Ray helpers (for beam laser)
    // ------------------------------------------------------------------

    /**
     * Ray–AABB intersection. Returns distance t or null.
     * Shield is defined as centre + half-extents.
     * Port of GameTick::rayBoxIntersect().
     * NOTE: PHP_FLOAT_EPSILON → Number.EPSILON (tMin initial value)
     * NOTE: PHP_FLOAT_MAX → Infinity (tMax initial value)
     * NOTE: If the shooter's origin is inside the shield, returns null — avoids
     * false positives when server position clips into a shield due to lag/desync.
     */
    static rayBoxIntersect(origin, dir, shield) {
        const hx   = shield.w / 2; const hy = shield.h / 2; const hz = shield.d / 2;
        const minX = shield.x - hx; const maxX = shield.x + hx;
        const minY = shield.y - hy; const maxY = shield.y + hy;
        const minZ = shield.z - hz; const maxZ = shield.z + hz;

        // If the shooter's origin is inside the shield, don't block
        if (
            origin.x >= minX && origin.x <= maxX &&
            origin.y >= minY && origin.y <= maxY &&
            origin.z >= minZ && origin.z <= maxZ
        ) return null;

        let tMin = Number.EPSILON;
        let tMax = Infinity;

        for (const [ax, mn, mx] of [
            ['x', minX, maxX],
            ['y', minY, maxY],
            ['z', minZ, maxZ],
        ]) {
            const d = dir[ax];
            const o = origin[ax];
            if (Math.abs(d) < 1e-8) {
                if (o < mn || o > mx) return null;
            } else {
                let t1 = (mn - o) / d;
                let t2 = (mx - o) / d;
                if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
                tMin = Math.max(tMin, t1);
                tMax = Math.min(tMax, t2);
                if (tMin > tMax) return null;
            }
        }
        return tMin;
    }

    /**
     * Ray–sphere intersection. Returns distance t or null.
     * Port of GameTick::raySphereIntersect().
     * NOTE: minimum t of 1e-4 avoids self-hit when shooter is near their own position.
     */
    static raySphereIntersect(origin, dir, centre, r) {
        const oc = {
            x: origin.x - centre.x,
            y: origin.y - centre.y,
            z: origin.z - centre.z,
        };
        const a = dir.x**2 + dir.y**2 + dir.z**2;
        const b = 2 * (oc.x * dir.x + oc.y * dir.y + oc.z * dir.z);
        const c = (oc.x**2 + oc.y**2 + oc.z**2) - r*r;
        const d = b*b - 4*a*c;
        if (d < 0) return null;
        const t = (-b - Math.sqrt(d)) / (2 * a);
        return t > 1e-4 ? t : null;
    }
}
