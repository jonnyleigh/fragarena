import { Weapons } from './Weapons.js';
import { GameState } from './GameState.js';

/**
 * BotAI — advanced state-machine bot controller.
 * Faithful port of lib/BotAI.php.
 *
 * States:
 *   patrol     → random waypoint navigation
 *   chase      → approach nearest enemy
 *   attack     → maintain range, fire at target
 *   takeCover  → retreat to nearest shield face
 *   seekPickup → move to nearest weapon pickup
 *
 * Called once per server tick for every bot via BotAI.tick().
 */

export class BotAI {
    // Movement speeds (units/sec) per skill tier
    static SPEED = { low: 55.0, medium: 75.0, high: 100.0 };

    // Aim accuracy (0–1, 1 = perfect lead) per skill tier
    static ACCURACY = { low: 0.35, medium: 0.65, high: 0.92 };

    // Reaction distance — how close an enemy must be to trigger chase/attack
    static DETECT_RANGE = { low: 200.0, medium: 280.0, high: 350.0 };

    // Preferred attack stand-off distance
    static ATTACK_RANGE = 120.0;

    // Health threshold to trigger cover-seeking (percent of max)
    static COVER_HP_THRESHOLD = 0.35;

    // ------------------------------------------------------------------

    /**
     * Port of BotAI::tick().
     * @param {number}   bi    Index of the bot in state.players
     * @param {object}   state Shared game state (mutated in-place)
     * @param {number}   dt    Delta time in seconds since last tick
     */
    static tick(bi, state, dt) {
        const bot   = state.players[bi];
        const now   = Date.now() / 1000;
        const skill = bot.botSkill ?? 'medium';

        if (bot.isDead) return;

        // ------ Expire pickup weapon ------
        if (bot.weaponExpiry !== null && now > bot.weaponExpiry) {
            bot.weapon       = Weapons.PULSE;
            bot.weaponExpiry = null;
            bot.ammo         = -1;
        }

        // ------ Choose state ------
        state.players[bi].botState = BotAI._chooseState(bot, state, skill);
        const botState = state.players[bi].botState;

        // ------ Execute state ------
        switch (botState) {
            case 'patrol':
                BotAI._doPatrol(bi, state, dt, skill);
                break;
            case 'chase':
            case 'attack':
                BotAI._doAttack(bi, state, dt, skill);
                break;
            case 'takeCover':
                BotAI._doTakeCover(bi, state, dt, skill);
                break;
            case 'seekPickup':
                BotAI._doSeekPickup(bi, state, dt, skill);
                break;
        }

        // Clamp to arena
        state.players[bi].position = GameState.clampToArena(
            state.players[bi].position,
            state.arena.size
        );

        // Push bot out of any shield AABB it has clipped into
        BotAI._resolveShieldCollisions(bi, state);
    }

    // ------------------------------------------------------------------
    // State chooser
    // ------------------------------------------------------------------

    /**
     * Port of BotAI::chooseState().
     * NOTE: PHP_FLOAT_MAX → Infinity
     */
    static _chooseState(bot, state, skill) {
        const hpRatio = bot.health / bot.maxHealth;

        // Low health → cover
        if (hpRatio < BotAI.COVER_HP_THRESHOLD) {
            return 'takeCover';
        }

        // Nearby pickup worth taking?
        const nearestPickup = BotAI._findNearestPickup(bot, state);
        const nearestEnemy  = BotAI._findNearestEnemy(bot, state);
        const detectRange   = BotAI.DETECT_RANGE[skill];

        if (nearestPickup !== null && bot.weapon === Weapons.PULSE) {
            const pickupDist = BotAI._dist(bot.position, nearestPickup.pos);
            const enemyDist  = nearestEnemy !== null
                ? BotAI._dist(bot.position, nearestEnemy.position)
                : Infinity;
            if (pickupDist < enemyDist * 0.6) {
                return 'seekPickup';
            }
        }

        if (nearestEnemy !== null) {
            const d = BotAI._dist(bot.position, nearestEnemy.position);
            if (d < detectRange) {
                return d < BotAI.ATTACK_RANGE * 1.8 ? 'attack' : 'chase';
            }
        }

        return 'patrol';
    }

    // ------------------------------------------------------------------
    // Patrol
    // ------------------------------------------------------------------

