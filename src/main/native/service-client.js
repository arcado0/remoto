// Client del servizio di controllo completo (RemotoService.exe, helper di sessione).
// Messaggi sulla named pipe: [lunghezza u32 LE][tipo u8][dati]; tipo 1 = JSON, tipo 2 = binario
// (sempre preceduto dal JSON che lo descrive). Se il servizio non c'è, Remoto usa SendInput locale.
import net from 'node:net';
import { EventEmitter } from 'node:events';

const JSON_FRAME = 1;
const BINARY_FRAME = 2;

export function encodeFrame(type, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(5);
  header.writeInt32LE(data.length, 0);
  header[4] = type;
  return Buffer.concat([header, data]);
}

/** Estrae i messaggi completi dal buffer; restituisce quelli trovati e il resto. */
export function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 5) {
    const len = buffer.readInt32LE(offset);
    if (len < 0 || len > 64 * 1024 * 1024) throw new Error('messaggio non valido dal servizio');
    if (buffer.length - offset - 5 < len) break;
    frames.push({ type: buffer[offset + 4], data: buffer.subarray(offset + 5, offset + 5 + len) });
    offset += 5 + len;
  }
  return { frames, rest: buffer.subarray(offset) };
}

export class ServiceClient extends EventEmitter {
  constructor({ pipePath, logger = console, retryMs = 5000 }) {
    super();
    this.pipePath = pipePath;
    this.log = logger;
    this.retryMs = retryMs;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this.info = null;
    this.desktop = '';
    this.pending = new Map();
    this.awaitingBinary = null;
    this.nextId = 1;
    this.timer = null;
    this.running = false;
  }

  start() {
    this.running = true;
    this.#connect();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.socket?.destroy();
  }

  #connect() {
    if (!this.running) return;
    const socket = net.connect(this.pipePath);
    this.socket = socket;
    socket.on('connect', async () => {
      try {
        const hello = await this.request('hello', {}, 3000);
        this.info = hello;
        this.connected = true;
        this.log.info?.(`servizio di controllo completo collegato (sessione ${hello.session}, ${hello.system ? 'SYSTEM' : 'modalità di prova'})`);
        this.emit('state', true);
        this.#setDesktop(hello.desktop || 'Default');
      } catch (err) {
        this.log.warn?.(`servizio di controllo completo: ${err.message}`);
        socket.destroy();
      }
    });
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', () => {});
    socket.on('close', () => {
      const was = this.connected;
      this.connected = false;
      this.socket = null;
      this.buffer = Buffer.alloc(0);
      for (const p of this.pending.values()) p.reject(new Error('servizio scollegato'));
      this.pending.clear();
      this.awaitingBinary = null;
      if (was) {
        this.log.warn?.('servizio di controllo completo scollegato');
        this.emit('state', false);
        this.#setDesktop('');
      }
      if (this.running) this.timer = setTimeout(() => this.#connect(), this.retryMs);
    });
  }

  #setDesktop(name) {
    if (name === this.desktop) return;
    this.desktop = name;
    this.emit('desktop', name);
  }

  /** Vero quando il controllato è su un desktop protetto (UAC o schermata di blocco): lì serve il servizio per vedere e cliccare. */
  get secure() {
    return this.connected && Boolean(this.desktop) && this.desktop !== 'Default';
  }

  #onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let decoded;
    try {
      decoded = decodeFrames(this.buffer);
    } catch (err) {
      this.log.warn?.(err.message);
      this.socket?.destroy();
      return;
    }
    this.buffer = Buffer.from(decoded.rest);
    for (const f of decoded.frames) {
      if (f.type === BINARY_FRAME) {
        const waiting = this.awaitingBinary;
        this.awaitingBinary = null;
        if (waiting) waiting.resolve({ ...waiting.msg, data: Buffer.from(f.data) });
        continue;
      }
      let msg;
      try {
        msg = JSON.parse(f.data.toString('utf8'));
      } catch {
        continue;
      }
      if (msg.ev === 'desktop') {
        this.#setDesktop(msg.name || '');
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (!msg.ok) p.reject(new Error(msg.error || 'errore del servizio'));
      else if (p.expectBinary) this.awaitingBinary = { msg, resolve: p.resolve };
      else p.resolve(msg);
    }
  }

  #write(obj) {
    if (!this.socket || this.socket.destroyed) return false;
    this.socket.write(encodeFrame(JSON_FRAME, JSON.stringify(obj)));
    return true;
  }

  request(op, extra = {}, timeoutMs = 5000, expectBinary = false) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('il servizio non risponde'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, expectBinary });
      if (!this.#write({ op, id, ...extra })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('servizio non collegato'));
      }
    });
  }

  /** Eventi già nel formato di SendInput: ['m', dx, dy, mouseData, flags] e ['k', vk, scan, flags]. */
  input(events) {
    return this.connected && this.#write({ op: 'input', events });
  }

  sas() {
    return this.request('sas', {}, 5000);
  }

  /** Cattura del desktop attivo (anche quello protetto): { w, h, data: Buffer BGRA }. */
  capture(maxWidth = 1600) {
    return this.request('capture', { maxWidth }, 5000, true);
  }
}
