// Sincronizzazione degli appunti: rileva le copie locali (testo e immagini) e applica quelle
// arrivate dall'altra postazione senza rimandarle indietro (niente ping-pong).
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { LIMITS } from '../../shared/protocol.js';

const hash = (kind, data) => crypto.createHash('sha1').update(kind).update(data).digest('hex');

export class ClipboardBridge extends EventEmitter {
  /**
   * @param {object} o
   * @param {Electron.Clipboard} o.clipboard
   * @param {typeof Electron.nativeImage} o.nativeImage
   * @param {() => number|null} o.sequence  contatore degli appunti di Windows (se disponibile)
   */
  constructor({ clipboard, nativeImage, sequence = () => null, intervalMs = 400 }) {
    super();
    this.clipboard = clipboard;
    this.nativeImage = nativeImage;
    this.sequence = sequence;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.lastSeq = null;
    this.lastHash = null;
    this.users = 0;
  }

  /** Il polling gira solo finché qualcuno (sessione host o viewer) ne ha bisogno. */
  retain() {
    if (this.users++ === 0) this.#start();
  }

  release() {
    if (this.users > 0 && --this.users === 0) this.#stop();
  }

  #start() {
    this.lastSeq = this.sequence();
    this.lastHash = this.#currentHash();
    this.timer = setInterval(() => this.#poll(), this.intervalMs);
  }

  #stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  #currentHash() {
    try {
      const text = this.clipboard.readText();
      if (text) return hash('text', text);
      const img = this.clipboard.readImage();
      if (!img.isEmpty()) return hash('image', img.toPNG());
    } catch {
      /* appunti occupati da un altro programma */
    }
    return null;
  }

  #poll() {
    const seq = this.sequence();
    if (seq !== null && seq === this.lastSeq) return;
    this.lastSeq = seq;
    const payload = this.read();
    if (!payload) return;
    const h = hash(payload.kind, payload.kind === 'text' ? payload.data : Buffer.from(payload.data, 'base64'));
    if (h === this.lastHash) return;
    this.lastHash = h;
    this.emit('change', payload);
  }

  /** Contenuto attuale come { kind:'text'|'image', data } (immagini in PNG base64). */
  read() {
    try {
      const formats = this.clipboard.availableFormats();
      const text = this.clipboard.readText();
      if (text && text.length <= LIMITS.maxClipboardText) return { kind: 'text', data: text };
      if (formats.some((f) => f.startsWith('image/'))) {
        const img = this.clipboard.readImage();
        if (!img.isEmpty()) {
          const png = img.toPNG();
          if (png.length <= LIMITS.maxClipboardImage) return { kind: 'image', data: png.toString('base64') };
        }
      }
    } catch {
      /* appunti occupati */
    }
    return null;
  }

  /** Scrive gli appunti arrivati dal remoto; il prossimo polling non li ritrasmette. */
  apply(payload) {
    if (!payload || typeof payload.data !== 'string') return false;
    if (payload.kind === 'text') {
      if (payload.data.length > LIMITS.maxClipboardText) return false;
      this.lastHash = hash('text', payload.data);
      this.clipboard.writeText(payload.data);
    } else if (payload.kind === 'image') {
      const png = Buffer.from(payload.data, 'base64');
      if (png.length > LIMITS.maxClipboardImage) return false;
      const img = this.nativeImage.createFromBuffer(png);
      if (img.isEmpty()) return false;
      this.lastHash = hash('image', img.toPNG());
      this.clipboard.writeImage(img);
    } else return false;
    this.lastSeq = this.sequence();
    return true;
  }
}