    /**
     * Port of BotAI::doPatrol().
     */
    static _doPatrol(bi, state, dt, skill) {
        const bot  = state.players[bi];
        const half = state.arena.size / 2 - 50;
        const now  = Date.now() / 1000;

        // Pick a new waypoint if none, or reached, or state timer expired
        if (
            bot.botWaypoint === null ||
            BotAI._dist(bot.position, bot.botWaypoint) < 20 ||
            now > (bot.botNextStateAt ?? 0)
        ) {
            bot.botWaypoint = {
                x: BotAI._rand(-half, half),
                y: BotAI._rand(-half, half),
                z: BotAI._rand(-half, half),
            };
            bot.botNextStateAt = now + BotAI._rand(5, 15);
        }

        BotAI._moveToward(bi, state, bot.botWaypoint, dt, skill);
        BotAI._faceDirection(bi, state, bot.botWaypoint);
    }

    // ------------------------------------------------------------------
    // Attack / chase
    // ------------------------------------------------------------------

    /**
     * Port of BotAI::doAttack().
     */
    static _doAttack(bi, state, dt, skill) {
        const bot   = state.players[bi];
        const enemy = BotAI._findNearestEnemy(bot, state);
        if (!enemy) return;

        const dist = BotAI._dist(bot.position, enemy.position);

        // Maintain attack range — close in if too far, back off if too close
        if (dist > BotAI.ATTACK_RANGE) {
            BotAI._moveToward(bi, state, enemy.position, dt, skill);
        } else if (dist < BotAI.ATTACK_RANGE * 0.5) {
            // Back away
            const dir = BotAI._normalise(BotAI._vecSub(bot.position, enemy.position));
            const spd = BotAI.SPEED[skill];
            bot.position.x += dir.x * spd * dt;
            bot.position.y += dir.y * spd * dt;
            bot.position.z += dir.z * spd * dt;
        } else {
            // Strafe dodge — move perpendicular on a 1.2 s timer
            const now = Date.now() / 1000;
            if ((bot.botNextStateAt ?? 0) < now) {
                bot.botWaypoint    = BotAI._strafeTarget(bot, enemy);
                bot.botNextStateAt = now + 1.2;
            }
            BotAI._moveToward(bi, state, bot.botWaypoint ?? enemy.position, dt, skill);
        }

        BotAI._faceDirection(bi, state, enemy.position);

        // Try to fire
        BotAI._tryFire(bi, state, enemy, skill);
    }

    // ------------------------------------------------------------------
    // Take cover
    // ------------------------------------------------------------------

    /**
     * Port of BotAI::doTakeCover().
     */
    static _doTakeCover(bi, state, dt, skill) {
        const bot    = state.players[bi];
        const shield = BotAI._findNearestShield(bot, state);

        if (shield === null) {
            // No shields — just flee from nearest enemy
            const enemy = BotAI._findNearestEnemy(bot, state);
            if (enemy) {
                const away = BotAI._normalise(BotAI._vecSub(bot.position, enemy.position));
                const spd  = BotAI.SPEED[skill];
                bot.position.x += away.x * spd * dt;
                bot.position.y += away.y * spd * dt;
                bot.position.z += away.z * spd * dt;
            }
            return;
        }

        // Move to a point just behind the shield (opposite side from nearest enemy)
        const enemy     = BotAI._findNearestEnemy(bot, state);
        const shieldPos = { x: shield.x, y: shield.y, z: shield.z };

        let coverPoint;
        if (enemy) {
            const awayFromEnemy = BotAI._normalise(BotAI._vecSub(shieldPos, enemy.position));
            coverPoint = {
                x: shield.x + awayFromEnemy.x * (shield.w / 2 + 25),
                y: shield.y + awayFromEnemy.y * (shield.h / 2 + 25),
                z: shield.z + awayFromEnemy.z * (shield.d / 2 + 25),
            };
        } else {
            coverPoint = shieldPos;
        }

        BotAI._moveToward(bi, state, coverPoint, dt, skill);
        BotAI._faceDirection(bi, state, coverPoint);

        // Fire if enemy is in sight while in cover
        if (enemy) {
            BotAI._tryFire(bi, state, enemy, skill);
        }
    }

    // ------------------------------------------------------------------
    // Seek pickup
    // ------------------------------------------------------------------

    /**
     * Port of BotAI::doSeekPickup().
     */
    static _doSeekPickup(bi, state, dt, skill) {
        const bot    = state.players[bi];
        const pickup = BotAI._findNearestPickup(bot, state);
        if (!pickup) return;

        BotAI._moveToward(bi, state, pickup.pos, dt, skill);
        BotAI._faceDirection(bi, state, pickup.pos);

        // Check collection (close enough?)
        if (BotAI._dist(bot.position, pickup.pos) < 25) {
            // Queue a pickup action — GameTick will handle it
            bot.pendingActions.push({ type: 'pickup', pickupId: pickup.id });
        }
    }

    // ------------------------------------------------------------------
    // Firing logic
    // ------------------------------------------------------------------

