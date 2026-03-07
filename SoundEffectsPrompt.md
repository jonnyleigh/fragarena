# GitHub Copilot Prompt: Add Procedural Sound Effects and Music to Space Shooter Game

## Context

This is a multiplayer 3D space shooter game built in JavaScript with a PHP 8 backend. The game has an Elite-style aesthetic: ships are procedurally generated polygonal 3D models, the arena is a large cube with brick-wall edges, and weapons include pulse lasers, beam lasers, rail guns, and homing missiles. Up to 6 players (human or bot) fight in a bounded 3D arena with shields (stone blocks), pickups, chat, and a full HUD.

**Task:** Add a complete sound system to the game consisting of two parts:
1. **Sound effects** — generated programmatically at runtime using the Web Audio API. No audio asset files are required or used.
2. **Music** — MP3 files loaded from the `/music` directory on the server, played back via the Web Audio API. Music is optional: if no MP3 files are present the game runs silently on the music channel with no errors.

---

## Technical Foundation: Web Audio API

Use the **Web Audio API** (`AudioContext`) for everything. Do not use `<audio>` tags or `HTMLAudioElement`.

### Core Architecture

Create a singleton `SoundManager` class in a new file `sound-manager.js`:

```javascript
class SoundManager {
  constructor() {
    this.ctx = null;           // AudioContext — created on first user gesture
    this.masterGain = null;    // Master gain (kept at 1.0; exists for compressor chain)
    this.sfxGain = null;       // SFX bus gain node — controls SFX volume and mute
    this.musicGain = null;     // Music bus gain node — controls music volume and mute
    this.sfxEnabled = true;    // SFX on/off (persisted in localStorage)
    this.musicEnabled = true;  // Music on/off (persisted in localStorage)
    this.sfxVolume = 0.8;      // SFX relative volume 0.0–1.0 (persisted)
    this.musicVolume = 0.5;    // Music relative volume 0.0–1.0 (persisted)
    this.buffers = {};         // Synthesised AudioBuffers keyed by sound name
    this.musicTracks = [];     // Array of track filenames discovered from /music
    this.currentTrack = null;  // Currently playing AudioBufferSourceNode
    this.currentTrackIndex = -1;
  }
}
```

### Audio Graph

```
SFX sources  → sfxGain  ─┐
                          ├→ masterGain → DynamicsCompressorNode → ctx.destination
Music source → musicGain ─┘
```

- `masterGain` stays fixed at **1.0** at all times. It exists only for the compressor chain.
- `sfxGain.gain.value` = `sfxEnabled ? sfxVolume : 0`
- `musicGain.gain.value` = `musicEnabled ? musicVolume : 0`
- Muting either channel is done by setting its bus gain to 0, not by suspending the context.
- Add a `DynamicsCompressorNode` on the master bus (threshold: −24 dB, knee: 30, ratio: 12, attack: 0.003, release: 0.25) to prevent clipping when many sounds play simultaneously.

**Key rules:**
- `AudioContext` must be created inside a user-gesture handler. Create it lazily on the first interaction on the join screen.
- Synthesise all sound effects into `AudioBuffer` objects once at startup, cache them in `this.buffers`, and play via `AudioBufferSourceNode`.
- For 3D positional audio, use `PannerNode` with `panningModel: 'HRTF'`. Update `AudioContext.listener` each frame.
- SFX node chain: `source → gainNode → pannerNode → sfxGain → masterGain → compressor → ctx.destination`
- Music node chain: `source → musicGain → masterGain → compressor → ctx.destination`
- Expose `SoundManager.play(name, worldPosition, options)` as the main SFX API. `worldPosition` is `{x, y, z}`; pass `null` for non-positional sounds.

### Node Types Reference

| Node | Usage |
|---|---|
| `OscillatorNode` | Tonal synthesis (lasers, engine hum) |
| `AudioBufferSourceNode` | Play synthesised noise buffers and music tracks |
| `GainNode` | Volume envelopes (ADSR), bus volume, mute |
| `BiquadFilterNode` | Tone shaping (lowpass for explosions, bandpass for laser texture) |
| `PannerNode` | 3D positional audio |
| `ConvolverNode` | Optional reverb for arena ambience |
| `DynamicsCompressorNode` | Master bus compression |
| `WaveShaperNode` | Distortion for impact/explosion sounds |
| `DelayNode` | Echo/flange effects |
| `StereoPannerNode` | Simple left/right pan for UI sounds |

