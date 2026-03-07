<?php
/**
 * api/input.php  —  POST { playerId, position, rotation, actions[] }
 *
 * The client sends this every ~50 ms with:
 *   position : {x,y,z}
 *   rotation : {x,y,z,w}  (quaternion)
 *   actions  : array of action objects, e.g.
 *              { type:'fire', dir:{x,y,z} }
 *              { type:'beam', dir:{x,y,z} }
 *              { type:'pickup', pickupId:'...' }
 *
 * The server accepts the player's position/rotation (client is authoritative
 * for their own movement) and queues the actions for the next game tick.
 */

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit; }

require_once __DIR__ . '/../lib/GameState.php';

$body     = json_decode(file_get_contents('php://input'), true) ?? [];
$playerId = $body['playerId'] ?? '';

if (!$playerId) {
    echo json_encode(['ok' => false, 'reason' => 'playerId required']);
    exit;
}

[$state, $fp] = GameState::loadLocked();

$idx = GameState::findPlayerIndex($state, $playerId);
if ($idx < 0) {
    GameState::save($state, $fp);
    echo json_encode(['ok' => false, 'reason' => 'Player not found']);
    exit;
}

$p = &$state['players'][$idx];
$p['lastInputAt'] = microtime(true);   // heartbeat — used for disconnect detection
$arenaHalf = $state['arena']['size'] / 2;

// Update position (validate it's within arena bounds)
if (isset($body['position'])) {
    $pos = $body['position'];
    $p['position'] = [
        'x' => max(-$arenaHalf, min($arenaHalf, (float)($pos['x'] ?? 0))),
        'y' => max(-$arenaHalf, min($arenaHalf, (float)($pos['y'] ?? 0))),
        'z' => max(-$arenaHalf, min($arenaHalf, (float)($pos['z'] ?? 0))),
    ];
}

// Update rotation
if (isset($body['rotation'])) {
    $rot = $body['rotation'];
    $p['rotation'] = [
        'x' => (float)($rot['x'] ?? 0),
        'y' => (float)($rot['y'] ?? 0),
        'z' => (float)($rot['z'] ?? 0),
        'w' => (float)($rot['w'] ?? 1),
    ];
}

// Queue actions (cap at 10 per input frame to prevent abuse)
if (!empty($body['actions']) && is_array($body['actions'])) {
    $allowed = ['fire', 'beam', 'pickup'];
    foreach (array_slice($body['actions'], 0, 10) as $action) {
        if (!in_array($action['type'] ?? '', $allowed, true)) continue;

        // Sanitise fire/beam direction
        if (in_array($action['type'], ['fire', 'beam'], true) && isset($action['dir'])) {
            $d  = $action['dir'];
            $dx = (float)($d['x'] ?? 0);
            $dy = (float)($d['y'] ?? 0);
            $dz = (float)($d['z'] ?? 0);
            $l  = sqrt($dx*$dx + $dy*$dy + $dz*$dz);
            if ($l < 1e-6) continue;
            $action['dir'] = ['x'=>$dx/$l, 'y'=>$dy/$l, 'z'=>$dz/$l];
        }

        $p['pendingActions'][] = $action;
    }
}

$p['lastInputAt'] = microtime(true);

unset($p);
GameState::save($state, $fp);

echo json_encode(['ok' => true]);
