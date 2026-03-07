<?php
$dir = __DIR__ . '/';
if (!is_dir($dir)) {
    header('Content-Type: application/json');
    echo json_encode(['tracks' => []]);
    exit;
}
$files = glob($dir . '*.mp3');
$tracks = array_map('basename', $files ?: []);
header('Content-Type: application/json');
echo json_encode(['tracks' => array_values($tracks)]);