### ADSR Envelope Helper

```javascript
function applyEnvelope(gainNode, ctx, { attack, decay, sustain, release }, startTime, duration) {
  const g = gainNode.gain;
  g.setValueAtTime(0, startTime);
  g.linearRampToValueAtTime(1, startTime + attack);
  g.linearRampToValueAtTime(sustain, startTime + attack + decay);
  g.setValueAtTime(sustain, startTime + duration - release);
  g.linearRampToValueAtTime(0, startTime + duration);
}
```

---

## Sounds to Implement

### 1. Pulse Laser — Fire (`pulse_laser_fire`)

**Character:** A sharp, punchy "pew" — retro sci-fi, reminiscent of classic space games. Bright and percussive.

**Generation:**
- Create an `OscillatorNode` with type `'sine'`.
- Start frequency at **900 Hz**, pitch-bend down to **200 Hz** over **0.12 seconds** using `frequency.exponentialRampToValueAtTime`.
- Apply a fast envelope: attack **0 ms**, decay **30 ms**, sustain **0.1**, release **90 ms**. Total duration ~0.12 s.
- Layer a second oscillator at type `'square'`, starting at **1800 Hz**, descending to **400 Hz**, mixed at 20% volume for harmonic texture.
- Run through a `BiquadFilterNode` (bandpass, frequency **800 Hz**, Q **2**) to give it a hollow "tube" quality.
- 3D positional. Fire rate is slow, so no pooling needed — create nodes fresh each shot.

---

### 2. Beam Laser — Active Hum (`beam_laser_hum`)

**Character:** A continuous, sustained electric hum that plays while the beam is active and cuts off when released. Sounds like a high-voltage arc — a mix of buzz and pure tone.

**Generation:**
- Create a looping buffer of **white noise** (fill a 1-second `AudioBuffer` with `Math.random() * 2 - 1` values).
- Play it through a `BiquadFilterNode` (bandpass, frequency **2400 Hz**, Q **8**) to extract a narrow band of coloured noise.
- Layer an `OscillatorNode` at **220 Hz**, type `'sawtooth'`, at 30% volume, run through a second bandpass filter at **440 Hz**, Q **4**.
- A third `OscillatorNode` at **880 Hz**, `'sine'` type, at 15% volume adds a high harmonic shimmer.
- Sum these into a `GainNode` for the master beam volume.
- When beam starts: ramp master gain from 0 → 0.6 over **0.05 s**.
- When beam stops: ramp gain from 0.6 → 0 over **0.08 s**, then stop all nodes.
- 3D positional, attached to the firing ship's position.

---

### 3. Rail Gun — Fire (`railgun_fire`)

**Character:** A fast, metallic crack — like a whip made of electricity. Very short, very sharp, with a high-frequency leading edge and a quick low-frequency thump.

**Generation:**
- Generate a buffer of **white noise**, 0.15 seconds long.
- Apply a very fast amplitude envelope: near-instant attack (1 ms), exponential decay to silence over 0.15 s.
- Run through two filters in series:
  - `BiquadFilterNode` highpass at **3000 Hz** to remove low mud.
  - `BiquadFilterNode` peaking at **6000 Hz**, gain **+12 dB**, Q **1** to add a metallic crack.
- Layer a short sine sweep: **400 Hz** → **80 Hz** over 0.08 s, at 40% volume for the thump.
- Add a `WaveShaperNode` with a soft-clip curve (tanh function) for mild distortion.
- 3D positional.

---

### 4. Missile — Launch (`missile_launch`)

**Character:** A whooshing ignition — a rocket motor lighting. Has an initial "whomp" as propellant ignites, then a sustained thrust roar.

**Generation:**
- **Ignition thump:** 0.1 s of white noise, lowpass filter at **200 Hz**, fast attack (2 ms), exponential decay.
- **Thrust roar:** Pink noise (approximate by summing white noise through lowpass filters at 800 Hz, 400 Hz, and 200 Hz). Loop for up to 4 seconds, volume ramping from 0 to 0.5 over 0.3 s.
- 3D positional, attached to the missile's current world position. Update the `PannerNode` position each frame as the missile tracks its target.
- Stop the thrust sound when the missile detonates.

---

### 5. Missile — Tracking Tone (`missile_tracking`)

**Character:** A rising, menacing warble played for the potential target when a missile is homing on them. Like a radar lock warning.

