<?php
/**
 * api/leave.php  —  POST { playerId }
 * Removes the human player from the arena and spawns a bot replacement.
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

$handle = $state['players'][$idx]['handle'];
array_splice($state['players'], $idx, 1);

GameState::addChat($state, 'System', "$handle left the arena.");

// Spawn a bot to keep count at MAX_PLAYERS
if (count($state['players']) < GameState::MAX_PLAYERS) {
    $bot = GameState::makeBotPlayer($state);
    $state['players'][] = $bot;
    GameState::addChat($state, 'System', "{$bot['handle']} (bot) entered the arena.");
}

GameState::save($state, $fp);

echo json_encode(['ok' => true]);
