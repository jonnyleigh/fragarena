Create a multiplayer 3d shooter in javascript. A space game with the feel of Elite.

## Overview
In the game players float in 3d space within a bounded arena.

Players float in the space and can move in 6 DOF within the arena.
Up to 6 players can play, with bot players filling the other spaces where there are no human players to make up to 6 players in the arena at all times.

Within the play arena, there are shields which block view and block bullets.  


## Graphics
The arena is a large cube with the game played within it. The edges of the arena are drawn as a brick wall.
Shields are drawn as stone blocks.
Players are 3d models, polygonal ships which are procedurally generated.
Ships, shields and pickups are 3d


## Bots
To prevent bot players getting too high a score, they are kicked and replaced after 20 mins of play.
Bots have varying skill with some bots being more skilled than others.


## Gameplay

There is no momentum in player movement - that is they can turn and change direction immediately.

Players fight in the arena and gain points for each other player they kill.  When a player is killed they re-spawn after a few seconds at a random point in space (as long as nothing else is in that space).

When a human player joins the game, they are asked to enter their handle and a bot will be kicked to make space for them. If there are no bots in the game (that is there are already 6 humans in the game) then the player is told that the game is full and to come back later.

When a human player leaves the game a bot is spawned to take their place.

Each player connects to the game by browsing to the URL in their browser and the javascript executes locally in their browser. Some kind of server-based process is used to store and maintain the game state to keep all players synchronised.

When a player picks up a weapon they hold that weapon for 90 seconds before it expires and they go back to using the default weapon.  If they run out of ammo the player returns to the default weapon.
When a weapon is picked up, another pickup appears randomly in the place arena

If a bullet hits a shield it will not pass through the shield. Shields are procedurally generated and placed in random locations in the play arena.

There is also a chat facility where a player can send a line of text to all players. Chat messages appears on the screen when they've been sent.


## Controls:
- Mouse to look
- WSAD to move forward, back, strafe left and strafe right
- T to send a chat message
- Esc to quit

## HUD will contain:
- A radar showing location of nearby players in 3d space
- Current weapon and remaining ammo or weapon heat
- Current health
- Players current score and time in game and number of times died
- Scores of other players in a leader board
- Chat messages

## Server environment
- PHP 8 backend
- use in-memory or files for storage, don't use databases to keep things simple and fast


## Weapons:
- Pulse laser - default weapon, unlimited ammo, slow fire rate and low damage
- Beam laser - pickup weapon, unlimited ammo but with cooldown time, beam weapon, medium damage
- Rail gun - pickup weapon, unlimited ammo, fast fire rate low damage
- Missiles - pickup weapon, limited ammo, slow fire rate, missiles will fly towards the nearest enemy and track them, high damage

## Principles:
- Value speed and performance over complex graphics
- Value fun and gameplay over realism