    /**
     * Port of BotAI::tryFire().
     * NOTE: PHP's lcg_value() returns a float in [0,1) using a separate
     * linear congruential generator seeded once per request. In a long-running
     * Node server Math.random() is equivalent in practice (uniform [0,1)).
     */
    static _tryFire(bi, state, enemy, skill) {
        const bot = state.players[bi];
        const now = Date.now() / 1000;

        if (now < bot.canFireAt) return;

        const accuracy = BotAI.ACCURACY[skill];
        const def      = Weapons.getDef(bot.weapon);

        // Predict enemy position (lead targeting)
        // NOTE: travelTime is computed but not actually used to offset the predicted
        // position — the PHP source also only computes it and then uses enemy.position
        // directly. This appears intentional (simple aim, no true lead).
        const travelTime = BotAI._dist(bot.position, enemy.position) / Math.max(1, def.bulletSpeed); // eslint-disable-line no-unused-vars
        const predicted  = {
            x: enemy.position.x,
            y: enemy.position.y,
            z: enemy.position.z,
        };

        // Apply accuracy scatter
        const spread = (1.0 - accuracy) * 0.3; // max ~17.2° when accuracy=0
        let aimDir   = BotAI._normalise(BotAI._vecSub(predicted, bot.position));
        // NOTE: PHP used lcg_value() → Math.random() (see note on lcg_value above)
        aimDir.x += (Math.random() * 2 - 1) * spread;
        aimDir.y += (Math.random() * 2 - 1) * spread;
        aimDir.z += (Math.random() * 2 - 1) * spread;
        aimDir = BotAI._normalise(aimDir);

        bot.pendingActions.push({ type: 'fire', dir: aimDir });
        // NOTE: canFireAt and ammo are managed by GameTick.spawnBullet / resolveBeam
        // after the action is processed — do NOT set them here or spawnBullet's
        // cooldown guard will reject the action we just queued.
    }

    // ------------------------------------------------------------------
    // Movement helpers
    // ------------------------------------------------------------------

    /**
     * Port of BotAI::moveToward().
     */
    static _moveToward(bi, state, target, dt, skill) {
        const bot  = state.players[bi];
        const dir  = BotAI._vecSub(target, bot.position);
        let dist   = BotAI._len(dir);
        if (dist < 1.0) return;
        const unit = BotAI._scale(dir, 1.0 / dist);
        const spd  = BotAI.SPEED[skill];
        let move   = spd * dt;
        if (move > dist) move = dist;
        bot.position.x += unit.x * move;
        bot.position.y += unit.y * move;
        bot.position.z += unit.z * move;
    }

    /**
     * Port of BotAI::faceDirection().
     * Stores a look-at quaternion derived from forward = normalised(target - pos),
     * up = (0,1,0).
     */
    static _faceDirection(bi, state, target) {
        const bot = state.players[bi];
        const dir = BotAI._normalise(BotAI._vecSub(target, bot.position));
        bot.rotation = BotAI._lookRotation(dir, { x: 0, y: 1, z: 0 });
    }

    /**
     * Port of BotAI::strafeTarget().
     * Returns a point 60 units to the left or right of the bot's current position,
     * perpendicular to the direction toward the enemy.
     * NOTE: PHP rand(0,1) → Math.random() < 0.5  (inclusive 0 or 1, equal probability)
     */
    static _strafeTarget(bot, enemy) {
        const toEnemy = BotAI._normalise(BotAI._vecSub(enemy.position, bot.position));
        const up      = { x: 0, y: 1, z: 0 };
        const perp    = BotAI._normalise(BotAI._cross(toEnemy, up));
        const side    = (Math.random() < 0.5 ? 1 : -1) * 60;
        return {
            x: bot.position.x + perp.x * side,
            y: bot.position.y,
            z: bot.position.z + perp.z * side,
        };
    }

    // ------------------------------------------------------------------
    // Scene queries
    // ------------------------------------------------------------------

    /**
     * Port of BotAI::findNearestEnemy().
     * Returns the nearest non-dead, non-self player object, or null.
     * NOTE: PHP_FLOAT_MAX → Infinity
     */
    static _findNearestEnemy(bot, state) {
        let best  = null;
        let bestD = Infinity;
        for (const p of state.players) {
            if (p.id === bot.id || p.isDead) continue;
            const d = BotAI._dist(bot.position, p.position);
            if (d < bestD) { bestD = d; best = p; }
        }
        return best;
    }

    /**
     * Port of BotAI::findNearestPickup().
     * Returns the nearest pickup object, or null.
     */
    static _findNearestPickup(bot, state) {
        let best  = null;
        let bestD = Infinity;
        for (const pu of state.pickups) {
            const d = BotAI._dist(bot.position, pu.pos);
            if (d < bestD) { bestD = d; best = pu; }
        }
        return best;
    }

