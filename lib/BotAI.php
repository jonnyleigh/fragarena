<?php
require_once __DIR__ . '/GameState.php';
require_once __DIR__ . '/Weapons.php';

/**
 * BotAI — advanced state-machine bot controller.
 *
 * States:
 *   patrol     → random waypoint navigation
 *   chase      → approach nearest enemy
 *   attack     → maintain range, fire at target
 *   takeCover  → retreat to nearest shield face
 *   seekPickup → move to nearest weapon pickup
 *
 * Called once per server tick for every bot.
 */
class BotAI
{
    // Movement speeds (units/sec) per skill tier
    const SPEED = ['low' => 55.0, 'medium' => 75.0, 'high' => 100.0];

    // Aim accuracy (0–1, 1 = perfect lead) per skill tier
    const ACCURACY = ['low' => 0.35, 'medium' => 0.65, 'high' => 0.92];

    // Reaction distance — how close an enemy must be to trigger chase/attack
    const DETECT_RANGE = ['low' => 200.0, 'medium' => 280.0, 'high' => 350.0];

    // Preferred attack stand-off distance
    const ATTACK_RANGE = 120.0;

    // Health threshold to trigger cover-seeking (percent of max)
    const COVER_HP_THRESHOLD = 0.35;

    // ------------------------------------------------------------------

    public static function tick(int $bi, array &$state, float $dt): void
    {
        $bot   = &$state['players'][$bi];
        $now   = microtime(true);
        $skill = $bot['botSkill'] ?? 'medium';

        if ($bot['isDead']) return;

        // ------ Expire pickup weapon ------
        if ($bot['weaponExpiry'] !== null && $now > $bot['weaponExpiry']) {
            $bot['weapon']       = Weapons::PULSE;
            $bot['weaponExpiry'] = null;
            $bot['ammo']         = -1;
        }

        // ------ Choose state ------
        $state['players'][$bi]['botState'] = self::chooseState($bot, $state, $skill);
        $botState = $bot['botState'];

        // ------ Execute state ------
        switch ($botState) {
            case 'patrol':
                self::doPatrol($bi, $state, $dt, $skill);
                break;
            case 'chase':
            case 'attack':
                self::doAttack($bi, $state, $dt, $skill);
                break;
            case 'takeCover':
                self::doTakeCover($bi, $state, $dt, $skill);
                break;
            case 'seekPickup':
                self::doSeekPickup($bi, $state, $dt, $skill);
                break;
        }

        // Clamp to arena
        $bot['position'] = GameState::clampToArena($bot['position'], $state['arena']['size']);

        // Push bot out of any shield AABB it has clipped into
        self::resolveShieldCollisions($bi, $state);
    }

    // ------------------------------------------------------------------
    // State chooser
    // ------------------------------------------------------------------

    private static function chooseState(array $bot, array $state, string $skill): string
    {
        $hpRatio = $bot['health'] / $bot['maxHealth'];

        // Low health → cover
        if ($hpRatio < self::COVER_HP_THRESHOLD) {
            return 'takeCover';
        }

        // Nearby pickup worth taking?
        $nearestPickup = self::findNearestPickup($bot, $state);
        $nearestEnemy  = self::findNearestEnemy($bot, $state);
        $detectRange   = self::DETECT_RANGE[$skill];

        if ($nearestPickup !== null && $bot['weapon'] === Weapons::PULSE) {
            $pickupDist = self::dist($bot['position'], $nearestPickup['pos']);
            $enemyDist  = $nearestEnemy !== null
                            ? self::dist($bot['position'], $nearestEnemy['position'])
                            : PHP_FLOAT_MAX;
            if ($pickupDist < $enemyDist * 0.6) {
                return 'seekPickup';
            }
        }

        if ($nearestEnemy !== null) {
            $d = self::dist($bot['position'], $nearestEnemy['position']);
            if ($d < $detectRange) {
                return $d < self::ATTACK_RANGE * 1.8 ? 'attack' : 'chase';
            }
        }

        return 'patrol';
    }

    // ------------------------------------------------------------------
    // Patrol
    // ------------------------------------------------------------------

    private static function doPatrol(int $bi, array &$state, float $dt, string $skill): void
    {
        $bot  = &$state['players'][$bi];
        $half = $state['arena']['size'] / 2 - 50;
        $now  = microtime(true);

        // Pick a new waypoint if none or reached
        if (
            $bot['botWaypoint'] === null ||
            self::dist($bot['position'], $bot['botWaypoint']) < 20 ||
            $now > ($bot['botNextStateAt'] ?? 0)
        ) {
            $bot['botWaypoint'] = [
                'x' => rand(-$half, $half),
                'y' => rand(-$half, $half),
                'z' => rand(-$half, $half),
            ];
            $bot['botNextStateAt'] = $now + rand(5, 15);
        }

        self::moveToward($bi, $state, $bot['botWaypoint'], $dt, $skill);
        self::faceDirection($bi, $state, $bot['botWaypoint']);
    }

