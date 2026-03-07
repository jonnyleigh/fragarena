<?php
/**
 * Weapon definitions for FragArena.
 * All values are kept in sync with js/weapons.js.
 *
 * Bullet speed / TTL combine to give effective range:
 *   Pulse  : 300 u/s × 2.0 s = 600 u
 *   Rail   : 800 u/s × 1.5 s = 1200 u
 *   Missile: 160 u/s × 8.0 s = 1280 u (but homing)
 *   Instagib: instant raycast
 */

class Weapons
{
    // ---------------------------------------------------------------
    // Weapon type identifiers
    // ---------------------------------------------------------------
    const PULSE   = 'pulse';
    const INSTAGIB = 'instagib';
    const RAIL    = 'rail';
    const MISSILE = 'missile';

    // Pickup weapon types (array for convenience)
    const PICKUP_TYPES = [self::INSTAGIB, self::RAIL, self::MISSILE];

    // ---------------------------------------------------------------
    // Definitions keyed by weapon type
    // ---------------------------------------------------------------
    const DEFS = [
        self::PULSE => [
            'label'        => 'Pulse Laser',
            'isPickup'     => false,
            'ammo'         => -1,           // -1 = unlimited
            'cooldownMs'   => 400,          // ms between shots
            'damage'       => 30,
            'bulletSpeed'  => 400.0,        // units per second
            'bulletRadius' => 2.0,
            'bulletTTL'    => 2.0,          // seconds of flight
            'isRaycast'    => false,
            'isHoming'     => false,
            'pickupDuration' => 0,          // seconds held (0 = permanent)
        ],
        self::INSTAGIB => [
            'label'        => 'Instagib Laser',
            'isPickup'     => true,
            'ammo'         => -1,
            'cooldownMs'   => 3000,
            'damage'       => 200,
            'bulletSpeed'  => 0.0,          // instant
            'bulletRadius' => 0.0,
            'bulletTTL'    => 0.25,         // visual fade only
            'isRaycast'    => true,
            'isHoming'     => false,
            'pickupDuration' => 90,
        ],
        self::RAIL => [
            'label'        => 'Rail Gun',
            'isPickup'     => true,
            'ammo'         => -1,
            'cooldownMs'   => 150,
            'damage'       => 15,
            'bulletSpeed'  => 800.0,
            'bulletRadius' => 1.5,
            'bulletTTL'    => 1.5,
            'isRaycast'    => false,
            'isHoming'     => false,
            'pickupDuration' => 90,
        ],
        self::MISSILE => [
            'label'        => 'Missiles',
            'isPickup'     => true,
            'ammo'         => 6,
            'cooldownMs'   => 2000,
            'damage'       => 60,
            'bulletSpeed'  => 160.0,
            'bulletRadius' => 5.0,
            'bulletTTL'    => 8.0,
            'isRaycast'    => false,
            'isHoming'     => true,
            'homingTurnRateDeg' => 90.0,    // max degrees/sec the missile can steer
            'pickupDuration' => 90,
        ],
    ];

    // ---------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------

    public static function getDef(string $type): array
    {
        return self::DEFS[$type] ?? self::DEFS[self::PULSE];
    }

    public static function isValid(string $type): bool
    {
        return isset(self::DEFS[$type]);
    }

    public static function cooldownSeconds(string $type): float
    {
        return self::DEFS[$type]['cooldownMs'] / 1000.0;
    }
}
