<?php
require_once __DIR__ . '/GameState.php';
require_once __DIR__ . '/Weapons.php';
require_once __DIR__ . '/BotAI.php';

/**
 * GameTick — server-side game simulation.
 *
 * runTick() is called from api/state.php when ≥50 ms has elapsed since lastTick.
 *
 * Order of operations per tick:
 *   1. Expire stale weapon pickups (weapon held > 90s)
 *   2. Process queued player actions (fire, pickup)
 *   3. Run bot AI (move + generate actions)
 *   4. Advance bullet positions; apply homing on missiles
 *   5. Bullet–shield AABB collision
 *   6. Bullet–player sphere collision
 *   7. Kill processing, score update, respawn scheduling
 *   8. Execute pending respawns
 *   9. Ensure pickup count is maintained (spawn replacements)
 *  10. Kick bots that have been alive > 20 min; spawn replacements
 *  11. Update player timeInGame
 */
class GameTick
{
    const TICK_INTERVAL      = 0.05;   // 50 ms minimum between ticks
    const DISCONNECT_TIMEOUT = 30.0;   // seconds without input before a human is removed

    public static function runTick(array &$state, float $now): void
    {
        $prev = (float)($state['lastTick'] ?? 0.0);
        $dt   = min($now - $prev, 0.25);  // cap at 250 ms to avoid spiral-of-death
        $state['lastTick'] = $now;

        // 0. Drop timed-out human players
        self::checkDisconnects($state, $now);

        // 1. Expire held weapons
        self::expireWeapons($state, $now);

        // 2. Process player actions (humans have queued actions via api/input)
        //    We handle human fire here; bot fire is also via pendingActions
        self::processActions($state, $now, $dt);

        // 3. Bot AI
        foreach ($state['players'] as $i => $p) {
            if ($p['isBot'] && !$p['isDead']) {
                BotAI::tick($i, $state, $dt);
                // Process any actions the bot just generated
                self::processActions($state, $now, $dt, $i);
            }
        }

        // 4. Advance bullets
        self::advanceBullets($state, $dt, $now);

        // 5+6. Collisions (swept segment tests so fast bullets don't tunnel)
        self::checkBulletCollisions($state, $dt, $now);

        // 5b. Auto-collect pickups for nearby human players
        self::checkPickupProximity($state);

        // 7. Kill processing
        self::processDeaths($state, $now);

        // 8. Respawns
        self::processRespawns($state, $now);

        // 9. Pickup count
        self::maintainPickups($state);

        // 10. Bot rotation (kick old bots, replace with fresh ones)
        self::rotateBots($state, $now);

        // 11. Time in game
        foreach ($state['players'] as &$p) {
            if (!$p['isDead']) {
                $p['timeInGame'] = ($p['timeInGame'] ?? 0) + $dt;
            }
        }
        unset($p);
    }

    // ------------------------------------------------------------------
    // 0. Disconnect detection
    // ------------------------------------------------------------------

    private static function checkDisconnects(array &$state, float $now): void
    {
        $timedOut = [];
        foreach ($state['players'] as $i => $p) {
            if ($p['isBot']) continue;
            $idle = $now - (float)($p['lastInputAt'] ?? $now);
            if ($idle > self::DISCONNECT_TIMEOUT) {
                $timedOut[] = $i;
            }
        }
        // Remove in reverse order so indices stay valid
        foreach (array_reverse($timedOut) as $i) {
            $handle = $state['players'][$i]['handle'];
            GameState::addChat($state, 'System', $handle . ' disconnected.');
            array_splice($state['players'], $i, 1);
        }
        // Fill empty slots with bots
        $botsNeeded = GameState::MAX_PLAYERS - count($state['players']);
        for ($b = 0; $b < $botsNeeded; $b++) {
            $state['players'][] = GameState::makeBotPlayer($state);
        }
    }

    // ------------------------------------------------------------------
    // 1. Expire held weapons
    // ------------------------------------------------------------------

