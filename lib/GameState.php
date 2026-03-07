<?php
require_once __DIR__ . '/Weapons.php';

/**
 * GameState — loads / saves the JSON game state with flock() locking.
 *
 * Schema
 * ------
 * {
 *   "arena"  : { "size": 500, "shields": [ {id,x,y,z,w,h,d}, … ] },
 *   "players": [ { … player record … }, … ],
 *   "bullets": [ { … bullet record … }, … ],
 *   "pickups": [ { … pickup record … }, … ],
 *   "chat"   : [ { "handle", "message", "time" }, … ],
 *   "lastTick": 0.0
 * }
 */
class GameState
{
    const FILE       = __DIR__ . '/../data/game_state.json';
    const MAX_CHAT   = 20;
    const ARENA_SIZE = 1000;
    const MAX_PLAYERS = 6;
    const MAX_PICKUPS = 5;       // max concurrent weapon pickups in arena
    const PLAYER_RADIUS = 15.0;  // sphere radius for collision
    const RESPAWN_DELAY = 3.0;   // seconds before re-entering arena
    const BOT_LIFETIME  = 1200;  // 20 min — bots are kicked after this

    // ------------------------------------------------------------------
    // Load + Save
    // ------------------------------------------------------------------

    /**
     * Opens the state file with an exclusive lock.
     * Returns [ $state, $fp ] — caller MUST call save($state, $fp) or
     * just flock($fp, LOCK_UN) + fclose($fp) to release.
     */
    public static function loadLocked(): array
    {
        $file = self::FILE;

        // Ensure data dir exists
        if (!is_dir(dirname($file))) {
            mkdir(dirname($file), 0755, true);
        }

        $fp = fopen($file, 'c+');
        if (!$fp) {
            throw new \RuntimeException("Cannot open state file: $file");
        }
        flock($fp, LOCK_EX);

        $size = filesize($file);
        $raw  = $size > 0 ? fread($fp, $size) : '';
        $state = ($raw !== '' && $raw !== false) ? json_decode($raw, true) : null;

        if (!$state || !isset($state['arena'])) {
            $state = self::freshState();
        }

        return [$state, $fp];
    }

    /**
     * Read-only load (shared lock — fast path for reads that don't need a tick).
     */
    public static function loadShared(): array
    {
        $file = self::FILE;
        if (!file_exists($file)) {
            // Bootstrap
            [$state, $fp] = self::loadLocked();
            self::save($state, $fp);
            return $state;
        }
        $fp  = fopen($file, 'r');
        flock($fp, LOCK_SH);
        $raw = stream_get_contents($fp);
        flock($fp, LOCK_UN);
        fclose($fp);
        $state = json_decode($raw, true);
        return $state ?: self::freshState();
    }

    /**
     * Write state back to file and release lock.
     */
    public static function save(array $state, $fp): void
    {
        rewind($fp);
        ftruncate($fp, 0);
        fwrite($fp, json_encode($state, JSON_UNESCAPED_UNICODE));
        fflush($fp);
        flock($fp, LOCK_UN);
        fclose($fp);
    }

    // ------------------------------------------------------------------
    // Fresh state factory
    // ------------------------------------------------------------------

    public static function freshState(): array
    {
        $state = [
            'arena'    => [
                'size'    => self::ARENA_SIZE,
                'shields' => self::generateShields(),
            ],
            'players'  => [],
            'bullets'  => [],
            'pickups'  => [],
            'chat'     => [
                ['handle' => 'System', 'message' => 'FragArena online. Good hunting.', 'time' => microtime(true)],
            ],
            'lastTick' => 0.0,
        ];

        // Spawn 6 bots immediately
        for ($i = 0; $i < 6; $i++) {
            $state['players'][] = self::makeBotPlayer($state);
        }

        // Spawn initial pickups
        $pickupTypes = Weapons::PICKUP_TYPES;
        foreach ($pickupTypes as $type) {
            $state['pickups'][] = self::makePickup($type, $state);
        }

        return $state;
    }