**Generation:**
- `OscillatorNode` type `'sine'`, frequency oscillating between **800 Hz** and **1200 Hz** via an LFO:
  - Create a second `OscillatorNodddddddde` at **4 Hz** connected to the main oscillator's `frequency` AudioParam via a gain of **200** (±200 Hz modulation depth).
- Loop while the missile is tracking the local player. Fade volume up on lock, down when the missile is destroyed or lock is broken.
- Non-positional (HUD warning sound).

---

### 6. Explosion — Ship Destroyed (`explosion_ship`)

**Character:** A deep, rumbling space explosion — a combination of a low boom and a distorted crunch, the sound of a ship's reactor going critical.

**Generation:**
- Generate 1.5 seconds of white noise.
- Apply exponential decay envelope (attack 2 ms, full decay over 1.5 s).
- Run through a `BiquadFilterNode` (lowpass, cutoff sweeping from **800 Hz** down to **60 Hz** over 0.5 s).
- Run output through a `WaveShaperNode` with an aggressive hard-clip curve (clip above 0.6) to add crunch.
- Layer a second noise burst: 0.3 s, highpass at **2000 Hz**, fast decay. This adds the initial bright crack.
- 3D positional. For the local player being killed: also play a non-positional version at higher volume to make it feel more intimate.

---

### 7. Bullet Impact — Shield (`impact_shield`)

**Character:** A solid thud with a stone resonance — like a cannonball hitting a castle wall.

**Generation:**
- 0.3 s of white noise, lowpass filter at **400 Hz**, fast attack (1 ms), decay over 0.3 s.
- Layer a tonal element: `OscillatorNode` at **120 Hz** descending to **60 Hz** over 0.15 s, sine wave, fast decay.
- Run through a `BiquadFilterNode` (peaking at **180 Hz**, +6 dB) to emphasise stone resonance.
- 3D positional, at the point of impact.

---

### 8. Bullet Impact — Player Hull (`impact_hull`)

**Character:** A sharp metallic clang — thinner than the shield hit, with a higher-frequency ring.

**Generation:**
- 0.2 s of white noise, bandpass filter centred at **1500 Hz**, Q **3**, fast decay.
- Layer two `OscillatorNode`s at **800 Hz** and **1200 Hz**, sine type, decay over 0.1 s.
- Slight pitch randomisation on each play: multiply oscillator frequencies by `0.9 + Math.random() * 0.2` to prevent repetition.
- 3D positional, at the impact point.

---

### 9. Player Takes Damage (`player_hurt`)

**Character:** A glitchy electronic grunt — the player's ship systems taking a hit. Jarring and urgent.

**Generation:**
- `OscillatorNode` type `'sawtooth'`, **180 Hz**, with a rapid LFO tremolo at **30 Hz** (depth ±1.0, ring modulator effect).
- Envelope: attack 0 ms, decay 0.25 s.
- Run through a `BiquadFilterNode` highpass at **300 Hz** and a `WaveShaperNode` for light distortion.
- Non-positional (HUD sound).

---

### 10. Weapon Pickup (`pickup_weapon`)

**Character:** A bright, ascending chime with a futuristic shimmer. Positive and rewarding. Under 0.5 s.

**Generation:**
- Three `OscillatorNode`s in arpeggiated sequence, each 0.12 s, separated by 0.08 s:
  - **523 Hz** (C5), **659 Hz** (E5), **784 Hz** (G5) — all sine type.
- Each note: fast attack (5 ms), sustain 0.8, release 0.1 s.
- Add a `DelayNode` with delay time 0.03 s and feedback 0.2 for shimmer.
- Non-positional.

---

### 11. Weapon Expired / Ammo Empty (`weapon_expired`)

**Character:** A descending "power down" sound.

**Generation:**
- `OscillatorNode` type `'sine'`, sweeping from **600 Hz** down to **150 Hz** over 0.4 s.
- A second oscillator at half frequency (300 Hz → 75 Hz) at 30% volume adds depth.
- Non-positional.

---

### 12. Player Respawn (`player_respawn`)

**Character:** A materialisation effect — a rising shimmer, as if particles are coalescing out of space.

**Generation:**
- 0.6 s of white noise through a bandpass filter sweeping from **200 Hz** → **4000 Hz** over 0.5 s. Volume ramps from 0 to 0.4 then back to 0.
- Layer three sine oscillators at **440 Hz**, **880 Hz**, **1320 Hz**, fading in over 0.3 s.
- 3D positional at the respawn location.