    private static function expireWeapons(array &$state, float $now): void
    {
        foreach ($state['players'] as &$p) {
            if ($p['weaponExpiry'] !== null && $now >= $p['weaponExpiry']) {
                $p['weapon']      = Weapons::PULSE;
                $p['weaponExpiry']= null;
                $p['ammo']        = -1;
            }
        }
        unset($p);
    }

    // ------------------------------------------------------------------
    // 2. Process queued actions
    // ------------------------------------------------------------------

    private static function processActions(array &$state, float $now, float $dt, int $onlyIndex = -1): void
    {
        $indices = $onlyIndex >= 0
            ? [$onlyIndex]
            : array_keys($state['players']);

        foreach ($indices as $i) {
            $p = &$state['players'][$i];
            if ($p['isDead'] || empty($p['pendingActions'])) continue;

            foreach ($p['pendingActions'] as $action) {
                switch ($action['type'] ?? '') {
                    case 'fire':
                        self::spawnBullet($state, $i, $action, $now);
                        break;
                    case 'beam':
                        self::resolveBeam($state, $i, $action, $now);
                        break;
                    case 'pickup':
                        self::resolvePickup($state, $i, $action['pickupId'] ?? '');
                        break;
                }
            }
            $p['pendingActions'] = [];
        }
        unset($p);
    }

    // ------------------------------------------------------------------
    // Bullet spawning
    // ------------------------------------------------------------------

    private static function spawnBullet(array &$state, int $pi, array $action, float $now): void
    {
        $p   = &$state['players'][$pi];
        $def = Weapons::getDef($p['weapon']);

        if ($def['isRaycast']) {
            // Beam is handled separately
            self::resolveBeam($state, $pi, $action, $now);
            return;
        }

        if ($now < ($p['canFireAt'] ?? 0)) return;

        $dir = $action['dir'] ?? ['x'=>0,'y'=>0,'z'=>1];
        $spd = $def['bulletSpeed'];

        $state['bullets'][] = [
            'id'      => GameState::uuid(),
            'ownerId' => $p['id'],
            'type'    => $p['weapon'],
            'x'       => $p['position']['x'],
            'y'       => $p['position']['y'],
            'z'       => $p['position']['z'],
            'vx'      => $dir['x'] * $spd,
            'vy'      => $dir['y'] * $spd,
            'vz'      => $dir['z'] * $spd,
            'r'       => $def['bulletRadius'],
            'damage'  => $def['damage'],
            'expiry'  => $now + $def['bulletTTL'],
            'isHoming'=> $def['isHoming'],
        ];

        $p['canFireAt'] = $now + Weapons::cooldownSeconds($p['weapon']);

        // Ammo management
        if ($def['ammo'] > 0 && $p['ammo'] > 0) {
            $p['ammo']--;
            if ($p['ammo'] <= 0) {
                $p['weapon']       = Weapons::PULSE;
                $p['weaponExpiry'] = null;
                $p['ammo']         = -1;
            }
        }
    }

    private static function resolveBeam(array &$state, int $pi, array $action, float $now): void
    {
        $p = &$state['players'][$pi];
        if ($now < ($p['canFireAt'] ?? 0)) return;

        $def     = Weapons::getDef($p['weapon']);
        $origin  = $p['position'];
        $dir     = $action['dir'] ?? ['x'=>0,'y'=>0,'z'=>1];
        $maxDist = $state['arena']['size'] * 1.5;

        // Cast vs shields first, find minimum distance
        $hitDist = $maxDist;

        foreach ($state['arena']['shields'] as $s) {
            $d = self::rayBoxIntersect($origin, $dir, $s);
            if ($d !== null && $d < $hitDist) {
                $hitDist = $d;
            }
        }

        // Cast vs players
        $hitPlayer = null;
        foreach ($state['players'] as $j => $target) {
            if ($target['id'] === $p['id'] || $target['isDead']) continue;
            $d = self::raySphereIntersect($origin, $dir, $target['position'], GameState::PLAYER_RADIUS);
            if ($d !== null && $d < $hitDist) {
                $hitDist   = $d;
                $hitPlayer = $j;
            }
        }

        // Store beam event for clients to render
        $state['beams'][] = [
            'id'      => GameState::uuid(),
            'ownerId' => $p['id'],
            'ox'      => $origin['x'], 'oy' => $origin['y'], 'oz' => $origin['z'],
            'dx'      => $dir['x'],    'dy' => $dir['y'],    'dz' => $dir['z'],
            'dist'    => $hitDist,
            'expiry'  => $now + 0.25,
        ];

        if ($hitPlayer !== null) {
            self::damagePlayer($state, $hitPlayer, $def['damage'], $pi);
        }

        $p['canFireAt'] = $now + Weapons::cooldownSeconds($p['weapon']);
    }

