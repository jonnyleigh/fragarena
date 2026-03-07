<?php
/**
 * api/chat.php  —  POST { playerId, message }
 * Appends a chat message (from a human player) to the shared state.
 */

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit; }

require_once __DIR__ . '/../lib/GameState.php';

$body     = json_decode(file_get_contents('php://input'), true) ?? [];
$playerId = $body['playerId'] ?? '';
$message  = trim($body['message'] ?? '');

if (!$playerId || $message === '') {
    echo json_encode(['ok' => false, 'reason' => 'playerId and message required']);
    exit;
}

// Rate-limit: message must be ≤200 chars
if (mb_strlen($message) > 200) {
    $message = mb_substr($message, 0, 200);
}

[$state, $fp] = GameState::loadLocked();

$idx = GameState::findPlayerIndex($state, $playerId);
if ($idx < 0) {
    GameState::save($state, $fp);
    echo json_encode(['ok' => false, 'reason' => 'Player not found']);
    exit;
}

$handle = $state['players'][$idx]['handle'];
GameState::addChat($state, $handle, $message);

GameState::save($state, $fp);

echo json_encode(['ok' => true]);