    // ------------------------------------------------------------------
    // Attack / chase
    // ------------------------------------------------------------------

    private static function doAttack(int $bi, array &$state, float $dt, string $skill): void
    {
        $bot    = &$state['players'][$bi];
        $enemy  = self::findNearestEnemy($bot, $state);
        if (!$enemy) { return; }

        $dist = self::dist($bot['position'], $enemy['position']);

        // Maintain attack range — close in if too far, back off if too close
        if ($dist > self::ATTACK_RANGE) {
            self::moveToward($bi, $state, $enemy['position'], $dt, $skill);
        } elseif ($dist < self::ATTACK_RANGE * 0.5) {
            // Back away
            $dir = self::normalise(self::vecSub($bot['position'], $enemy['position']));
            $spd = self::SPEED[$skill];
            $bot['position']['x'] += $dir['x'] * $spd * $dt;
            $bot['position']['y'] += $dir['y'] * $spd * $dt;
            $bot['position']['z'] += $dir['z'] * $spd * $dt;
        } else {
            // Strafe dodge — move perpendicular
            $now = microtime(true);
            if (($bot['botNextStateAt'] ?? 0) < $now) {
                $bot['botWaypoint']    = self::strafeTarget($bot, $enemy);
                $bot['botNextStateAt'] = $now + 1.2;
            }
            self::moveToward($bi, $state, $bot['botWaypoint'] ?? $enemy['position'], $dt, $skill);
        }

        self::faceDirection($bi, $state, $enemy['position']);

        // Try to fire
        self::tryFire($bi, $state, $enemy, $skill);
    }

    // ------------------------------------------------------------------
    // Take cover
    // ------------------------------------------------------------------

    private static function doTakeCover(int $bi, array &$state, float $dt, string $skill): void
    {
        $bot = &$state['players'][$bi];

        $shield = self::findNearestShield($bot, $state);
        if ($shield === null) {
            // No shields — just flee from nearest enemy
            $enemy = self::findNearestEnemy($bot, $state);
            if ($enemy) {
                $away = self::normalise(self::vecSub($bot['position'], $enemy['position']));
                $spd  = self::SPEED[$skill];
                $bot['position']['x'] += $away['x'] * $spd * $dt;
                $bot['position']['y'] += $away['y'] * $spd * $dt;
                $bot['position']['z'] += $away['z'] * $spd * $dt;
            }
            return;
        }

        // Move to a point just behind the shield (opposite side from nearest enemy)
        $enemy    = self::findNearestEnemy($bot, $state);
        $shieldPos = ['x' => $shield['x'], 'y' => $shield['y'], 'z' => $shield['z']];

        if ($enemy) {
            $awayFromEnemy = self::normalise(self::vecSub($shieldPos, $enemy['position']));
            $coverPoint    = [
                'x' => $shield['x'] + $awayFromEnemy['x'] * ($shield['w'] / 2 + 25),
                'y' => $shield['y'] + $awayFromEnemy['y'] * ($shield['h'] / 2 + 25),
                'z' => $shield['z'] + $awayFromEnemy['z'] * ($shield['d'] / 2 + 25),
            ];
        } else {
            $coverPoint = $shieldPos;
        }

        self::moveToward($bi, $state, $coverPoint, $dt, $skill);
        self::faceDirection($bi, $state, $coverPoint);

        // Fire if enemy is in sight while in cover
        if ($enemy) {
            self::tryFire($bi, $state, $enemy, $skill);
        }
    }

    // ------------------------------------------------------------------
    // Seek pickup
    // ------------------------------------------------------------------

    private static function doSeekPickup(int $bi, array &$state, float $dt, string $skill): void
    {
        $bot    = &$state['players'][$bi];
        $pickup = self::findNearestPickup($bot, $state);
        if (!$pickup) { return; }

        self::moveToward($bi, $state, $pickup['pos'], $dt, $skill);
        self::faceDirection($bi, $state, $pickup['pos']);

        // Check collection (close enough?)
        if (self::dist($bot['position'], $pickup['pos']) < 25) {
            // Queue a pickup action — GameTick will handle it
            $bot['pendingActions'][] = ['type' => 'pickup', 'pickupId' => $pickup['id']];
        }
    }

    // ------------------------------------------------------------------
    // Firing logic
    // ------------------------------------------------------------------