    // ------------------------------------------------------------------
    // Pickup resolution
    // ------------------------------------------------------------------

    private static function resolvePickup(array &$state, int $pi, string $pickupId): void
    {
        if ($pickupId === '') return;

        $p = &$state['players'][$pi];

        foreach ($state['pickups'] as $idx => $pu) {
            if ($pu['id'] !== $pickupId) continue;

            // Verify the player is close enough (server-side sanity check)
            $dx = $p['position']['x'] - $pu['pos']['x'];
            $dy = $p['position']['y'] - $pu['pos']['y'];
            $dz = $p['position']['z'] - $pu['pos']['z'];
            $dist = sqrt($dx*$dx + $dy*$dy + $dz*$dz);

            if ($dist > 60) return;  // too far — reject

            $def = Weapons::getDef($pu['type']);
            $p['weapon']       = $pu['type'];
            $p['ammo']         = $def['ammo'];
            $p['weaponExpiry'] = microtime(true) + $def['pickupDuration'];
            $p['canFireAt']    = 0;

            // Remove the pickup; GameTick::maintainPickups() will spawn a replacement
            array_splice($state['pickups'], $idx, 1);
            return;
        }
    }

    // ------------------------------------------------------------------
    // 4. Advance bullets
    // ------------------------------------------------------------------

    private static function advanceBullets(array &$state, float $dt, float $now): void
    {
        $halfArena = $state['arena']['size'] / 2;
        $alive     = [];

        // Expire old beams
        $state['beams'] = array_values(
            array_filter($state['beams'] ?? [], fn($b) => $b['expiry'] > $now)
        );

        foreach ($state['bullets'] as $b) {
            if ($b['expiry'] <= $now) continue;

            // Homing (missiles) — steer toward nearest enemy of owner
            if ($b['isHoming']) {
                $b = self::applyHoming($b, $state, $dt);
            }

            $b['x'] += $b['vx'] * $dt;
            $b['y'] += $b['vy'] * $dt;
            $b['z'] += $b['vz'] * $dt;

            // Out of bounds check
            if (
                abs($b['x']) > $halfArena ||
                abs($b['y']) > $halfArena ||
                abs($b['z']) > $halfArena
            ) continue;

            $alive[] = $b;
        }

        $state['bullets'] = array_values($alive);
    }

