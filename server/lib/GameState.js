import { Weapons } from './Weapons.js';

/**
 * GameState — in-memory game state.
 *
 * Faithful port of lib/GameState.php.
 * All file I/O (fopen, flock, fread, fwrite, fclose) has been removed;
 * state is a plain JS object held in memory for the lifetime of the server.
 *
 * Schema
 * ------
 * {
 *   arena  : { size: 500, shields: [ {id,x,y,z,w,h,d}, … ] },
 *   players: [ { … player record … }, … ],
 *   bullets: [ { … bullet record … }, … ],
 *   beams  : [ { … beam record … }, … ],
 *   pickups: [ { … pickup record … }, … ],
 *   chat   : [ { handle, message, time }, … ],
 *   lastTick: 0.0
 * }
 */

// NOTE: PHP used microtime(true) everywhere for float seconds.
// We use Date.now() / 1000 consistently throughout the JS port.

export class GameState {
    // ------------------------------------------------------------------
    // Constants (mirrors GameState.php class constants)
    // ------------------------------------------------------------------
    static MAX_CHAT    = 20;
    static ARENA_SIZE  = 1000;
    static MAX_PLAYERS = 6;
    static MAX_PICKUPS = 5;      // max concurrent weapon pickups in arena
    static PLAYER_RADIUS = 15.0; // sphere radius for collision
    static RESPAWN_DELAY = 3.0;  // seconds before re-entering arena
    static BOT_LIFETIME  = 1200; // 20 min — bots are kicked after this

    // ------------------------------------------------------------------
    // Instance — holds the live state object
    // ------------------------------------------------------------------
    constructor() {
        this._state = GameState.freshState();
    }

    /**
     * Return the underlying state object.
     * GameTick and handlers receive this reference and mutate it directly,
     * matching the PHP pattern of passing $state by reference.
     */
    getState() {
        return this._state;
    }

    /**
     * Return the state snapshot to broadcast to clients.
     * Equivalent to what api/state.php previously echo json_encode($state)-ed.
     */
    getSnapshot() {
        return this._state;
    }

    // ------------------------------------------------------------------
    // Fresh state factory
    // ------------------------------------------------------------------

    /**
     * Builds a brand-new arena with 6 bots and one of each pickup type.
     * Port of GameState::freshState().
     */
    static freshState() {
        const state = {
            arena: {
                size:    GameState.ARENA_SIZE,
                shields: GameState.generateShields(),
            },
            players: [],
            bullets:  [],
            beams:    [], // NOTE: PHP lazily created this; we initialise here to avoid undefined checks
            pickups:  [],
            chat: [
                { handle: 'System', message: 'FragArena online. Good hunting.', time: Date.now() / 1000 },
            ],
            lastTick: 0.0,
        };

        // Spawn 6 bots immediately
        for (let i = 0; i < 6; i++) {
            state.players.push(GameState.makeBotPlayer(state));
        }

        // Spawn initial pickups — one of each pickup type
        for (const type of Weapons.PICKUP_TYPES) {
            state.pickups.push(GameState.makePickup(type, state));
        }

        return state;
    }

    // ------------------------------------------------------------------
    // Player factories
    // ------------------------------------------------------------------

    /**
     * Port of GameState::makeHumanPlayer().
     * NOTE: PHP htmlspecialchars($handle, ENT_QUOTES) encodes <, >, &, ", '.
     * We replicate that by replacing those characters with their HTML entities,
     * then truncating to 20 characters with substr equivalent.
     */
    static makeHumanPlayer(handle) {
        const sanitised = String(handle)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;')
            .slice(0, 20);

        const now = Date.now() / 1000;
        return {
            id:             GameState.uuid(),
            handle:         sanitised,
            isBot:          false,
            position:       { x: 0, y: 0, z: 0 }, // randomised on spawn by caller
            rotation:       { x: 0, y: 0, z: 0, w: 1 },
            health:         200,
            maxHealth:      200,
            weapon:         Weapons.PULSE,
            weaponExpiry:   null,
            ammo:           -1,
            weaponHeat:     0.0,
            canFireAt:      0.0,
            score:          0,
            kills:          0,
            deaths:         0,
            joinedAt:       now,
            timeInGame:     0.0,
            respawnAt:      null,
            isDead:         false,
            botSkill:       null,
            botJoinedAt:    null,
            botState:       null,
            botTarget:      null,
            botWaypoint:    null,
            botNextStateAt: 0.0,
            pendingActions: [],
            lastInputAt:    now,
            seed:           GameState._rand(1000, 9999), // for procedural ship generation
        };
    }