    private static function tryFire(int $bi, array &$state, array $enemy, string $skill): void
    {
        $bot = &$state['players'][$bi];
        $now = microtime(true);

        if ($now < $bot['canFireAt']) return;

        // Accuracy-based aim: lead the target with some error
        $accuracy = self::ACCURACY[$skill];
        $def      = Weapons::getDef($bot['weapon']);

        // Predict enemy position (lead targeting)
        $travelTime = self::dist($bot['position'], $enemy['position'])
                      / max(1, $def['bulletSpeed']);
        $predicted  = [
            'x' => $enemy['position']['x'],
            'y' => $enemy['position']['y'],
            'z' => $enemy['position']['z'],
        ];
        // Apply accuracy scatter
        $spread = (1.0 - $accuracy) * 0.3;  // max ~17.2° when accuracy=0
        $aimDir = self::normalise(self::vecSub($predicted, $bot['position']));
        $aimDir['x'] += (lcg_value() * 2 - 1) * $spread;
        $aimDir['y'] += (lcg_value() * 2 - 1) * $spread;
        $aimDir['z'] += (lcg_value() * 2 - 1) * $spread;
        $aimDir = self::normalise($aimDir);

        $bot['pendingActions'][] = [
            'type'   => 'fire',
            'dir'    => $aimDir,
        ];
        // canFireAt and ammo are managed by GameTick::spawnBullet / resolveBeam
        // after the action is processed — do NOT set them here or spawnBullet’s
        // cooldown guard will reject the action we just queued.
    }

    // ------------------------------------------------------------------
    // Movement helpers
    // ------------------------------------------------------------------

    private static function moveToward(int $bi, array &$state, array $target, float $dt, string $skill): void
    {
        $bot  = &$state['players'][$bi];
        $dir  = self::vecSub($target, $bot['position']);
        $dist = self::len($dir);
        if ($dist < 1.0) return;
        $dir = self::scale($dir, 1.0 / $dist);
        $spd = self::SPEED[$skill];
        $move = $spd * $dt;
        if ($move > $dist) $move = $dist;
        $bot['position']['x'] += $dir['x'] * $move;
        $bot['position']['y'] += $dir['y'] * $move;
        $bot['position']['z'] += $dir['z'] * $move;
    }

    private static function faceDirection(int $bi, array &$state, array $target): void
    {
        $bot = &$state['players'][$bi];
        $dir = self::normalise(self::vecSub($target, $bot['position']));
        // Store look direction as a simple forward vector; client renders from quaternion
        // We store a lookat quaternion derived from forward = dir, up = (0,1,0)
        $bot['rotation'] = self::lookRotation($dir, ['x'=>0,'y'=>1,'z'=>0]);
    }

    private static function strafeTarget(array $bot, array $enemy): array
    {
        $toEnemy = self::normalise(self::vecSub($enemy['position'], $bot['position']));
        // Strafe perpendicular (cross with up)
        $up    = ['x'=>0,'y'=>1,'z'=>0];
        $perp  = self::normalise(self::cross($toEnemy, $up));
        $side  = (rand(0, 1) ? 1 : -1) * 60;
        return [
            'x' => $bot['position']['x'] + $perp['x'] * $side,
            'y' => $bot['position']['y'],
            'z' => $bot['position']['z'] + $perp['z'] * $side,
        ];
    }

    // ------------------------------------------------------------------
    // Scene queries
    // ------------------------------------------------------------------

    private static function findNearestEnemy(array $bot, array $state): ?array
    {
        $best = null;
        $bestD = PHP_FLOAT_MAX;
        foreach ($state['players'] as $p) {
            if ($p['id'] === $bot['id'] || $p['isDead']) continue;
            $d = self::dist($bot['position'], $p['position']);
            if ($d < $bestD) { $bestD = $d; $best = $p; }
        }
        return $best;
    }

    private static function findNearestPickup(array $bot, array $state): ?array
    {
        $best = null;
        $bestD = PHP_FLOAT_MAX;
        foreach ($state['pickups'] as $pu) {
            $d = self::dist($bot['position'], $pu['pos']);
            if ($d < $bestD) { $bestD = $d; $best = $pu; }
        }
        return $best;
    }

    private static function findNearestShield(array $bot, array $state): ?array
    {
        $best = null;
        $bestD = PHP_FLOAT_MAX;
        foreach ($state['arena']['shields'] as $s) {
            $sPos = ['x' => $s['x'], 'y' => $s['y'], 'z' => $s['z']];
            $d = self::dist($bot['position'], $sPos);
            if ($d < $bestD) { $bestD = $d; $best = $s; }
        }
        return $best;
    }

    // ------------------------------------------------------------------
    // Shield collision pushout
    // ------------------------------------------------------------------

