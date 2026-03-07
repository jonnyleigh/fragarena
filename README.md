# FragArena

FragArena is a browser-based multiplayer 3D space shooter built with JavaScript (Three.js) and a PHP backend.
Fully vibe-coded with Github Copilot

## Play Online

https://fragarena1.azurewebsites.net

## What It Is

- Up to 6 players per arena.
- Empty player slots are filled with bots.
- Fast-paced 6DOF movement in a bounded 3D combat arena.
- Procedural ships, arena shields, pickups, radar, leaderboard, and in-game chat.
- File-based authoritative server state (no database).

## Core Gameplay

- Human players join with a handle.
- If the arena is full of bots, the oldest bot is removed to make room.
- If the arena has 6 human players, join is rejected until a slot opens.
- Kills increase score; dead players respawn after a short delay.
- Bots are replaced after long sessions to keep matches balanced.

## Controls

- Mouse: Look
- Left Mouse Button: Fire
- W / A / S / D: Move
- Space: Move up
- Shift: Move down
- T: Open chat
- Esc: Quit match

## Weapons

Server-side weapon logic is authoritative.

| Weapon | Type | Damage | Fire Interval | Ammo | Notes |
|---|---|---:|---:|---:|---|
| Pulse Laser | Projectile | 30 | 400 ms | Unlimited | Default weapon |
| Instagib Laser | Raycast | 200 | 3000 ms | Unlimited | Pickup weapon, bright white beam, sonic boom |
| Rail Gun | Projectile | 15 | 150 ms | Unlimited | Pickup weapon |
| Missiles | Homing projectile | 60 | 2000 ms | 6 | Pickup weapon |

Pickup weapons expire after a timed duration, or when ammo is exhausted (if limited).

## Tech Stack

- Frontend: Vanilla JavaScript + ES modules
- 3D Rendering: Three.js (CDN)
- Backend: PHP 8+
- State Storage: JSON file with flock()-based locking

## Local Development

### Prerequisites

- PHP 8 or newer

### Run Locally

From the project root:

```powershell
php -S localhost:8000
```

Then open:

http://localhost:8000

Notes:

- Game state is stored at `data/game_state.json`.
- The first request bootstraps arena state if needed.

## API Endpoints

- `POST /api/join.php` — Join arena
- `POST /api/leave.php` — Leave arena
- `POST /api/input.php` — Player input and actions
- `GET /api/state.php` — Current state + tick-on-demand
- `POST /api/chat.php` — Chat message
- `POST /api/reset.php` — Reset state (debug/admin)

## Debug Console Commands

Open browser dev tools and use:

- `debug.help()`
- `debug.weapons()`
- `debug.weapon("pulse")`
- `debug.weapon("instagib")`
- `debug.weapon("rail")`
- `debug.weapon("missile")`
- `debug.info()`
- `debug.setHealth(100)`

## Project Structure

- `index.html` — Game shell and HUD
- `js/` — Client systems (rendering, input, weapons, networking, HUD, audio)
- `api/` — PHP HTTP endpoints
- `lib/` — Game simulation/state classes
- `data/` — Server state file
- `assets/`, `css/`, `music/` — Frontend resources

## Deployment

Production URL:

https://fragarena1.azurewebsites.net
