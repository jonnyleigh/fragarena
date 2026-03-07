/**
 * chat.js — chat input component
 *
 * Activated with T key (handled in input.js which calls onChatOpen).
 * Enter sends, Esc cancels.
 */

import * as Network from './network.js';
import * as Input   from './input.js';

export class Chat {
    constructor() {
        this._overlay = document.getElementById('chat-input-overlay');
        this._input   = document.getElementById('chat-input-field');
        this._btn     = document.getElementById('chat-send-btn');

        if (!this._input) return;

        this._input.addEventListener('keydown', (e) => {
            e.stopPropagation();  // don't let W/S/etc pass through
            if (e.key === 'Enter') {
                this._send();
            } else if (e.key === 'Escape') {
                this.close();
            }
        });

        this._btn?.addEventListener('click', () => this._send());
    }

    open() {
        if (!this._overlay) return;
        this._overlay.style.display = 'flex';
        this._input.value = '';
        this._input.focus();
    }

    close() {
        if (!this._overlay) return;
        this._overlay.style.display = 'none';
        this._input.blur();
        Input.exitChatMode();
    }

    async _send() {
        const msg = this._input?.value.trim();
        if (msg) {
            await Network.sendChat(msg);
        }
        this.close();
    }
}
