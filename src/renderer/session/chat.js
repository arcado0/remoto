// Chat della sessione (pannello laterale).
import { h, icon } from '../lib/dom.js';

const time = (ts) => new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

export class ChatPanel {
  constructor({ onSend, onClose, peerName = 'Remoto' }) {
    this.onSend = onSend;
    this.peerName = peerName;
    this.list = h('div', { class: 'chat-list selectable', 'aria-live': 'polite' });
    this.input = h('textarea', { class: 'input', placeholder: 'Scrivi un messaggio…', rows: 1, maxlength: 4000 });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.#submit();
      }
    });
    this.input.addEventListener('input', () => {
      this.input.style.height = 'auto';
      this.input.style.height = `${Math.min(120, this.input.scrollHeight)}px`;
    });
    this.empty = h('div', { class: 'empty' }, icon('chat'), h('h4', null, 'Nessun messaggio'), h('p', null, 'I messaggi compaiono anche sul PC remoto.'));
    this.list.append(this.empty);
    this.el = h(
      'div',
      { class: 'col', style: { flex: '1', minHeight: '0', gap: '0' } },
      h('div', { class: 'side-head' }, h('h3', null, 'Chat'), h('button', { class: 'icon-btn', 'aria-label': 'Chiudi chat', onClick: onClose }, icon('x'))),
      this.list,
      h('form', { class: 'chat-form', onSubmit: (e) => {
        e.preventDefault();
        this.#submit();
      } }, this.input, h('button', { class: 'btn primary', type: 'submit', 'aria-label': 'Invia' }, icon('send'))),
    );
  }

  #submit() {
    const text = this.input.value.trim();
    if (!text) return;
    if (this.onSend(text) !== false) {
      this.add({ from: 'me', text, ts: Date.now() });
      this.input.value = '';
      this.input.style.height = '';
    }
  }

  add({ from, text, ts }) {
    this.empty?.remove();
    this.empty = null;
    this.list.append(h('div', { class: `bubble ${from === 'me' ? 'me' : 'them'}` }, text, h('span', { class: 'time' }, time(ts || Date.now()))));
    this.list.scrollTop = this.list.scrollHeight;
  }

  focus() {
    setTimeout(() => this.input.focus(), 30);
  }
}
