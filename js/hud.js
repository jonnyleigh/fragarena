/**
 * hud.js — HTML overlay HUD manager
 *
 * Updates:
 *   - Health bar
 *   - Weapon name + ammo / cooldown bar
 *   - Kill / death / score / time panel
 *   - Leaderboard
 *   - Chat log (last 8 messages, fade after 10 s)
 *   - Respawn countdown
 *   - "You died" flash text
 */

import { WEAPON_DEFS } from './weapons.js';

export class HUD {
    constructor() {
        this._els = {
            healthBar:      document.getElementById('hud-health-bar'),
            healthText:     document.getElementById('hud-health-text'),
            weaponName:     document.getElementById('hud-weapon-name'),
            weaponAmmo:     document.getElementById('hud-weapon-ammo'),
            weaponCoolBar:  document.getElementById('hud-weapon-cool'),
            scorePanel:     document.getElementById('hud-score'),
            leaderboard:    document.getElementById('hud-leaderboard'),
            chatLog:        document.getElementById('hud-chat-log'),
            respawn:        document.getElementById('hud-respawn'),
        };

        this._chatMessages   = [];   // { text, time }
        this._lastSeenTime   = 0;    // timestamp of last processed chat entry
        this._lastWeaponCool = 0;
        this._weaponCoolMax  = 1000;
    }

    /**
     * Full update from server state + local player.
     * @param {object} serverPlayer  - matching player record from state
     * @param {Array}  allPlayers    - full players array for leaderboard
     * @param {Array}  chat          - chat array from state
     * @param {number} now           - Date.now() / 1000
     */
    update(serverPlayer, allPlayers, chat, now) {
        if (!serverPlayer) return;

        this._myId     = serverPlayer.id;
        this._myHandle = serverPlayer.handle;

        this._updateHealth(serverPlayer);
        this._updateWeapon(serverPlayer, now);
        this._updateScore(serverPlayer);
        this._updateLeaderboard(allPlayers);
        this._updateChat(chat);
        this._updateRespawn(serverPlayer, allPlayers);
    }

    // ------------------------------------------------------------------

    _updateHealth(p) {
        const pct = Math.max(0, p.health / p.maxHealth * 100);
        if (this._els.healthBar) {
            this._els.healthBar.style.width = pct + '%';
            this._els.healthBar.style.background = pct > 50 ? '#0f0'
                : pct > 25 ? '#ff0' : '#f00';
        }
        if (this._els.healthText) {
            this._els.healthText.textContent = Math.ceil(p.health);
        }
    }

    _updateWeapon(p, now) {
        const def = WEAPON_DEFS[p.weapon] ?? WEAPON_DEFS.pulse;

        if (this._els.weaponName) {
            this._els.weaponName.textContent = def.label;
        }

        if (this._els.weaponAmmo) {
            this._els.weaponAmmo.textContent = p.ammo < 0 ? '∞' : p.ammo;
        }

        if (this._els.weaponCoolBar) {
            const coolRemain = Math.max(0, (p.canFireAt ?? 0) - now);
            const pct        = 1 - Math.min(1, coolRemain / (def.cooldownMs / 1000));
            this._els.weaponCoolBar.style.width = (pct * 100) + '%';
        }
    }

    _updateScore(p) {
        if (!this._els.scorePanel) return;
        const secs  = Math.floor(p.timeInGame ?? 0);
        const mins  = Math.floor(secs / 60);
        const ss    = String(secs % 60).padStart(2, '0');
        this._els.scorePanel.innerHTML =
            `Score: <b>${p.score}</b> &nbsp; K/D: ${p.kills}/${p.deaths} &nbsp; Time: ${mins}:${ss}`;
    }

