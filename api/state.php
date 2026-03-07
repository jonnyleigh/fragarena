<?php
/**
 * api/state.php  —  GET : return full game state (and run tick if due)
 *
 * This is the hot path — called every 100 ms by every connected client.
 * If ≥50 ms has passed since lastTick we acquire an exclusive lock,
 * re-check the condition, run a tick, and release.
 * Otherwise we read with a shared lock and return immediately.
 */

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Cache-Control: no-store');

require_once __DIR__ . '/../lib/GameState.php';
require_once __DIR__ . '/../lib/GameTick.php';

$now = microtime(true);

// Fast path: shared read if tick not due yet
$quick = GameState::loadShared();

if ($now - (float)($quick['lastTick'] ?? 0) < GameTick::TICK_INTERVAL) {
    echo json_encode($quick);
    exit;
}

// Tick is due — acquire exclusive lock
[$state, $fp] = GameState::loadLocked();

// Re-check after acquiring lock (another request may have already ticked)
if ($now - (float)($state['lastTick'] ?? 0) >= GameTick::TICK_INTERVAL) {
    GameTick::runTick($state, $now);
}

GameState::save($state, $fp);

echo json_encode($state);
