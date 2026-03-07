<?php
/**
 * api/reset.php  —  DELETE /api/reset.php
 *
 * Debug endpoint: wipes the game state file so a fresh arena is generated
 * on the next request. Should be disabled or access-controlled in production.
 */

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit; }

require_once __DIR__ . '/../lib/GameState.php';

$file = GameState::FILE;

if (file_exists($file)) {
    // Grab exclusive lock so we don't wipe while a tick is mid-write
    $fp = fopen($file, 'c+');
    if ($fp) {
        flock($fp, LOCK_EX);
        ftruncate($fp, 0);
        flock($fp, LOCK_UN);
        fclose($fp);
        unlink($file);
    }
}

echo json_encode(['ok' => true, 'message' => 'State reset. Fresh arena will generate on next request.']);