    private static function applyHoming(array $b, array $state, float $dt): array
    {
        // Find nearest enemy of the shooter
        $target = null;
        $bestD  = PHP_FLOAT_MAX;
        foreach ($state['players'] as $p) {
            if ($p['id'] === $b['ownerId'] || $p['isDead']) continue;
            $dx = $p['position']['x'] - $b['x'];
            $dy = $p['position']['y'] - $b['y'];
            $dz = $p['position']['z'] - $b['z'];
            $d  = sqrt($dx*$dx + $dy*$dy + $dz*$dz);
            if ($d < $bestD) { $bestD = $d; $target = $p; }
        }
        if (!$target) return $b;

        $def    = Weapons::getDef(Weapons::MISSILE);
        $maxTurn = $def['homingTurnRateDeg'] * M_PI / 180.0; // rad/s
        $spd    = sqrt($b['vx']*$b['vx'] + $b['vy']*$b['vy'] + $b['vz']*$b['vz']);

        $curDir = ['x'=>$b['vx']/$spd, 'y'=>$b['vy']/$spd, 'z'=>$b['vz']/$spd];
        $toTarget = [
            'x' => $target['position']['x'] - $b['x'],
            'y' => $target['position']['y'] - $b['y'],
            'z' => $target['position']['z'] - $b['z'],
        ];
        $tLen = sqrt($toTarget['x']**2 + $toTarget['y']**2 + $toTarget['z']**2);
        if ($tLen < 1) return $b;
        $desDir = ['x'=>$toTarget['x']/$tLen, 'y'=>$toTarget['y']/$tLen, 'z'=>$toTarget['z']/$tLen];

        // Slerp-like: rotate curDir toward desDir by at most maxTurn*dt radians
        $cosA = min(1, max(-1, $curDir['x']*$desDir['x'] + $curDir['y']*$desDir['y'] + $curDir['z']*$desDir['z']));
        $angle = acos($cosA);
        $t = $angle > 1e-6 ? min(1.0, $maxTurn * $dt / $angle) : 1.0;
        $newDir = [
            'x' => $curDir['x'] + ($desDir['x'] - $curDir['x']) * $t,
            'y' => $curDir['y'] + ($desDir['y'] - $curDir['y']) * $t,
            'z' => $curDir['z'] + ($desDir['z'] - $curDir['z']) * $t,
        ];
        $nl = sqrt($newDir['x']**2 + $newDir['y']**2 + $newDir['z']**2);
        if ($nl > 1e-6) {
            $b['vx'] = $newDir['x']/$nl * $spd;
            $b['vy'] = $newDir['y']/$nl * $spd;
            $b['vz'] = $newDir['z']/$nl * $spd;
        }
        return $b;
    }

    // ------------------------------------------------------------------
    // 5+6. Bullet collision
    // ------------------------------------------------------------------

    private static function checkBulletCollisions(array &$state, float $dt, float $now): void
    {
        $toRemove = [];

        foreach ($state['bullets'] as $bi => $b) {
            $hit = false;
            $br  = (float)($b['r'] ?? 2.0);

            // Compute segment start — where the bullet was at the START of this tick
            $px = $b['x'] - $b['vx'] * $dt;
            $py = $b['y'] - $b['vy'] * $dt;
            $pz = $b['z'] - $b['vz'] * $dt;

            // Find the earliest shield hit along the bullet segment
            $shieldT = PHP_FLOAT_MAX;
            foreach ($state['arena']['shields'] as $s) {
                $t = self::segmentBoxIntersectT(
                    $px, $py, $pz, $b['x'], $b['y'], $b['z'], $br,
                    $s['x'] - $s['w']/2, $s['y'] - $s['h']/2, $s['z'] - $s['d']/2,
                    $s['x'] + $s['w']/2, $s['y'] + $s['h']/2, $s['z'] + $s['d']/2
                );
                if ($t !== null && $t < $shieldT) {
                    $shieldT = $t;
                    $hit = true;
                }
            }

            // Player sphere — only register hit if player is reached before any shield
            foreach ($state['players'] as $pi => $p) {
                if ($p['id'] === $b['ownerId'] || $p['isDead']) continue;
                $r = GameState::PLAYER_RADIUS + $br;
                $t = self::segmentSphereIntersectT(
                    $px, $py, $pz, $b['x'], $b['y'], $b['z'],
                    $p['position']['x'], $p['position']['y'], $p['position']['z'], $r
                );
                if ($t !== null && $t < $shieldT) {
                    $shooterIndex = GameState::findPlayerIndex($state, $b['ownerId']);
                    self::damagePlayer($state, $pi, $b['damage'], $shooterIndex);
                    $hit = true;
                    break;
                }
            }

            if ($hit) $toRemove[] = $bi;
        }

        foreach (array_reverse($toRemove) as $idx) {
            array_splice($state['bullets'], $idx, 1);
        }
    }

    // ------------------------------------------------------------------
    // 5b. Proximity pickup for human players
    // ------------------------------------------------------------------

