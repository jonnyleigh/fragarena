/**
 * main.js — entry point
 *
 * Handles the join screen, bootstraps the Game class, and cleans up on leave.
 */

import * as Network from './network.js';
import { Game }     from './game.js';
import { soundManager } from './sound-manager.js';

let _currentGame = null;

// ------------------------------------------------------------------
// DOM refs
// ------------------------------------------------------------------

const joinScreen   = document.getElementById('join-screen');
const gameUI       = document.getElementById('game-ui');
const handleInput  = document.getElementById('handle-input');
const joinBtn      = document.getElementById('join-btn');
const joinError    = document.getElementById('join-error');
const joinLoading  = document.getElementById('join-loading');

// ------------------------------------------------------------------
// Debug — reset server state
// ------------------------------------------------------------------

document.getElementById('reset-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('reset-btn');
    const msg = document.getElementById('reset-msg');
    btn.disabled = true;
    msg.textContent = 'Resetting…';
    msg.style.color = '#aaa';
    try {
        const r = await fetch('api/reset.php', { method: 'POST' });
        const j = await r.json();
        msg.textContent = j.ok ? '✓ Done — rejoin to enter new arena.' : '✗ ' + (j.message ?? 'Failed.');
        msg.style.color = j.ok ? '#4f4' : '#f44';
    } catch (e) {
        msg.textContent = '✗ Connection error.';
        msg.style.color = '#f44';
    } finally {
        btn.disabled = false;
    }
});

// ------------------------------------------------------------------
// Audio UI hooking
// ------------------------------------------------------------------

function updateToggleUI(id, enabled, iconOn, iconOff) {
    const btn = document.getElementById(id);
    const slider = document.getElementById(id.replace('toggle', 'volume'));
    if (!btn) return;
    
    btn.setAttribute('aria-pressed', enabled);
    btn.querySelector('.toggle-icon').textContent = enabled ? iconOn : iconOff;
    btn.querySelector('.toggle-label').textContent = enabled ? 'ON' : 'OFF';
    
    if (slider) {
        slider.style.opacity = enabled ? '1' : '0.4';
        slider.style.pointerEvents = enabled ? 'auto' : 'none';
    }
}

// Initialize UI from soundManager properties
const sfxVolume = document.getElementById('sfx-volume');
const musicVolume = document.getElementById('music-volume');
if (sfxVolume) sfxVolume.value = Math.round(soundManager.sfxVolume * 100);
if (musicVolume) musicVolume.value = Math.round(soundManager.musicVolume * 100);

updateToggleUI('sfx-toggle', soundManager.sfxEnabled, '🔊', '🔇');
updateToggleUI('music-toggle', soundManager.musicEnabled, '🎵', '🔇');

document.getElementById('sfx-toggle')?.addEventListener('click', () => {
    soundManager.sfxEnabled = !soundManager.sfxEnabled;
    if (soundManager.sfxGain) soundManager.sfxGain.gain.value = soundManager.sfxEnabled ? soundManager.sfxVolume : 0;
    localStorage.setItem('spaceGame_sfxEnabled', soundManager.sfxEnabled);
    updateToggleUI('sfx-toggle', soundManager.sfxEnabled, '🔊', '🔇');
    soundManager.play('ui_click');
});

document.getElementById('music-toggle')?.addEventListener('click', () => {
    soundManager.musicEnabled = !soundManager.musicEnabled;
    if (soundManager.musicGain) soundManager.musicGain.gain.value = soundManager.musicEnabled ? soundManager.musicVolume : 0;
    localStorage.setItem('spaceGame_musicEnabled', soundManager.musicEnabled);
    updateToggleUI('music-toggle', soundManager.musicEnabled, '🎵', '🔇');
    
    soundManager.play('ui_click');
    if (soundManager.musicEnabled && !soundManager.currentTrack && soundManager.musicTracks.length > 0 && _currentGame) {
        soundManager.nextTrack();
    }
});

document.getElementById('sfx-volume')?.addEventListener('input', (e) => {
    soundManager.sfxVolume = e.target.value / 100;
    if (soundManager.sfxEnabled && soundManager.sfxGain) {
        soundManager.sfxGain.gain.value = soundManager.sfxVolume;
    }
    localStorage.setItem('spaceGame_sfxVolume', e.target.value);
});

document.getElementById('music-volume')?.addEventListener('input', (e) => {
    soundManager.musicVolume = e.target.value / 100;
    if (soundManager.musicEnabled && soundManager.musicGain) {
        soundManager.musicGain.gain.value = soundManager.musicVolume;
    }
    localStorage.setItem('spaceGame_musicVolume', e.target.value);
});

// Play click on buttons and inputs
document.querySelectorAll('button:not(#sfx-toggle):not(#music-toggle)').forEach(btn => {
    btn.addEventListener('click', () => soundManager.play('ui_click'));
});


// ------------------------------------------------------------------
// Prefill handle with a random name
// ------------------------------------------------------------------

(function prefillHandle() {
    const adj = [
        'Dark','Iron','Nova','Void','Steel','Ghost','Neon','Hyper',
        'Turbo','Blaze','Frost','Toxic','Rapid','Storm','Cyber','Sleek',
    ];
    const noun = [
        'Wolf','Hawk','Viper','Raven','Fox','Shark','Tiger','Falcon',
        'Cobra','Eagle','Panther','Lynx','Drake','Rogue','Wraith','Specter',
    ];
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];
    handleInput.value = pick(adj) + pick(noun) + Math.floor(Math.random() * 99 + 1);
    handleInput.select();
})();

// ------------------------------------------------------------------
// Join flow
// ------------------------------------------------------------------

joinBtn.addEventListener('click', attemptJoin);
handleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attemptJoin();
});

async function attemptJoin() {
    const handle = handleInput.value.trim();
    if (!handle) {
        showError('Please enter a handle.');
        return;
    }

    joinBtn.disabled  = true;
    joinLoading.style.display = 'block';
    joinError.style.display   = 'none';

    try {
        const result = await Network.join(handle);
        if (!result.ok) {
            showError(result.reason ?? 'Could not join. Try again.');
            return;
        }

        // Ensure audio is fully initialized before starting game
        if (!soundManager.ctx) {
            await soundManager._onFirstGesture();
        }

        // Transition to game
        joinScreen.style.display = 'none';
        gameUI.style.display     = 'block';

        _currentGame = new Game(result.playerId, result.state);
        _currentGame.start();
        
        // Start Ambience and Music when entering the arena
        soundManager.play('ambience_space');
        if (soundManager.musicEnabled && soundManager.musicTracks.length > 0) {
            soundManager.startMusicPlayback();
        }

    } catch (err) {
        showError('Connection error. Is the PHP server running?');
        console.error(err);
    } finally {
        joinBtn.disabled  = false;
        joinLoading.style.display = 'none';
    }
}

function showError(msg) {
    joinError.textContent     = msg;
    joinError.style.display   = 'block';
}

// ------------------------------------------------------------------
// Leave handling (tab close)
// ------------------------------------------------------------------

window.addEventListener('beforeunload', () => {
    Network.leave();
});