---

### 13. Arena Ambience (`ambience_space`)

**Character:** A deep, barely-audible space drone. A subterranean hum that fills the arena with an eerie sense of vastness. Sits well below all other sounds.

**Generation:**
- Two `OscillatorNode`s: **40 Hz** (sine, sub-bass) and **67 Hz** (sine, a fifth above, at 60% volume).
- Both modulated slowly by LFOs at **0.05 Hz**, depth ±3 Hz.
- A third oscillator at **120 Hz**, sine type, modulated at **0.07 Hz**.
- Master gain very low (**0.05**).
- Run as continuous `OscillatorNode`s (no buffer needed). Start on arena entry, not on the join screen.
- Non-positional.

---

### 14. Chat Message Received (`chat_message`)

**Character:** A soft, unobtrusive notification chime.

**Generation:**
- Single `OscillatorNode` at **880 Hz**, sine type.
- Envelope: attack 5 ms, decay 0.05 s, sustain 0.5, release 0.2 s. Total ~0.35 s.
- Lowpass filter at **2000 Hz**.
- Volume: gain 0.3. Non-positional.

---

### 15. UI Click / Button Press (`ui_click`)

**Character:** A crisp, clean tick for join screen and menu interactions.

**Generation:**
- 0.02 s of white noise, bandpass at **3000 Hz**, Q **5**, near-instant attack and decay.
- Non-positional.

---

## 3D Positional Audio: Listener Update

Each frame inside the main game loop, update the `AudioContext.listener`:

```javascript
function updateAudioListener(camera) {
  const listener = soundManager.ctx.listener;
  listener.positionX.value = camera.position.x;
  listener.positionY.value = camera.position.y;
  listener.positionZ.value = camera.position.z;
  listener.forwardX.value = camera.forward.x;
  listener.forwardY.value = camera.forward.y;
  listener.forwardZ.value = camera.forward.z;
  listener.upX.value = camera.up.x;
  listener.upY.value = camera.up.y;
  listener.upZ.value = camera.up.z;
}
```

`PannerNode` settings for all positional sounds:

```javascript
panner.panningModel = 'HRTF';
panner.distanceModel = 'inverse';
panner.refDistance = 10;
panner.maxDistance = 500;
panner.rolloffFactor = 1.5;
panner.coneInnerAngle = 360;
panner.coneOuterAngle = 0;
```

---

## Music System

### Track Discovery

On `SoundManager.init()`, fetch the track manifest from the server:

```javascript
async function discoverMusicTracks() {
  try {
    const res = await fetch('/music/manifest.json');
    if (!res.ok) return [];
    const data = await res.json();
    return data.tracks; // e.g. ["track1.mp3", "track2.mp3"]
  } catch {
    return []; // No music directory or manifest — fail silently
  }
}
```

The PHP backend must provide a `/music/manifest.json` endpoint that scans the `/music` directory and returns available MP3 filenames:

```php
// Route /music/manifest.json to this script
$dir = __DIR__ . '/music/';
$files = glob($dir . '*.mp3');
$tracks = array_map('basename', $files ?: []);
header('Content-Type: application/json');
echo json_encode(['tracks' => array_values($tracks)]);
```

If the `/music` directory is empty or absent, the manifest returns `{"tracks":[]}` and the music system stays inactive with no errors.

### Playback

- On entering the arena, shuffle `this.musicTracks` into a random playlist order.
- Load and play tracks sequentially: `fetch` → `ArrayBuffer` → `AudioContext.decodeAudioData` → `AudioBufferSourceNode`.
- Do **not** preload all tracks at once. Load the next track only when the current one is within 5 seconds of ending, triggered by a `setTimeout` scheduled after the current track starts.
- Connect each source directly to `musicGain` — music is non-positional, no `PannerNode`.
- **Crossfade** between tracks: ramp the ending track's individual gain from 1 → 0 over 2 seconds while ramping the new track's gain from 0 → 1 over 2 seconds. Both tracks play briefly in parallel during the crossfade.
- When the playlist is exhausted, re-shuffle and start again.
- If `musicEnabled` is false when a track would start, skip loading and wait until re-enabled.
- Expose `SoundManager.nextTrack()` for debugging (not shown in HUD).