    private static function checkPickupProximity(array &$state): void
    {
        $radius = 45.0; // collection radius in units
        $r2     = $radius * $radius;

        foreach ($state['players'] as $pi => &$p) {
            if ($p['isDead'] || $p['isBot'] || $p['weapon'] !== Weapons::PULSE) continue;

            foreach ($state['pickups'] as $idx => $pu) {
                $dx = $p['position']['x'] - $pu['pos']['x'];
                $dy = $p['position']['y'] - $pu['pos']['y'];
                $dz = $p['position']['z'] - $pu['pos']['z'];
                if ($dx*$dx + $dy*$dy + $dz*$dz <= $r2) {
                    $def = Weapons::getDef($pu['type']);
                    $p['weapon']       = $pu['type'];
                    $p['weaponExpiry'] = microtime(true) + $def['pickupDuration'];
                    $p['ammo']         = $def['ammo'];
                    array_splice($state['pickups'], $idx, 1);
                    break; // one pickup per player per tick
                }
            }
        }
        unset($p);
    }

    // ------------------------------------------------------------------
    // Damage helper
    // ------------------------------------------------------------------

    private static function damagePlayer(array &$state, int $pi, int $damage, int $shooterIndex): void
    {
        $state['players'][$pi]['health'] -= $damage;
        if ($state['players'][$pi]['health'] < 0) {
            $state['players'][$pi]['health'] = 0;
        }
        if ($shooterIndex >= 0) {
            $state['players'][$pi]['lastDamagedBy'] = $state['players'][$shooterIndex]['id'];
        }
    }

    // ------------------------------------------------------------------
    // 7. Kill processing
    // ------------------------------------------------------------------

    private static function processDeaths(array &$state, float $now): void
    {
        foreach ($state['players'] as $pi => &$p) {
            if ($p['isDead'] || $p['health'] > 0) continue;

            $p['isDead']    = true;
            $p['respawnAt'] = $now + GameState::RESPAWN_DELAY;
            $p['deaths']    = ($p['deaths'] ?? 0) + 1;

            // Find who killed them (most recent bullet owner still in state)
            // Award kill to attacker
            // We rely on bullet hit doing damagePlayer to identify killer — but
            // we don't have direct kill credit here. Track via lastDamagedBy.
            if (!empty($p['lastDamagedBy'])) {
                $killerIdx = GameState::findPlayerIndex($state, $p['lastDamagedBy']);
                if ($killerIdx >= 0) {
                    $state['players'][$killerIdx]['score']  = ($state['players'][$killerIdx]['score'] ?? 0) + 1;
                    $state['players'][$killerIdx]['kills']  = ($state['players'][$killerIdx]['kills'] ?? 0) + 1;
                    GameState::addChat($state, 'System',
                        $state['players'][$killerIdx]['handle'] . ' fragged ' . $p['handle']);
                }
            }

            // Drop weapon pickup on death
            if ($p['weapon'] !== Weapons::PULSE) {
                $state['pickups'][] = [
                    'id'  => GameState::uuid(),
                    'type'=> $p['weapon'],
                    'pos' => $p['position'],
                ];
            }

            // Reset weapon
            $p['weapon']      = Weapons::PULSE;
            $p['weaponExpiry'] = null;
            $p['ammo']        = -1;
        }
        unset($p);
    }

    // ------------------------------------------------------------------
    // 8. Respawns
    // ------------------------------------------------------------------

    private static function processRespawns(array &$state, float $now): void
    {
        foreach ($state['players'] as &$p) {
            if (!$p['isDead'] || $p['respawnAt'] === null) continue;
            if ($now < $p['respawnAt']) continue;

            $p['isDead']    = false;
            $p['respawnAt'] = null;
            $p['health']    = $p['maxHealth'];
            $p['position']  = GameState::randomFreePosition($state);
        }
        unset($p);
    }

    // ------------------------------------------------------------------
    // 9. Pickup maintenance
    // ------------------------------------------------------------------

    private static function maintainPickups(array &$state): void
    {
        $types   = Weapons::PICKUP_TYPES;
        $present = array_column($state['pickups'], 'type');

        // Cap total pickups
        if (count($state['pickups']) >= GameState::MAX_PICKUPS) return;

        // Ensure at least one of each type exists
        foreach ($types as $type) {
            if (!in_array($type, $present, true)) {
                $state['pickups'][] = GameState::makePickup($type, $state);
                $present[] = $type;
                if (count($state['pickups']) >= GameState::MAX_PICKUPS) break;
            }
        }
    }