    // ------------------------------------------------------------------
    // Player factories
    // ------------------------------------------------------------------

    public static function makeHumanPlayer(string $handle): array
    {
        return [
            'id'            => self::uuid(),
            'handle'        => substr(htmlspecialchars($handle, ENT_QUOTES), 0, 20),
            'isBot'         => false,
            'position'      => ['x' => 0, 'y' => 0, 'z' => 0],  // will be randomised on spawn
            'rotation'      => ['x' => 0, 'y' => 0, 'z' => 0, 'w' => 1],
            'health'        => 200,
            'maxHealth'     => 200,
            'weapon'        => Weapons::PULSE,
            'weaponExpiry'  => null,
            'ammo'          => -1,
            'weaponHeat'    => 0.0,
            'canFireAt'     => 0.0,
            'score'         => 0,
            'kills'         => 0,
            'deaths'        => 0,
            'joinedAt'      => microtime(true),
            'timeInGame'    => 0.0,
            'respawnAt'     => null,
            'isDead'        => false,
            'botSkill'      => null,
            'botJoinedAt'   => null,
            'botState'      => null,
            'pendingActions'=> [],
            'lastInputAt'   => microtime(true),
            'seed'          => rand(1000, 9999),   // for procedural ship generation
        ];
    }

    public static function makeBotPlayer(array $state): array
    {
        static $botNames = [
            'Wraith','Phantom','Spectre','Nemesis','Reaper','Vortex',
            'Sigma','Delta','Omega','Pulsar','Quasar','Nova',
        ];
        static $used = [];

        do {
            $name = $botNames[array_rand($botNames)] . rand(1, 99);
        } while (in_array($name, $used, true) && count($used) < 50);
        $used[] = $name;

        $skills = ['low', 'medium', 'high'];
        $skill  = $skills[array_rand($skills)];

        $pos = self::randomFreePosition($state);

        return [
            'id'            => self::uuid(),
            'handle'        => $name,
            'isBot'         => true,
            'position'      => $pos,
            'rotation'      => ['x' => 0, 'y' => 0, 'z' => 0, 'w' => 1],
            'health'        => 200,
            'maxHealth'     => 200,
            'weapon'        => Weapons::PULSE,
            'weaponExpiry'  => null,
            'ammo'          => -1,
            'weaponHeat'    => 0.0,
            'canFireAt'     => 0.0,
            'score'         => 0,
            'kills'         => 0,
            'deaths'        => 0,
            'joinedAt'      => microtime(true),
            'timeInGame'    => 0.0,
            'respawnAt'     => null,
            'isDead'        => false,
            'botSkill'      => $skill,
            'botJoinedAt'   => microtime(true),
            'botState'      => 'patrol',
            'botTarget'     => null,
            'botWaypoint'   => null,
            'botNextStateAt'=> 0.0,
            'pendingActions'=> [],
            'lastInputAt'   => microtime(true),
            'seed'          => rand(1000, 9999),
        ];
    }

    // ------------------------------------------------------------------
    // Pickup factory
    // ------------------------------------------------------------------

    public static function makePickup(string $type, array $state): array
    {
        return [
            'id'   => self::uuid(),
            'type' => $type,
            'pos'  => self::randomFreePosition($state),
        ];
    }

    // ------------------------------------------------------------------
    // Arena generation
    // ------------------------------------------------------------------

    private static function generateShields(): array
    {
        $size    = self::ARENA_SIZE;
        $half    = $size / 2;
        $margin  = 80;     // keep shields away from walls
        $shields = [];
        $count   = rand(20, 28);  // doubled arena → more obstacles

        for ($i = 0; $i < $count; $i++) {
            $w = rand(35, 100);
            $h = rand(35, 100);
            $d = rand(35, 100);

            $x = rand(-$half + $margin + $w, $half - $margin - $w);
            $y = rand(-$half + $margin + $h, $half - $margin - $h);
            $z = rand(-$half + $margin + $d, $half - $margin - $d);

            $shields[] = [
                'id' => 's' . $i,
                'x'  => $x, 'y' => $y, 'z' => $z,
                'w'  => $w, 'h' => $h, 'd' => $d,
            ];
        }
        return $shields;
    }