    /**
     * Port of GameState::makeBotPlayer().
     * NOTE: PHP used `static $used = []` — a local static persisting across calls
     * within a request. In a long-running Node server a module-level variable achieves
     * the same effect (persists for server lifetime).
     */
    static makeBotPlayer(state) {
        const botNames = [
            'Wraith', 'Phantom', 'Spectre', 'Nemesis', 'Reaper', 'Vortex',
            'Sigma',  'Delta',   'Omega',   'Pulsar',  'Quasar', 'Nova',
        ];

        let name;
        // NOTE: PHP used in_array($name, $used, true) && count($used) < 50 as the
        // while condition. We replicate: keep trying until unique (or pool exhausted).
        do {
            name = botNames[Math.floor(Math.random() * botNames.length)]
                 + GameState._rand(1, 99);
        } while (_usedBotNames.has(name) && _usedBotNames.size < 50);
        _usedBotNames.add(name);

        const skills = ['low', 'medium', 'high'];
        const skill  = skills[Math.floor(Math.random() * skills.length)];

        const pos = GameState.randomFreePosition(state);
        const now = Date.now() / 1000;

        return {
            id:             GameState.uuid(),
            handle:         name,
            isBot:          true,
            position:       pos,
            rotation:       { x: 0, y: 0, z: 0, w: 1 },
            health:         200,
            maxHealth:      200,
            weapon:         Weapons.PULSE,
            weaponExpiry:   null,
            ammo:           -1,
            weaponHeat:     0.0,
            canFireAt:      0.0,
            score:          0,
            kills:          0,
            deaths:         0,
            joinedAt:       now,
            timeInGame:     0.0,
            respawnAt:      null,
            isDead:         false,
            botSkill:       skill,
            botJoinedAt:    now,
            botState:       'patrol',
            botTarget:      null,
            botWaypoint:    null,
            botNextStateAt: 0.0,
            pendingActions: [],
            lastInputAt:    now,
            seed:           GameState._rand(1000, 9999),
        };
    }

    // ------------------------------------------------------------------
    // Pickup factory
    // ------------------------------------------------------------------

    static makePickup(type, state) {
        return {
            id:  GameState.uuid(),
            type,
            pos: GameState.randomFreePosition(state),
        };
    }

    // ------------------------------------------------------------------
    // Arena generation
    // ------------------------------------------------------------------

    /**
     * Port of GameState::generateShields().
     */
    static generateShields() {
        const size   = GameState.ARENA_SIZE;
        const half   = size / 2;
        const margin = 80;    // keep shields away from walls
        const shields = [];
        const count  = GameState._rand(20, 28); // doubled arena → more obstacles

        for (let i = 0; i < count; i++) {
            const w = GameState._rand(35, 100);
            const h = GameState._rand(35, 100);
            const d = GameState._rand(35, 100);

            const x = GameState._rand(-half + margin + w, half - margin - w);
            const y = GameState._rand(-half + margin + h, half - margin - h);
            const z = GameState._rand(-half + margin + d, half - margin - d);

            shields.push({ id: `s${i}`, x, y, z, w, h, d });
        }
        return shields;
    }

    // ------------------------------------------------------------------
    // Utility helpers
    // ------------------------------------------------------------------

    /**
     * Find a position not occupied by another player, a shield, or the arena wall.
     * Port of GameState::randomFreePosition().
     */
    static randomFreePosition(state, attempts = 30) {
        const size = (state.arena && state.arena.size) ? state.arena.size : GameState.ARENA_SIZE;
        const half = size / 2 - 40;

        for (let a = 0; a < attempts; a++) {
            const pos = {
                x: GameState._rand(-half, half),
                y: GameState._rand(-half, half),
                z: GameState._rand(-half, half),
            };
            if (!GameState._positionOccupied(pos, state)) {
                return pos;
            }
        }
        // Fall back to a random position if all attempts fail
        return {
            x: GameState._rand(-half, half),
            y: GameState._rand(-half, half),
            z: GameState._rand(-half, half),
        };
    }