    _updateLeaderboard(players) {
        if (!this._els.leaderboard) return;
        const sorted = [...players].sort((a, b) => b.score - a.score).slice(0, 8);
        const myId = this._myId;
        this._els.leaderboard.innerHTML = sorted.map((p, i) => {
            const isSelf = p.id === myId;
            const handleClass = ['lb-handle', p.isBot ? 'bot' : '', isSelf ? 'lb-self' : ''].filter(Boolean).join(' ');
            return `<div class="lb-row${isSelf ? ' lb-row-self' : ''}">
                <span class="lb-rank">${i+1}</span>
                <span class="${handleClass}">${_esc(p.handle)}</span>
                <span class="lb-score">${p.score}</span>
             </div>`;
        }).join('');
    }

    _updateChat(chat) {
        if (!this._els.chatLog) return;
        if (!chat.length) return;

        // Detect new entries by timestamp — length-comparison breaks once the server
        // trims the array to MAX_CHAT (20), because length stays permanently at 20.
        const newMessages = chat.filter(m => (m.time ?? 0) > this._lastSeenTime);
        if (newMessages.length) {
            this._lastSeenTime = Math.max(...newMessages.map(m => m.time ?? 0));

            for (const m of newMessages) {
                if (m.handle === 'System' && m.message.includes(' fragged ')) {
                    this.showKillFeed(m.message, this._myHandle);
                }
            }
        }

        // Show last 8 player (non-System) messages in the chat log
        const playerChat = chat.filter(m => m.handle !== 'System');
        const last8 = playerChat.slice(-8);
        this._els.chatLog.innerHTML = last8.map(m =>
            `<div class="chat-msg">
                <span class="chat-handle">${_esc(m.handle)}:</span>
                <span class="chat-text">${_esc(m.message)}</span>
             </div>`
        ).join('');

        this._els.chatLog.scrollTop = this._els.chatLog.scrollHeight;
    }

    _updateRespawn(p, allPlayers) {
        if (!this._els.respawn) return;
        if (p.isDead && p.respawnAt) {
            const killer = allPlayers.find(q => q.id === p.lastDamagedBy);
            const killerName = killer ? killer.handle : 'Unknown';
            const unixNow = Date.now() / 1000;
            const t = Math.max(0, Math.ceil(p.respawnAt - unixNow));
            this._els.respawn.textContent = `KILLED BY ${killerName} — Respawning in ${t}…`;
            this._els.respawn.style.display = 'block';
        } else {
            this._els.respawn.style.display = 'none';
        }
    }

    showKillFeed(rawText, myHandle) {
        const feed = document.getElementById('hud-killfeed');
        if (!feed) return;

        // Parse "KillerHandle fragged VictimHandle with the WeaponLabel"
        // and replace the local player's name with "You" / "you".
        const text = _formatFragMessage(rawText, myHandle);
        const involvesMe = myHandle && (
            rawText.startsWith(myHandle + ' fragged') ||
            rawText.includes(' fragged ' + myHandle)
        );

        const item = document.createElement('div');
        item.className = 'kf-item' + (involvesMe ? ' kf-item-me' : '');
        item.textContent = text;
        feed.appendChild(item);
        setTimeout(() => item.remove(), 4000);
    }
}

function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/**
 * Formats a frag message for the kill feed.
 * Replaces the local player's handle with "You"/"you" where appropriate.
 * Expected input format: "KillerHandle fragged VictimHandle with the WeaponLabel"
 */
function _formatFragMessage(msg, myHandle) {
    if (!myHandle) return msg;

    const fragTag  = ' fragged ';
    const fragIdx  = msg.indexOf(fragTag);
    if (fragIdx === -1) return msg;

    const killer = msg.slice(0, fragIdx);
    const rest   = msg.slice(fragIdx + fragTag.length);

    const withTag  = ' with the ';
    const withIdx  = rest.indexOf(withTag);
    const victim   = withIdx === -1 ? rest : rest.slice(0, withIdx);
    const suffix   = withIdx === -1 ? '' : rest.slice(withIdx);

    const killerDisplay = killer === myHandle ? 'You' : killer;
    const victimDisplay = victim === myHandle ? 'you' : victim;

    return `${killerDisplay} fragged ${victimDisplay}${suffix}`;
}
