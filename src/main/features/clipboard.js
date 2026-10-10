// Sincronizzazione degli appunti: rileva le copie locali (testo, immagini, file) e applica quelle
// arrivate dall'altra postazione senza rimandarle indietro (niente ping-pong).
// Da Electron 44 l'API degli appunti è asincrona e in stile web: readText()/writeText() restituiscono
// promesse, le immagini passano da read()/write() con ClipboardItem; availableFormats(), readImage() e
// writeImage() non esistono più (con l'API vecchia la lettura falliva sempre e nulla veniva sincronizzato).
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { LIMITS } from '../../shared/protocol.js';

const hash = (kind, data) => crypto.createHash('sha1').update(kind).update(data).digest('hex');
const filesKey = (paths) => paths.join('\n');

export class ClipboardBridge extends EventEmitter {
  /**
   * @param {object} o
   * @param {Electron.Clipboard} o.clipboard  API asincrona di Electron (readText, writeText, read, write)
   * @param {typeof Electron.ClipboardItem} [o.ClipboardItem]  per scrivere le immagini
   * @param {() => number|null} o.sequence  contatore degli appunti di Windows (se disponibile)
   * @param {object|null} [o.files]  file negli appunti (native/clipboard-files.js): hasFiles, readFiles, writeFiles
   */
  constructor({ clipboard, ClipboardItem = null, sequence = () => null, intervalMs = 400, files = null }) {
    super();
    this.clipboard = clipboard;
    this.ClipboardItem = ClipboardItem;
    this.sequence = sequence;
    this.files = files;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.lastSeq = null;
    this.lastHash = null;
    this.users = 0;
    this.busy = false;
  }

  /** Il polling gira solo finché qualcuno (sessione host o viewer) ne ha bisogno. */
  retain() {
    if (this.users++ === 0) this.#start();
  }

  release() {
    if (this.users > 0 && --this.users === 0) this.#stop();
  }

  #start() {
    // ciò che c'è negli appunti all'inizio della sessione non si invia: solo le copie successive
    this.lastSeq = this.sequence();
    this.busy = true;
    this.read()
      .then((p) => {
        if (this.lastHash === null && p) this.lastHash = this.#hashOf(p);
      })
      .finally(() => {
        this.busy = false;
      });
    this.timer = setInterval(() => this.#poll(), this.intervalMs);
  }

  #stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  #hashOf(p) {
    if (p.kind === 'files') return hash('files', filesKey(p.paths));
    return hash(p.kind, p.kind === 'text' ? p.data : Buffer.from(p.data, 'base64'));
  }

  async #poll() {
    if (this.busy) return;
    const seq = this.sequence();
    if (seq !== null && seq === this.lastSeq) return;
    this.busy = true;
    try {
      const payload = await this.read();
      // il contatore si aggiorna dopo la lettura: una copia arrivata nel frattempo verrà letta al giro dopo
      this.lastSeq = seq;
      if (!payload) return;
      const h = this.#hashOf(payload);
      if (h === this.lastHash) return;
      this.lastHash = h;
      this.emit('change', payload);
    } finally {
      this.busy = false;
    }
  }

  /** Contenuto attuale come { kind:'text'|'image', data } (immagini in PNG base64) oppure { kind:'files', paths }. */
  async read() {
    try {
      // file copiati in Esplora risorse: si prendono i percorsi, il contenuto viaggia col trasferimento file
      const paths = this.files?.hasFiles() ? this.files.readFiles() : null;
      if (paths?.length) return { kind: 'files', paths };
      const text = await this.clipboard.readText();
      if (text) return text.length <= LIMITS.maxClipboardText ? { kind: 'text', data: text } : null;
      if (typeof this.clipboard.read !== 'function') return null;
      for (const item of await this.clipboard.read()) {
        const type = item.types.find((t) => t === 'image/png') || item.types.find((t) => t.startsWith('image/'));
        if (!type) continue;
        const png = Buffer.from(await (await item.getType(type)).arrayBuffer());
        if (png.length && png.length <= LIMITS.maxClipboardImage) return { kind: 'image', data: png.toString('base64') };
      }
    } catch {
      /* appunti occupati da un altro programma */
    }
    return null;
  }

  /** Mette negli appunti file già presenti su questo PC (ricevuti dall'altro); non vengono ritrasmessi. */
  applyFiles(paths) {
    if (!this.files || !Array.isArray(paths) || !paths.length) return false;
    if (!this.files.writeFiles(paths)) return false;
    this.lastHash = hash('files', filesKey(paths));
    this.lastSeq = this.sequence();
    return true;
  }

  /** Scrive gli appunti arrivati dal remoto; il prossimo polling non li ritrasmette. */
  async apply(payload) {
    if (!payload || typeof payload.data !== 'string') return false;
    try {
      if (payload.kind === 'text') {
        if (payload.data.length > LIMITS.maxClipboardText) return false;
        this.lastHash = hash('text', payload.data);
        await this.clipboard.writeText(payload.data);
      } else if (payload.kind === 'image') {
        const png = Buffer.from(payload.data, 'base64');
        if (!png.length || png.length > LIMITS.maxClipboardImage || !this.ClipboardItem) return false;
        this.lastHash = hash('image', png);
        await this.clipboard.write([new this.ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
      } else return false;
    } catch {
      return false;
    }
    this.lastSeq = this.sequence();
    return true;
  }
}