    static _positionOccupied(pos, state) {
        const minDist = GameState.PLAYER_RADIUS * 4; // 60 units

        for (const p of (state.players || [])) {
            if (p.isDead) continue;
            const dx = pos.x - p.position.x;
            const dy = pos.y - p.position.y;
            const dz = pos.z - p.position.z;
            if (Math.sqrt(dx*dx + dy*dy + dz*dz) < minDist) return true;
        }

        for (const s of (state.arena && state.arena.shields ? state.arena.shields : [])) {
            if (
                Math.abs(pos.x - s.x) < s.w / 2 + minDist &&
                Math.abs(pos.y - s.y) < s.h / 2 + minDist &&
                Math.abs(pos.z - s.z) < s.d / 2 + minDist
            ) return true;
        }

        return false;
    }

    /**
     * Generate a UUID v4-like string.
     * Port of GameState::uuid() which used mt_rand().
     * NOTE: PHP's mt_rand is not cryptographically secure; crypto.randomUUID()
     * is stronger but the format is identical. Using crypto here for correctness.
     */
    static uuid() {
        // NOTE: PHP built the UUID manually from mt_rand calls.
        // We use the same hex pattern via Math.random() to stay dependency-free,
        // matching the exact sprintf format from PHP.
        const r = () => Math.floor(Math.random() * 0x10000);
        return (
            _hex4(r()) + _hex4(r()) + '-' +
            _hex4(r()) + '-' +
            _hex4((r() & 0x0fff) | 0x4000) + '-' +
            _hex4((r() & 0x3fff) | 0x8000) + '-' +
            _hex4(r()) + _hex4(r()) + _hex4(r())
        );
    }

    /**
     * Clamp a {x,y,z} position to the arena bounds.
     * Port of GameState::clampToArena().
     */
    static clampToArena(pos, size) {
        const half = size / 2;
        return {
            x: Math.max(-half, Math.min(half, pos.x)),
            y: Math.max(-half, Math.min(half, pos.y)),
            z: Math.max(-half, Math.min(half, pos.z)),
        };
    }

    /**
     * Append a chat message and trim the log to MAX_CHAT entries.
     * Port of GameState::addChat().
     * NOTE: PHP used array_values(array_slice($chat, -MAX_CHAT)) → JS: .slice(-MAX_CHAT)
     */
    static addChat(state, handle, message) {
        state.chat.push({
            handle,
            message: String(message).slice(0, 200),
            time:    Date.now() / 1000,
        });
        if (state.chat.length > GameState.MAX_CHAT) {
            // NOTE: array_values(array_slice($arr, -N)) in PHP ≡ arr.slice(-N) in JS
            state.chat = state.chat.slice(-GameState.MAX_CHAT);
        }
    }

    /**
     * Return player index by id, or -1.
     * Port of GameState::findPlayerIndex().
     */
    static findPlayerIndex(state, id) {
        for (let i = 0; i < state.players.length; i++) {
            if (state.players[i].id === id) return i;
        }
        return -1;
    }

    /** Count human (non-bot) players. Port of GameState::countHumans(). */
    static countHumans(state) {
        return state.players.filter(p => !p.isBot).length;
    }

    /** Count bot players. Port of GameState::countBots(). */
    static countBots(state) {
        return state.players.filter(p => p.isBot).length;
    }

    /**
     * Return the index of the bot that joined earliest.
     * Port of GameState::findOldestBot().
     * NOTE: PHP used PHP_INT_MAX as initial sentinel → we use Infinity.
     */
    static findOldestBot(state) {
        let oldest = Infinity;
        let idx    = -1;
        for (let i = 0; i < state.players.length; i++) {
            const p = state.players[i];
            if (p.isBot && p.botJoinedAt < oldest) {
                oldest = p.botJoinedAt;
                idx    = i;
            }
        }
        return idx;
    }

    // ------------------------------------------------------------------
    // Internal: inclusive integer random (port of PHP rand($min, $max))
    // ------------------------------------------------------------------

    /**
     * Returns a random integer in [min, max] inclusive.
     * Port of PHP rand($min, $max) and mt_rand($min, $max).
     * NOTE: Math.random() is not seedable without a library, unlike PHP's mt_rand.
     * This is acceptable — the PHP code also used unseeded randomness here.
     */
    static _rand(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }
}

// ------------------------------------------------------------------
// Module-level state for makeBotPlayer's used-name tracking.
// Equivalent to PHP's `static $used = []` local — persists for server lifetime.
// ------------------------------------------------------------------
const _usedBotNames = new Set();

// ------------------------------------------------------------------
// Private helper: format a number as a 4-digit lowercase hex string.
// Used by uuid().
// ------------------------------------------------------------------
function _hex4(n) {
    return n.toString(16).padStart(4, '0');
}