    // ------------------------------------------------------------------
    // 10. Bot rotation
    // ------------------------------------------------------------------

    private static function rotateBots(array &$state, float $now): void
    {
        $total = count($state['players']);

        foreach ($state['players'] as $i => $p) {
            if (!$p['isBot']) continue;
            if ($now - $p['botJoinedAt'] >= GameState::BOT_LIFETIME) {
                GameState::addChat($state, 'System', $p['handle'] . ' (bot) rotated out.');
                array_splice($state['players'], $i, 1);
                // Spawn replacement
                $state['players'][] = GameState::makeBotPlayer($state);
                break;  // Only rotate one per tick to avoid index chaos
            }
        }

        // Ensure bot count fills arena
        $humanCount = GameState::countHumans($state);
        $current    = count($state['players']);
        $needed     = GameState::MAX_PLAYERS - $humanCount;
        $bots       = GameState::countBots($state);

        while ($bots < $needed && $current < GameState::MAX_PLAYERS) {
            $state['players'][] = GameState::makeBotPlayer($state);
            $bots++;
            $current++;
        }
    }

    // ------------------------------------------------------------------
    // Swept collision helpers
    // ------------------------------------------------------------------

    /**
     * Segment AB vs sphere (centre C, radius r).
     * Returns true if any part of the segment is inside the sphere.
     */
    private static function segmentSphereIntersect(
        float $ax, float $ay, float $az,
        float $bx, float $by, float $bz,
        float $cx, float $cy, float $cz,
        float $r
    ): bool {
        return self::segmentSphereIntersectT($ax, $ay, $az, $bx, $by, $bz, $cx, $cy, $cz, $r) !== null;
    }

    /**
     * Segment AB vs sphere (centre C, radius r).
     * Returns the parametric entry t in [0,1] of the first intersection, or null.
     */
    private static function segmentSphereIntersectT(
        float $ax, float $ay, float $az,
        float $bx, float $by, float $bz,
        float $cx, float $cy, float $cz,
        float $r
    ): ?float {
        $dx = $bx - $ax; $dy = $by - $ay; $dz = $bz - $az;
        $fx = $ax - $cx; $fy = $ay - $cy; $fz = $az - $cz;
        $a  = $dx*$dx + $dy*$dy + $dz*$dz;
        if ($a < 1e-12) {
            return ($fx*$fx + $fy*$fy + $fz*$fz) < $r*$r ? 0.0 : null;
        }
        $b    = 2.0 * ($fx*$dx + $fy*$dy + $fz*$dz);
        $c    = ($fx*$fx + $fy*$fy + $fz*$fz) - $r*$r;
        $disc = $b*$b - 4.0*$a*$c;
        if ($disc < 0) return null;
        $sq   = sqrt($disc);
        $t0   = (-$b - $sq) / (2.0 * $a);
        $t1   = (-$b + $sq) / (2.0 * $a);
        if ($t1 < 0.0 || $t0 > 1.0) return null;
        return max(0.0, $t0); // clamp to segment start; 0 means bullet starts inside sphere
    }

    /**
     * Segment AB vs AABB (min/max corners), with the box expanded by $br on all sides.
     * Uses the slab method.
     */
    private static function segmentBoxIntersect(
        float $ax, float $ay, float $az,
        float $bx, float $by, float $bz,
        float $br,
        float $minX, float $minY, float $minZ,
        float $maxX, float $maxY, float $maxZ
    ): bool {
        return self::segmentBoxIntersectT($ax, $ay, $az, $bx, $by, $bz, $br,
            $minX, $minY, $minZ, $maxX, $maxY, $maxZ) !== null;
    }

