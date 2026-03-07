<?php
/**
 * api/join.php  —  POST { handle }
 * Validates the arena has room, kicks a bot, creates a human player record.
 * Returns { ok: true, playerId, state } or { ok: false, reason }.
 */

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit; }

require_once __DIR__ . '/../lib/GameState.php';

$body   = json_decode(file_get_contents('php://input'), true) ?? [];
$handle = trim($body['handle'] ?? '');

if ($handle === '') {
    echo json_encode(['ok' => false, 'reason' => 'Handle is required.']);
    exit;
}

[$state, $fp] = GameState::loadLocked();

$humanCount = GameState::countHumans($state);

if ($humanCount >= GameState::MAX_PLAYERS) {
    GameState::save($state, $fp);
    echo json_encode(['ok' => false, 'reason' => 'Game is full. Try again later.']);
    exit;
}

// Kick one bot to make room if arena is at capacity
if (count($state['players']) >= GameState::MAX_PLAYERS) {
    $bi = GameState::findOldestBot($state);
    if ($bi >= 0) {
        $kickedName = $state['players'][$bi]['handle'];
        array_splice($state['players'], $bi, 1);
        GameState::addChat($state, 'System', "$kickedName (bot) was kicked to make room.");
    }
}

// Create and insert the human player
$player = GameState::makeHumanPlayer($handle);
$player['position'] = GameState::randomFreePosition($state);
$state['players'][] = $player;

GameState::addChat($state, 'System', "{$player['handle']} joined the arena.");

GameState::save($state, $fp);

echo json_encode([
    'ok'       => true,
    'playerId' => $player['id'],
    'state'    => $state,
]);
