/**
 * Weapon definitions for FragArena.
 * Faithful port of lib/Weapons.php.
 * All values kept in sync with js/weapons.js (client-side).
 *
 * Bullet speed / TTL combine to give effective range:
 *   Pulse  : 400 u/s × 2.0 s = 800 u   (PHP comment said 300 but DEFS say 400)
 *   Rail   : 800 u/s × 1.5 s = 1200 u
 *   Missile: 160 u/s × 8.0 s = 1280 u  (but homing)
 *   Instagib: instant raycast
 */

export class Weapons {
    // ---------------------------------------------------------------
    // Weapon type identifiers
    // Port of PHP class constants.
    // ---------------------------------------------------------------
    static PULSE    = 'pulse';
    static INSTAGIB = 'instagib';
    static RAIL     = 'rail';
    static MISSILE  = 'missile';

    // Pickup weapon types (array for convenience).
    // Port of PHP: const PICKUP_TYPES = [self::INSTAGIB, self::RAIL, self::MISSILE]
    static PICKUP_TYPES = ['instagib', 'rail', 'missile'];

    // ---------------------------------------------------------------
    // Definitions keyed by weapon type.
    // Port of PHP: const DEFS = [ ... ]
    // All magic numbers preserved exactly as in PHP source.
    // ---------------------------------------------------------------
    static DEFS = {
        pulse: {
            label:           'Pulse Laser',
            isPickup:        false,
            ammo:            -1,        // -1 = unlimited
            cooldownMs:      400,       // ms between shots
            damage:          30,
            bulletSpeed:     400.0,     // units per second
            bulletRadius:    2.0,
            bulletTTL:       2.0,       // seconds of flight
            isRaycast:       false,
            isHoming:        false,
            pickupDuration:  0,         // seconds held (0 = permanent / not a pickup)
        },
        instagib: {
            label:           'Instagib Laser',
            isPickup:        true,
            ammo:            -1,
            cooldownMs:      3000,
            damage:          200,
            bulletSpeed:     0.0,       // instant
            bulletRadius:    0.0,
            bulletTTL:       0.25,      // visual fade only
            isRaycast:       true,
            isHoming:        false,
            pickupDuration:  90,
        },
        rail: {
            label:           'Rail Gun',
            isPickup:        true,
            ammo:            -1,
            cooldownMs:      150,
            damage:          15,
            bulletSpeed:     800.0,
            bulletRadius:    1.5,
            bulletTTL:       1.5,
            isRaycast:       false,
            isHoming:        false,
            pickupDuration:  90,
        },
        missile: {
            label:              'Missiles',
            isPickup:           true,
            ammo:               6,
            cooldownMs:         2000,
            damage:             60,
            bulletSpeed:        160.0,
            bulletRadius:       5.0,
            bulletTTL:          8.0,
            isRaycast:          false,
            isHoming:           true,
            homingTurnRateDeg:  90.0,   // max degrees/sec the missile can steer
            pickupDuration:     90,
        },
    };

    // ---------------------------------------------------------------
    // Helpers
    // Port of PHP static methods.
    // ---------------------------------------------------------------

    /**
     * Return the definition for the given weapon type.
     * Falls back to pulse if the type is unknown.
     * Port of Weapons::getDef().
     * NOTE: PHP used self::DEFS[$type] ?? self::DEFS[self::PULSE]
     */
    static getDef(type) {
        return Weapons.DEFS[type] ?? Weapons.DEFS[Weapons.PULSE];
    }

    /**
     * Return true if the type string is a known weapon.
     * Port of Weapons::isValid().
     * NOTE: PHP used isset(self::DEFS[$type]) → JS: type in Weapons.DEFS
     */
    static isValid(type) {
        return type in Weapons.DEFS;
    }

    /**
     * Return the cooldown as a float in seconds.
     * Port of Weapons::cooldownSeconds().
     */
    static cooldownSeconds(type) {
        return Weapons.DEFS[type].cooldownMs / 1000.0;
    }
}