    /**
     * Segment AB vs AABB (min/max corners), with the box expanded by $br on all sides.
     * Returns the parametric entry t in [0,1], or null if no intersection.
     * Uses the slab method.
     */
    private static function segmentBoxIntersectT(
        float $ax, float $ay, float $az,
        float $bx, float $by, float $bz,
        float $br,
        float $minX, float $minY, float $minZ,
        float $maxX, float $maxY, float $maxZ
    ): ?float {
        $minX -= $br; $minY -= $br; $minZ -= $br;
        $maxX += $br; $maxY += $br; $maxZ += $br;

        $dx = $bx - $ax; $dy = $by - $ay; $dz = $bz - $az;
        $tMin = 0.0; $tMax = 1.0;

        foreach ([
            [$dx, $ax, $minX, $maxX],
            [$dy, $ay, $minY, $maxY],
            [$dz, $az, $minZ, $maxZ],
        ] as [$d, $o, $mn, $mx]) {
            if (abs($d) < 1e-12) {
                if ($o < $mn || $o > $mx) return null;
            } else {
                $t1 = ($mn - $o) / $d;
                $t2 = ($mx - $o) / $d;
                if ($t1 > $t2) [$t1, $t2] = [$t2, $t1];
                $tMin = max($tMin, $t1);
                $tMax = min($tMax, $t2);
                if ($tMin > $tMax) return null;
            }
        }
        return $tMin;
    }

    // ------------------------------------------------------------------
    // Ray helpers (for beam laser)
    // ------------------------------------------------------------------

    /**
     * Ray–AABB intersection. Returns distance t or null.
     * Shield is defined as centre + half-extents.
     */
    public static function rayBoxIntersect(array $origin, array $dir, array $shield): ?float
    {
        $hx = $shield['w'] / 2; $hy = $shield['h'] / 2; $hz = $shield['d'] / 2;
        $minX = $shield['x'] - $hx; $maxX = $shield['x'] + $hx;
        $minY = $shield['y'] - $hy; $maxY = $shield['y'] + $hy;
        $minZ = $shield['z'] - $hz; $maxZ = $shield['z'] + $hz;

        // If the shooter's origin is inside the shield, don't block — avoids false
        // positives when the server position clips into a shield due to lag/desync.
        if ($origin['x'] >= $minX && $origin['x'] <= $maxX &&
            $origin['y'] >= $minY && $origin['y'] <= $maxY &&
            $origin['z'] >= $minZ && $origin['z'] <= $maxZ) {
            return null;
        }

        $tMin = PHP_FLOAT_EPSILON;
        $tMax = PHP_FLOAT_MAX;

        foreach (['x','y','z'] as $ax) {
            $mn = $ax === 'x' ? $minX : ($ax === 'y' ? $minY : $minZ);
            $mx = $ax === 'x' ? $maxX : ($ax === 'y' ? $maxY : $maxZ);
            $d  = $dir[$ax];
            $o  = $origin[$ax];
            if (abs($d) < 1e-8) {
                if ($o < $mn || $o > $mx) return null;
            } else {
                $t1 = ($mn - $o) / $d;
                $t2 = ($mx - $o) / $d;
                if ($t1 > $t2) [$t1,$t2] = [$t2,$t1];
                $tMin = max($tMin, $t1);
                $tMax = min($tMax, $t2);
                if ($tMin > $tMax) return null;
            }
        }
        return $tMin;
    }

    /**
     * Ray–sphere intersection. Returns distance t or null.
     */
    public static function raySphereIntersect(array $origin, array $dir, array $centre, float $r): ?float
    {
        $oc = ['x'=>$origin['x']-$centre['x'], 'y'=>$origin['y']-$centre['y'], 'z'=>$origin['z']-$centre['z']];
        $a  = $dir['x']**2 + $dir['y']**2 + $dir['z']**2;
        $b  = 2*($oc['x']*$dir['x'] + $oc['y']*$dir['y'] + $oc['z']*$dir['z']);
        $c  = ($oc['x']**2 + $oc['y']**2 + $oc['z']**2) - $r*$r;
        $d  = $b*$b - 4*$a*$c;
        if ($d < 0) return null;
        $t  = (-$b - sqrt($d)) / (2*$a);
        return $t > 1e-4 ? $t : null;
    }
}