```javascript
async function loadAndPlayTrack(filename) {
  const res = await fetch(`/music/${filename}`);
  const arrayBuffer = await res.arrayBuffer();
  const audioBuffer = await soundManager.ctx.decodeAudioData(arrayBuffer);

  const trackGain = soundManager.ctx.createGain();
  trackGain.gain.setValueAtTime(0, soundManager.ctx.currentTime);
  trackGain.gain.linearRampToValueAtTime(1, soundManager.ctx.currentTime + 2); // fade in
  trackGain.connect(soundManager.musicGain);

  const source = soundManager.ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(trackGain);
  source.start();

  soundManager.currentTrack = { source, trackGain };

  // Schedule next track 5 seconds before this one ends
  setTimeout(() => {
    const next = getNextTrack();
    if (next) loadAndPlayTrack(next);
  }, (audioBuffer.duration - 5) * 1000);
}
```

---

## Sound Trigger Integration Points

| Game Event | Sound | Positional? | Position Source |
|---|---|---|---|
| Player fires pulse laser | `pulse_laser_fire` | Yes | Firing ship position |
| Player fires beam laser (start) | `beam_laser_hum` (start) | Yes | Firing ship position |
| Player fires beam laser (stop) | `beam_laser_hum` (stop) | — | — |
| Player fires rail gun | `railgun_fire` | Yes | Firing ship position |
| Missile launched | `missile_launch` | Yes | Missile position (update each frame) |
| Missile targeting local player | `missile_tracking` | No (HUD) | — |
| Any ship destroyed | `explosion_ship` | Yes | Destroyed ship position |
| Local player destroyed | `explosion_ship` + louder local layer | Mixed | Ship + non-positional |
| Bullet hits shield | `impact_shield` | Yes | Impact point |
| Bullet hits any ship | `impact_hull` | Yes | Impact point |
| Local player takes damage | `player_hurt` | No (HUD) | — |
| Weapon/ammo pickup collected | `pickup_weapon` | No | — |
| Weapon expires or ammo runs out | `weapon_expired` | No (HUD) | — |
| Player respawns | `player_respawn` | Yes | Respawn position |
| Game joined / loading complete | `player_respawn` (lighter) | No | — |
| Chat message received | `chat_message` | No (HUD) | — |
| Arena background | `ambience_space` | No (constant) | — |
| UI button / menu interaction | `ui_click` | No | — |
| Arena entered | Music playback starts | No | — |

---

## Sound Performance: Pooling and Throttling

- **Node pooling:** For high-frequency sounds (pulse laser, rail gun, hull impacts), maintain a pool of 8 pre-created `GainNode`/`PannerNode` chains per sound. Reuse rather than creating fresh nodes each shot.
- **Throttling:**
  - `pulse_laser_fire`: min 80 ms between plays
  - `impact_hull` / `impact_shield`: min 50 ms per-source
- **Simultaneous sound limit:** Track active `AudioBufferSourceNode` count. If it exceeds 24, skip the lowest-priority new sound. Priority order (highest → lowest): explosions, player_hurt, impacts, lasers, missile sounds, ambience, tracking.
- **Distance culling:** Do not create nodes for positional sounds if the world-space distance from the listener exceeds `panner.maxDistance`.

---

## Join Screen: Audio Settings

On the join/lobby screen, add an **Audio Settings** section with four controls: SFX toggle, SFX volume, music toggle, and music volume.

### UI

```html
<section class="audio-settings">
  <h3>Audio Settings</h3>

  <div class="setting-row">
    <label for="sfx-toggle">Sound Effects</label>
    <button id="sfx-toggle" class="toggle-btn" aria-pressed="true">
      <span class="toggle-icon">🔊</span>
      <span class="toggle-label">ON</span>
    </button>
    <input type="range" id="sfx-volume" min="0" max="100" value="80"
           aria-label="Sound effects volume" />
  </div>

  <div class="setting-row">
    <label for="music-toggle">Music</label>
    <button id="music-toggle" class="toggle-btn" aria-pressed="true">
      <span class="toggle-icon">🎵</span>
      <span class="toggle-label">ON</span>
    </button>
    <input type="range" id="music-volume" min="0" max="100" value="50"
           aria-label="Music volume" />
    <span id="music-status" class="music-status"></span>
  </div>
</section>
```

If no music tracks are found (manifest returns an empty array), disable the music toggle and slider and set `#music-status` text to "No music files found in /music".

### Behaviour