    // ------------------------------------------------------------------
    // Utility helpers
    // ------------------------------------------------------------------

    /**
     * Find a position not occupied by another player, shield, or the arena wall.
     */
    public static function randomFreePosition(array $state, int $attempts = 30): array
    {
        $size = $state['arena']['size'] ?? self::ARENA_SIZE;
        $half = $size / 2 - 40;

        for ($a = 0; $a < $attempts; $a++) {
            $pos = [
                'x' => rand(-$half, $half),
                'y' => rand(-$half, $half),
                'z' => rand(-$half, $half),
            ];
            if (!self::positionOccupied($pos, $state)) {
                return $pos;
            }
        }
        // Fall back to a random position if all attempts fail
        return [
            'x' => rand(-$half, $half),
            'y' => rand(-$half, $half),
            'z' => rand(-$half, $half),
        ];
    }

    private static function positionOccupied(array $pos, array $state): bool
    {
        $minDist = self::PLAYER_RADIUS * 4;
        foreach ($state['players'] ?? [] as $p) {
            if ($p['isDead']) continue;
            $dx = $pos['x'] - $p['position']['x'];
            $dy = $pos['y'] - $p['position']['y'];
            $dz = $pos['z'] - $p['position']['z'];
            if (sqrt($dx*$dx + $dy*$dy + $dz*$dz) < $minDist) return true;
        }
        foreach ($state['arena']['shields'] ?? [] as $s) {
            if (
                abs($pos['x'] - $s['x']) < $s['w'] / 2 + $minDist &&
                abs($pos['y'] - $s['y']) < $s['h'] / 2 + $minDist &&
                abs($pos['z'] - $s['z']) < $s['d'] / 2 + $minDist
            ) return true;
        }
        return false;
    }

    public static function uuid(): string
    {
        return sprintf(
            '%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
            mt_rand(0, 0xffff), mt_rand(0, 0xffff),
            mt_rand(0, 0xffff),
            mt_rand(0, 0x0fff) | 0x4000,
            mt_rand(0, 0x3fff) | 0x8000,
            mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff)
        );
    }

    public static function clampToArena(array $pos, float $size): array
    {
        $half = $size / 2;
        return [
            'x' => max(-$half, min($half, $pos['x'])),
            'y' => max(-$half, min($half, $pos['y'])),
            'z' => max(-$half, min($half, $pos['z'])),
        ];
    }

    public static function addChat(array &$state, string $handle, string $message): void
    {
        $state['chat'][] = [
            'handle'  => $handle,
            'message' => substr($message, 0, 200),
            'time'    => microtime(true),
        ];
        if (count($state['chat']) > self::MAX_CHAT) {
            $state['chat'] = array_values(array_slice($state['chat'], -self::MAX_CHAT));
        }
    }

    /** Return player index by id, or -1 */
    public static function findPlayerIndex(array $state, string $id): int
    {
        foreach ($state['players'] as $i => $p) {
            if ($p['id'] === $id) return $i;
        }
        return -1;
    }

    public static function countHumans(array $state): int
    {
        return count(array_filter($state['players'], fn($p) => !$p['isBot']));
    }

    public static function countBots(array $state): int
    {
        return count(array_filter($state['players'], fn($p) => $p['isBot']));
    }

    public static function findOldestBot(array $state): int
    {
        $oldest = PHP_INT_MAX;
        $idx    = -1;
        foreach ($state['players'] as $i => $p) {
            if ($p['isBot'] && $p['botJoinedAt'] < $oldest) {
                $oldest = $p['botJoinedAt'];
                $idx    = $i;
            }
        }
        return $idx;
    }
}
