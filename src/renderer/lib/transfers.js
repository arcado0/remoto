// Trasferimenti di file e cartelle su un RTCDataChannel affidabile e ordinato.
// Lo stesso motore gira sul lato host (engine) e sul lato viewer (finestra di sessione);
// cambia solo il "backend" che legge e scrive su disco tramite il processo principale.
//
// Messaggi (stringhe JSON) + chunk binari [xid u32][indice u32][dati]:
//   up {x,dest,count,total,name} → up-ok | up-err {error}    (il viewer chiede di caricare)
//   dl {x,count,total,name}                                   (l'host annuncia un download)
//   fb {x,i,rel,size,dir} … chunk … fe {x,i}                  (un file)
//   fdone {x} → fack {x,ok,error}                             (fine trasferimento)
//   fcancel {x,reason}                                        (annullato da uno dei due lati)
import { encodeChunk, decodeChunk, CHUNK_SIZE } from '../../shared/transfer.js';

const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;
const PROGRESS_MS = 120;

/** Messaggio leggibile: toglie il prefisso che Electron aggiunge agli errori IPC. */
export function cleanError(err) {
  return String(err?.message || err || 'Errore').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

let nextXid = Math.floor(Math.random() * 0x7fffffff);
export function newXid() {
  nextXid = (nextXid + 1) % 0x7fffffff;
  return nextXid || 1;
}

export class TransferEngine extends EventTarget {
  /**
   * @param {object} o
   * @param {RTCDataChannel} o.channel
   * @param {object} o.backend   operazioni su disco (vedi engine/host-peer.js e session/session.js)
   * @param {(dest:string) => true|string} [o.canReceive]  autorizza gli upload in arrivo
   * @param {(msg:object) => void} [o.onOther]  altri messaggi sullo stesso canale (appunti)
   */
  constructor({ channel, backend, canReceive = () => true, onOther = () => {} }) {
    super();
    this.channel = channel;
    this.backend = backend;
    this.canReceive = canReceive;
    this.onOther = onOther;
    this.incoming = new Map();
    this.outgoing = new Map();
    this.waiters = new Map();
    this.queue = Promise.resolve();
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('message', (e) => {
      this.queue = this.queue.then(() => this.#handle(e.data)).catch((err) => console.error('trasferimento:', err));
    });
    channel.addEventListener('close', () => this.#abortAll('Connessione chiusa'));
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #sendJson(msg) {
    if (this.channel.readyState === 'open') this.channel.send(JSON.stringify(msg));
  }

  async #drain() {
    if (this.channel.bufferedAmount <= HIGH_WATER) return;
    this.channel.bufferedAmountLowThreshold = LOW_WATER;
    await new Promise((resolve, reject) => {
      const onLow = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error('Connessione chiusa'));
      };
      const cleanup = () => {
        this.channel.removeEventListener('bufferedamountlow', onLow);
        this.channel.removeEventListener('close', onClose);
      };
      this.channel.addEventListener('bufferedamountlow', onLow);
      this.channel.addEventListener('close', onClose);
    });
  }

  #progress(t, force = false) {
    const now = performance.now();
    if (!force && now - (t.lastEmit || 0) < PROGRESS_MS) return;
    t.lastEmit = now;
    this.#emit('progress', { x: t.x, dir: t.dir, done: t.done, total: t.total, file: t.file || '', count: t.count, index: t.index || 0 });
  }

  // ---------- ricezione ----------

  async #handle(data) {
    if (typeof data !== 'string') return this.#onChunk(data);
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return undefined;
    }
    switch (msg.t) {
      case 'up':
        return this.#onUploadRequest(msg);
      case 'up-ok':
      case 'up-err':
      case 'fack':
        this.waiters.get(`${msg.t === 'fack' ? 'fack' : 'up'}:${msg.x}`)?.(msg);
        return undefined;
      case 'dl': {
        const t = this.incoming.get(msg.x);
        if (t) {
          Object.assign(t, { total: Number(msg.total) || 0, count: Number(msg.count) || 0, name: String(msg.name || t.name) });
          this.#emit('start', { x: t.x, dir: 'in', total: t.total, count: t.count, name: t.name });
        } else this.#sendJson({ t: 'fcancel', x: msg.x, reason: 'Download non richiesto' });
        return undefined;
      }
      case 'fb':
        return this.#onFileBegin(msg);
      case 'fe':
        return this.#onFileEnd(msg);
      case 'fdone':
        return this.#onDone(msg);
      case 'fcancel':
        return this.#onCancel(msg);
      default:
        this.onOther(msg);
        return undefined;
    }
  }

  async #onUploadRequest(msg) {
    const verdict = this.canReceive(String(msg.dest || ''));
    if (verdict !== true) {
      this.#sendJson({ t: 'up-err', x: msg.x, error: typeof verdict === 'string' ? verdict : 'Non consentito' });
      return;
    }
    try {
      const ctx = await this.backend.beginWrite(String(msg.dest));
      const t = { x: msg.x, dir: 'in', ctx, total: Number(msg.total) || 0, count: Number(msg.count) || 0, done: 0, name: String(msg.name || ''), current: null, paths: [], dest: msg.dest };
      this.incoming.set(msg.x, t);
      this.#sendJson({ t: 'up-ok', x: msg.x });
      this.#emit('start', { x: t.x, dir: 'in', total: t.total, count: t.count, name: t.name, dest: t.dest });
    } catch (err) {
      this.#sendJson({ t: 'up-err', x: msg.x, error: cleanError(err) });
    }
  }

  async #onFileBegin(msg) {
    const t = this.incoming.get(msg.x);
    if (!t || t.failed) return;
    try {
      if (msg.dir) {
        await this.backend.openWrite(t.ctx, String(msg.rel), { dir: true });
        return;
      }
      const h = await this.backend.openWrite(t.ctx, String(msg.rel));
      t.current = { i: msg.i, h, rel: String(msg.rel) };
      t.file = String(msg.rel).split('/').pop();
      t.index = msg.i;
      this.#progress(t);
    } catch (err) {
      await this.#failIncoming(t, cleanError(err));
    }
  }

  async #onChunk(buffer) {
    const c = decodeChunk(buffer);
    if (!c) return;
    const t = this.incoming.get(c.xid);
    if (!t || t.failed || !t.current || t.current.i !== c.index) return;
    try {
      await this.backend.write(t.current.h, c.data);
      t.done += c.data.byteLength;
      this.#progress(t);
    } catch (err) {
      await this.#failIncoming(t, cleanError(err));
    }
  }

  async #onFileEnd(msg) {
    const t = this.incoming.get(msg.x);
    if (!t || t.failed || !t.current || t.current.i !== msg.i) return;
    try {
      const res = await this.backend.finishWrite(t.current.h);
      if (res?.path) t.paths.push(res.path);
    } catch (err) {
      await this.#failIncoming(t, cleanError(err));
      return;
    }
    t.current = null;
  }

  async #onDone(msg) {
    const t = this.incoming.get(msg.x);
    if (!t || t.failed) return;
    this.incoming.delete(msg.x);
    await this.backend.endWrite(t.ctx).catch(() => {});
    this.#sendJson({ t: 'fack', x: msg.x, ok: true, count: t.paths.length });
    this.#progress(t, true);
    this.#emit('done', { x: t.x, dir: 'in', ok: true, paths: t.paths, name: t.name, total: t.total });
  }

  async #failIncoming(t, reason) {
    t.failed = true;
    this.incoming.delete(t.x);
    if (t.current) await this.backend.abortWrite(t.current.h).catch(() => {});
    await this.backend.endWrite(t.ctx).catch(() => {});
    this.#sendJson({ t: 'fcancel', x: t.x, reason });
    this.#emit('done', { x: t.x, dir: 'in', ok: false, error: reason, name: t.name });
  }

  async #onCancel(msg) {
    const reason = String(msg.reason || 'Annullato');
    const tin = this.incoming.get(msg.x);
    if (tin) {
      tin.failed = true;
      this.incoming.delete(msg.x);
      if (tin.current) await this.backend.abortWrite(tin.current.h).catch(() => {});
      await this.backend.endWrite(tin.ctx).catch(() => {});
      this.#emit('done', { x: msg.x, dir: 'in', ok: false, error: reason, name: tin.name });
    }
    const tout = this.outgoing.get(msg.x);
    if (tout) {
      tout.cancelled = true;
      tout.error = reason;
      this.waiters.get(`up:${msg.x}`)?.({ t: 'up-err', error: reason });
      this.waiters.get(`fack:${msg.x}`)?.({ ok: false, error: reason });
    }
  }

  // ---------- invio ----------

  #wait(key, timeoutMs) {
    return new Promise((resolve) => {
      const timer = timeoutMs ? setTimeout(() => finish({ ok: false, t: 'timeout', error: 'Nessuna risposta dall’altra postazione' }), timeoutMs) : null;
      const finish = (msg) => {
        clearTimeout(timer);
        this.waiters.delete(key);
        resolve(msg);
      };
      this.waiters.set(key, finish);
    });
  }

  /** Prepara la ricezione di un download richiesto (lato viewer). */
  async expectDownload(x, destDir, name = '') {
    const ctx = await this.backend.beginWrite(destDir);
    this.incoming.set(x, { x, dir: 'in', ctx, total: 0, count: 0, done: 0, name, current: null, paths: [], dest: destDir });
  }

  /** Rinuncia a un download preparato che l'altro lato ha rifiutato. */
  async dropExpected(x) {
    const t = this.incoming.get(x);
    if (!t) return;
    this.incoming.delete(x);
    await this.backend.endWrite(t.ctx).catch(() => {});
  }

  /**
   * Invia file e cartelle. mode 'upload' (viewer → host, con richiesta di autorizzazione)
   * oppure 'download' (host → viewer, già richiesto dall'altro lato).
   */
  async send(x, paths, { mode, dest = '' }) {
    const out = { x, dir: 'out', cancelled: false, done: 0, total: 0, count: 0, name: '' };
    this.outgoing.set(x, out);
    try {
      const { files, total } = await this.backend.expand(paths);
      if (!files.length) throw new Error('Niente da trasferire');
      const first = files[0].rel.split('/')[0];
      Object.assign(out, { total, count: files.length, name: paths.length === 1 ? first : `${paths.length} elementi` });
      this.#emit('start', { x, dir: 'out', total, count: files.length, name: out.name, dest });
      if (mode === 'upload') {
        const answer = this.#wait(`up:${x}`, 20_000);
        this.#sendJson({ t: 'up', x, dest, count: files.length, total, name: out.name });
        const res = await answer;
        if (res.t !== 'up-ok') throw new Error(res.error || 'Upload rifiutato');
      } else this.#sendJson({ t: 'dl', x, count: files.length, total, name: out.name });

      for (let i = 0; i < files.length && !out.cancelled; i++) {
        const f = files[i];
        this.#sendJson({ t: 'fb', x, i, rel: f.rel, size: f.size, dir: Boolean(f.dir) });
        if (f.dir) continue;
        out.file = f.rel.split('/').pop();
        out.index = i;
        const h = await this.backend.openRead(f.abs);
        try {
          for (;;) {
            if (out.cancelled) break;
            const chunk = await this.backend.read(h, CHUNK_SIZE);
            if (!chunk || !chunk.byteLength) break;
            await this.#drain();
            if (this.channel.readyState !== 'open') throw new Error('Connessione chiusa');
            this.channel.send(encodeChunk(x, i, chunk));
            out.done += chunk.byteLength;
            this.#progress(out);
          }
        } finally {
          await this.backend.closeRead(h).catch(() => {});
        }
        if (!out.cancelled) this.#sendJson({ t: 'fe', x, i });
      }
      if (out.cancelled) throw new Error(out.error || 'Annullato');
      const ack = this.#wait(`fack:${x}`, 0);
      this.#sendJson({ t: 'fdone', x });
      const res = await ack;
      if (!res.ok) throw new Error(res.error || 'Trasferimento non riuscito');
      this.#progress(out, true);
      this.#emit('done', { x, dir: 'out', ok: true, name: out.name, total: out.total });
    } catch (err) {
      if (!out.cancelled) this.#sendJson({ t: 'fcancel', x, reason: cleanError(err) });
      this.#emit('done', { x, dir: 'out', ok: false, error: cleanError(err), name: out.name });
    } finally {
      this.outgoing.delete(x);
    }
  }

  cancel(x, reason = 'Annullato') {
    const out = this.outgoing.get(x);
    if (out) {
      out.cancelled = true;
      out.error = reason;
      this.#sendJson({ t: 'fcancel', x, reason });
      this.waiters.get(`up:${x}`)?.({ t: 'up-err', error: reason });
      this.waiters.get(`fack:${x}`)?.({ ok: false, error: reason });
      return;
    }
    if (this.incoming.has(x)) {
      this.queue = this.queue.then(() => this.#onCancel({ x, reason })).then(() => this.#sendJson({ t: 'fcancel', x, reason }));
    }
  }

  #abortAll(reason) {
    for (const x of [...this.outgoing.keys()]) this.cancel(x, reason);
    for (const x of [...this.incoming.keys()]) this.queue = this.queue.then(() => this.#onCancel({ x, reason }));
  }
}