**Persistence:** On page load, read all four settings from `localStorage`:
- `spaceGame_sfxEnabled` — boolean string, default `true`
- `spaceGame_musicEnabled` — boolean string, default `true`
- `spaceGame_sfxVolume` — integer 0–100, default `80`
- `spaceGame_musicVolume` — integer 0–100, default `50`

Apply stored values to both the UI controls and the corresponding `SoundManager` properties immediately on load.

**SFX toggle:**
```javascript
document.getElementById('sfx-toggle').addEventListener('click', () => {
  soundManager.sfxEnabled = !soundManager.sfxEnabled;
  soundManager.sfxGain.gain.value = soundManager.sfxEnabled ? soundManager.sfxVolume : 0;
  localStorage.setItem('spaceGame_sfxEnabled', soundManager.sfxEnabled);
  updateToggleUI('sfx-toggle', soundManager.sfxEnabled, '🔊', '🔇');
});
```

**Music toggle:**
```javascript
document.getElementById('music-toggle').addEventListener('click', () => {
  soundManager.musicEnabled = !soundManager.musicEnabled;
  soundManager.musicGain.gain.value = soundManager.musicEnabled ? soundManager.musicVolume : 0;
  localStorage.setItem('spaceGame_musicEnabled', soundManager.musicEnabled);
  updateToggleUI('music-toggle', soundManager.musicEnabled, '🎵', '🔇');
  // If re-enabling and no track is playing, start playback (only if in arena)
  if (soundManager.musicEnabled && !soundManager.currentTrack && soundManager.musicTracks.length > 0 && inArena) {
    loadAndPlayTrack(getNextTrack());
  }
});
```

**SFX volume slider:**
```javascript
document.getElementById('sfx-volume').addEventListener('input', (e) => {
  soundManager.sfxVolume = e.target.value / 100;
  if (soundManager.sfxEnabled) {
    soundManager.sfxGain.gain.value = soundManager.sfxVolume;
  }
  localStorage.setItem('spaceGame_sfxVolume', e.target.value);
});
```

**Music volume slider:**
```javascript
document.getElementById('music-volume').addEventListener('input', (e) => {
  soundManager.musicVolume = e.target.value / 100;
  if (soundManager.musicEnabled) {
    soundManager.musicGain.gain.value = soundManager.musicVolume;
  }
  localStorage.setItem('spaceGame_musicVolume', e.target.value);
});
```

**Additional rules:**
- When a toggle is OFF, dim its corresponding slider (`opacity: 0.4`, `pointer-events: none`) but keep the stored value intact so volume is remembered when re-enabled.
- The very first interaction anywhere on the join screen (click or keydown) initialises the `AudioContext`. Play `ui_click` on that first interaction to confirm audio is working.
- Ambience and music start only when the player enters the arena, not on the join screen.
- Toggle buttons update their label and icon: ON → `🔊 ON` / `🎵 ON`; OFF → `🔇 OFF`.

---

## File Structure

```
sound-manager.js      ← SoundManager class, all SFX generators, music playback logic
music/                ← Drop MP3 files here
music/manifest.php    ← PHP endpoint served as /music/manifest.json
```

---

## Summary Checklist for Copilot

- [ ] Create `SoundManager` singleton with lazy `AudioContext` init on first user gesture
- [ ] Implement two-bus audio graph: `sfxGain` and `musicGain` both feeding `masterGain` → `DynamicsCompressorNode` → destination
- [ ] Implement all 15 SFX generators using Web Audio API as specified above
- [ ] Implement ADSR envelope helper
- [ ] Implement 3D `PannerNode` setup with `HRTF` model for positional sounds
- [ ] Add listener position/orientation update in the main game loop each frame
- [ ] Wire all sound trigger points into game logic per the integration table
- [ ] Implement node pooling (pool size 8) for high-frequency sounds
- [ ] Implement simultaneous sound limit (max 24) and distance culling
- [ ] Implement PHP manifest endpoint for music track discovery
- [ ] Implement music playback: shuffle playlist, lazy per-track loading, crossfade, loop
- [ ] Handle missing or empty `/music` directory gracefully with no errors
- [ ] Add SFX toggle + volume slider to join screen
- [ ] Add music toggle + volume slider to join screen, disabled when no tracks found
- [ ] Persist all four audio settings to `localStorage` and restore on page load
- [ ] Ensure `sfxGain` and `musicGain` values correctly reflect `enabled × volume` on every change
- [ ] Dim sliders when their corresponding channel is disabled
- [ ] Ensure `AudioContext` is created on first user gesture, not on page load