    /**
     * Port of BotAI::findNearestShield().
     * Returns the nearest shield object, or null.
     */
    static _findNearestShield(bot, state) {
        let best  = null;
        let bestD = Infinity;
        for (const s of state.arena.shields) {
            const sPos = { x: s.x, y: s.y, z: s.z };
            const d    = BotAI._dist(bot.position, sPos);
            if (d < bestD) { bestD = d; best = s; }
        }
        return best;
    }

    // ------------------------------------------------------------------
    // Shield collision pushout
    // ------------------------------------------------------------------

    /**
     * Port of BotAI::resolveShieldCollisions().
     * Pushes the bot out of any shield AABB it has clipped into along the
     * shortest overlap axis.
     */
    static _resolveShieldCollisions(bi, state) {
        const bot    = state.players[bi];
        const radius = GameState.PLAYER_RADIUS;

        for (const s of state.arena.shields) {
            const halfW = s.w / 2 + radius;
            const halfH = s.h / 2 + radius;
            const halfD = s.d / 2 + radius;

            const dx = bot.position.x - s.x;
            const dy = bot.position.y - s.y;
            const dz = bot.position.z - s.z;

            const absDx = Math.abs(dx);
            const absDy = Math.abs(dy);
            const absDz = Math.abs(dz);

            if (absDx < halfW && absDy < halfH && absDz < halfD) {
                // Overlapping — push out along shortest axis
                const overlapX = halfW - absDx;
                const overlapY = halfH - absDy;
                const overlapZ = halfD - absDz;

                if (overlapX <= overlapY && overlapX <= overlapZ) {
                    bot.position.x += dx >= 0 ? overlapX : -overlapX;
                } else if (overlapY <= overlapX && overlapY <= overlapZ) {
                    bot.position.y += dy >= 0 ? overlapY : -overlapY;
                } else {
                    bot.position.z += dz >= 0 ? overlapZ : -overlapZ;
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Math helpers
    // All are ports of the private static methods in BotAI.php.
    // Pure float arithmetic — numerically identical to PHP.
    // ------------------------------------------------------------------

    static _dist(a, b) {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dz = a.z - b.z;
        return Math.sqrt(dx*dx + dy*dy + dz*dz);
    }

    static _len(v) {
        return Math.sqrt(v.x*v.x + v.y*v.y + v.z*v.z);
    }

    static _normalise(v) {
        const l = BotAI._len(v);
        if (l < 1e-6) return { x: 0, y: 0, z: 1 };
        return { x: v.x / l, y: v.y / l, z: v.z / l };
    }

    static _vecSub(a, b) {
        return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
    }

    static _scale(v, s) {
        return { x: v.x * s, y: v.y * s, z: v.z * s };
    }

    static _cross(a, b) {
        return {
            x: a.y * b.z - a.z * b.y,
            y: a.z * b.x - a.x * b.z,
            z: a.x * b.y - a.y * b.x,
        };
    }

    // NOTE: dot is defined in PHP but not called outside of lookRotation internals.
    // Kept here for completeness.
    static _dot(a, b) {
        return a.x * b.x + a.y * b.y + a.z * b.z;
    }

    /**
     * Build a look-at quaternion from forward + up vectors.
     * Returns { x, y, z, w } quaternion.
     * Port of BotAI::lookRotation() — exact same 4-branch matrix-to-quaternion
     * conversion. All arithmetic is identical.
     */
    static _lookRotation(forward, up) {
        const f = BotAI._normalise(forward);
        const r = BotAI._normalise(BotAI._cross(up, f));
        const u = BotAI._cross(f, r);

        const m00 = r.x; const m01 = r.y; const m02 = r.z;
        const m10 = u.x; const m11 = u.y; const m12 = u.z;
        const m20 = f.x; const m21 = f.y; const m22 = f.z;

        const trace = m00 + m11 + m22;
        if (trace > 0) {
            const s = 0.5 / Math.sqrt(trace + 1.0);
            return { w: 0.25 / s, x: (m21 - m12) * s, y: (m02 - m20) * s, z: (m10 - m01) * s };
        } else if (m00 > m11 && m00 > m22) {
            const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
            return { w: (m21 - m12) / s, x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s };
        } else if (m11 > m22) {
            const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
            return { w: (m02 - m20) / s, x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s };
        } else {
            const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
            return { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s };
        }
    }

    // ------------------------------------------------------------------
    // Internal: inclusive integer random (port of PHP rand($min, $max))
    // ------------------------------------------------------------------

    /**
     * Returns a random integer in [min, max] inclusive.
     * Port of PHP rand() / mt_rand().
     */
    static _rand(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }
}