    private static function resolveShieldCollisions(int $bi, array &$state): void
    {
        $bot    = &$state['players'][$bi];
        $radius = GameState::PLAYER_RADIUS;

        foreach ($state['arena']['shields'] as $s) {
            $halfW = $s['w'] / 2 + $radius;
            $halfH = $s['h'] / 2 + $radius;
            $halfD = $s['d'] / 2 + $radius;

            $dx = $bot['position']['x'] - $s['x'];
            $dy = $bot['position']['y'] - $s['y'];
            $dz = $bot['position']['z'] - $s['z'];

            $absDx = abs($dx);
            $absDy = abs($dy);
            $absDz = abs($dz);

            if ($absDx < $halfW && $absDy < $halfH && $absDz < $halfD) {
                // Overlapping — push out along shortest axis
                $overlapX = $halfW - $absDx;
                $overlapY = $halfH - $absDy;
                $overlapZ = $halfD - $absDz;

                if ($overlapX <= $overlapY && $overlapX <= $overlapZ) {
                    $bot['position']['x'] += $dx >= 0 ? $overlapX : -$overlapX;
                } elseif ($overlapY <= $overlapX && $overlapY <= $overlapZ) {
                    $bot['position']['y'] += $dy >= 0 ? $overlapY : -$overlapY;
                } else {
                    $bot['position']['z'] += $dz >= 0 ? $overlapZ : -$overlapZ;
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Math helpers
    // ------------------------------------------------------------------

    private static function dist(array $a, array $b): float
    {
        $dx = $a['x']-$b['x']; $dy = $a['y']-$b['y']; $dz = $a['z']-$b['z'];
        return sqrt($dx*$dx + $dy*$dy + $dz*$dz);
    }

    private static function len(array $v): float
    {
        return sqrt($v['x']*$v['x'] + $v['y']*$v['y'] + $v['z']*$v['z']);
    }

    private static function normalise(array $v): array
    {
        $l = self::len($v);
        if ($l < 1e-6) return ['x'=>0,'y'=>0,'z'=>1];
        return ['x'=>$v['x']/$l, 'y'=>$v['y']/$l, 'z'=>$v['z']/$l];
    }

    private static function vecSub(array $a, array $b): array
    {
        return ['x'=>$a['x']-$b['x'], 'y'=>$a['y']-$b['y'], 'z'=>$a['z']-$b['z']];
    }

    private static function scale(array $v, float $s): array
    {
        return ['x'=>$v['x']*$s, 'y'=>$v['y']*$s, 'z'=>$v['z']*$s];
    }

    private static function cross(array $a, array $b): array
    {
        return [
            'x' => $a['y']*$b['z'] - $a['z']*$b['y'],
            'y' => $a['z']*$b['x'] - $a['x']*$b['z'],
            'z' => $a['x']*$b['y'] - $a['y']*$b['x'],
        ];
    }

    private static function dot(array $a, array $b): float
    {
        return $a['x']*$b['x'] + $a['y']*$b['y'] + $a['z']*$b['z'];
    }

    /**
     * Build a look-at quaternion from forward + up vectors.
     * Returns ['x','y','z','w'] quaternion.
     */
    private static function lookRotation(array $forward, array $up): array
    {
        $f = self::normalise($forward);
        $r = self::normalise(self::cross($up, $f));
        $u = self::cross($f, $r);

        $m00=$r['x']; $m01=$r['y']; $m02=$r['z'];
        $m10=$u['x']; $m11=$u['y']; $m12=$u['z'];
        $m20=$f['x']; $m21=$f['y']; $m22=$f['z'];

        $trace = $m00 + $m11 + $m22;
        if ($trace > 0) {
            $s = 0.5 / sqrt($trace + 1.0);
            return ['w' => 0.25/$s, 'x'=>($m21-$m12)*$s, 'y'=>($m02-$m20)*$s, 'z'=>($m10-$m01)*$s];
        } elseif ($m00 > $m11 && $m00 > $m22) {
            $s = 2.0 * sqrt(1.0 + $m00 - $m11 - $m22);
            return ['w'=>($m21-$m12)/$s, 'x'=>0.25*$s, 'y'=>($m01+$m10)/$s, 'z'=>($m02+$m20)/$s];
        } elseif ($m11 > $m22) {
            $s = 2.0 * sqrt(1.0 + $m11 - $m00 - $m22);
            return ['w'=>($m02-$m20)/$s, 'x'=>($m01+$m10)/$s, 'y'=>0.25*$s, 'z'=>($m12+$m21)/$s];
        } else {
            $s = 2.0 * sqrt(1.0 + $m22 - $m00 - $m11);
            return ['w'=>($m10-$m01)/$s, 'x'=>($m02+$m20)/$s, 'y'=>($m12+$m21)/$s, 'z'=>0.25*$s];
        }
    }
}
