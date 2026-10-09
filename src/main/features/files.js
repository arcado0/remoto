// Operazioni sul file system locale per il file manager e i trasferimenti.
// Usato sia lato host (richieste del viewer, se il permesso "File" è concesso) sia lato viewer
// (pannello locale). Le scritture passano da un file temporaneo rinominato a fine trasferimento.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { sanitizeFileName, sanitizeRelativePath, uniqueName, MAX_TRANSFER_FILES } from '../../shared/transfer.js';

const PART_SUFFIX = '.remoto-part';

function fsError(err) {
  const map = {
    ENOENT: 'File o cartella inesistente',
    EACCES: 'Accesso negato',
    EPERM: 'Operazione non consentita',
    EBUSY: 'File in uso da un altro programma',
    EEXIST: 'Esiste già un elemento con questo nome',
    ENOSPC: 'Spazio su disco esaurito',
    ENOTEMPTY: 'La cartella non è vuota',
    ENOTDIR: 'Non è una cartella',
    EISDIR: 'È una cartella',
  };
  const e = new Error(map[err?.code] || err?.message || 'Errore del file system');
  e.code = err?.code || 'EIO';
  return e;
}

async function wrap(fn) {
  try {
    return await fn();
  } catch (err) {
    throw fsError(err);
  }
}

export class FileService {
  constructor({ specialFolders = {}, platform = process.platform } = {}) {
    this.special = specialFolders;
    this.platform = platform;
    this.readers = new Map();
    this.writers = new Map();
    this.transfers = new Map();
  }

  #abs(p) {
    if (typeof p !== 'string' || !p || p.includes('\0')) throw fsError({ code: 'ENOENT' });
    return path.resolve(p);
  }

  async roots() {
    const out = [];
    const labels = { desktop: 'Desktop', documents: 'Documenti', downloads: 'Download', pictures: 'Immagini', videos: 'Video', music: 'Musica', home: 'Cartella utente' };
    for (const [k, label] of Object.entries(labels)) {
      const p = this.special[k];
      if (p && fs.existsSync(p)) out.push({ name: label, path: p, kind: k === 'home' ? 'home' : 'folder' });
    }
    if (this.platform === 'win32') {
      const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('');
      const checks = await Promise.all(letters.map((l) => fsp.access(`${l}:\\`).then(() => l, () => null)));
      for (const l of checks.filter(Boolean)) out.push({ name: `Disco ${l}:`, path: `${l}:\\`, kind: 'drive' });
    } else out.push({ name: 'Radice', path: '/', kind: 'drive' });
    return out;
  }

  async list(dir) {
    const abs = this.#abs(dir);
    return wrap(async () => {
      const dirents = await fsp.readdir(abs, { withFileTypes: true });
      const entries = [];
      const BATCH = 64;
      for (let i = 0; i < dirents.length && entries.length < 5000; i += BATCH) {
        const part = await Promise.all(
          dirents.slice(i, i + BATCH).map(async (d) => {
            if (d.name.endsWith(PART_SUFFIX)) return null;
            const full = path.join(abs, d.name);
            try {
              const st = await fsp.stat(full);
              return { name: d.name, path: full, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs, hidden: d.name.startsWith('.') };
            } catch {
              return null; // file di sistema non leggibili, collegamenti rotti
            }
          }),
        );
        entries.push(...part.filter(Boolean));
      }
      entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'it', { numeric: true, sensitivity: 'base' }) : a.dir ? -1 : 1));
      const parent = path.dirname(abs);
      return { path: abs, parent: parent === abs ? null : parent, sep: path.sep, entries, truncated: dirents.length > entries.length };
    });
  }

  async mkdir(parent, name) {
    const target = path.join(this.#abs(parent), sanitizeFileName(name));
    await wrap(() => fsp.mkdir(target));
    return target;
  }

  async rename(p, newName) {
    const abs = this.#abs(p);
    const target = path.join(path.dirname(abs), sanitizeFileName(newName));
    if (target === abs) return abs;
    await wrap(async () => {
      if (fs.existsSync(target)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      await fsp.rename(abs, target);
    });
    return target;
  }

  async remove(p) {
    const abs = this.#abs(p);
    if (path.parse(abs).root === abs) throw fsError({ code: 'EPERM' });
    await wrap(() => fsp.rm(abs, { recursive: true, force: false, maxRetries: 2 }));
  }

  /** Elenca ricorsivamente i file da inviare: [{abs, rel, size}] con rel relativo al genitore di ogni sorgente. */
  async expand(paths) {
    const files = [];
    let total = 0;
    const walk = async (abs, rel) => {
      if (files.length >= MAX_TRANSFER_FILES) throw Object.assign(new Error(`Troppi file (massimo ${MAX_TRANSFER_FILES})`), { code: 'E2BIG' });
      const st = await fsp.stat(abs);
      if (st.isDirectory()) {
        const items = await fsp.readdir(abs);
        if (!items.length) files.push({ abs, rel, size: 0, dir: true });
        for (const name of items) {
          if (name.endsWith(PART_SUFFIX)) continue;
          await walk(path.join(abs, name), `${rel}/${name}`);
        }
      } else if (st.isFile()) {
        files.push({ abs, rel, size: st.size });
        total += st.size;
      }
    };
    await wrap(async () => {
      for (const p of paths) {
        const abs = this.#abs(p);
        await walk(abs, path.basename(abs) || 'disco');
      }
    });
    return { files, total };
  }

  async openRead(p) {
    const abs = this.#abs(p);
    const fh = await wrap(() => fsp.open(abs, 'r'));
    const handle = crypto.randomBytes(8).toString('hex');
    this.readers.set(handle, { fh, pos: 0 });
    return handle;
  }

  /** Legge il blocco successivo; restituisce un Buffer vuoto a fine file. */
  async read(handle, length) {
    const r = this.readers.get(handle);
    if (!r) throw fsError({ code: 'EBADF' });
    const len = Math.max(1, Math.min(Number(length) || 65536, 1024 * 1024));
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await wrap(() => r.fh.read(buf, 0, len, r.pos));
    r.pos += bytesRead;
    return buf.subarray(0, bytesRead);
  }

  async closeRead(handle) {
    const r = this.readers.get(handle);
    this.readers.delete(handle);
    await r?.fh.close().catch(() => {});
  }

  /** Apre un contesto di ricezione in una cartella di destinazione esistente. */
  async beginWrite(destDir) {
    const abs = this.#abs(destDir);
    const st = await wrap(() => fsp.stat(abs));
    if (!st.isDirectory()) throw fsError({ code: 'ENOTDIR' });
    const ctx = crypto.randomBytes(8).toString('hex');
    this.transfers.set(ctx, { dest: abs, roots: new Map(), written: [] });
    return ctx;
  }

  /**
   * Crea il file temporaneo per `rel`. Se la cartella o il file di primo livello esistono già
   * vengono rinominati una volta sola per tutto il trasferimento ("Foto (1)/...").
   */
  async openWrite(ctx, rel, { dir = false } = {}) {
    const t = this.transfers.get(ctx);
    if (!t) throw fsError({ code: 'EBADF' });
    const clean = sanitizeRelativePath(rel);
    if (!clean) throw Object.assign(new Error('Percorso non valido'), { code: 'EINVAL' });
    const parts = clean.split('/');
    const top = parts[0];
    if (!t.roots.has(top)) t.roots.set(top, uniqueName(top, (n) => fs.existsSync(path.join(t.dest, n))));
    parts[0] = t.roots.get(top);
    const finalPath = path.join(t.dest, ...parts);
    const inside = path.relative(t.dest, finalPath);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw Object.assign(new Error('Percorso non valido'), { code: 'EINVAL' });
    if (dir) {
      await wrap(() => fsp.mkdir(finalPath, { recursive: true }));
      return null;
    }
    await wrap(() => fsp.mkdir(path.dirname(finalPath), { recursive: true }));
    const tmpPath = finalPath + PART_SUFFIX;
    const fh = await wrap(() => fsp.open(tmpPath, 'w'));
    const handle = crypto.randomBytes(8).toString('hex');
    this.writers.set(handle, { fh, tmpPath, finalPath, ctx, bytes: 0, chain: Promise.resolve() });
    return handle;
  }

  /** Scritture serializzate: l'ordine di arrivo è l'ordine nel file. */
  write(handle, data) {
    const w = this.writers.get(handle);
    if (!w) return Promise.reject(fsError({ code: 'EBADF' }));
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    w.chain = w.chain.then(async () => {
      await wrap(() => w.fh.write(buf, 0, buf.length));
      w.bytes += buf.length;
    });
    return w.chain;
  }

  async finishWrite(handle) {
    const w = this.writers.get(handle);
    if (!w) throw fsError({ code: 'EBADF' });
    await w.chain;
    await w.fh.close();
    this.writers.delete(handle);
    const finalPath = fs.existsSync(w.finalPath)
      ? path.join(path.dirname(w.finalPath), uniqueName(path.basename(w.finalPath), (n) => fs.existsSync(path.join(path.dirname(w.finalPath), n))))
      : w.finalPath;
    await wrap(() => fsp.rename(w.tmpPath, finalPath));
    this.transfers.get(w.ctx)?.written.push(finalPath);
    return { path: finalPath, bytes: w.bytes };
  }

  async abortWrite(handle) {
    const w = this.writers.get(handle);
    if (!w) return;
    this.writers.delete(handle);
    await w.chain.catch(() => {});
    await w.fh.close().catch(() => {});
    await fsp.rm(w.tmpPath, { force: true }).catch(() => {});
  }

  endWrite(ctx) {
    const t = this.transfers.get(ctx);
    this.transfers.delete(ctx);
    return t ? { dest: t.dest, written: t.written } : null;
  }

  async closeAll() {
    for (const h of [...this.readers.keys()]) await this.closeRead(h);
    for (const h of [...this.writers.keys()]) await this.abortWrite(h);
    this.transfers.clear();
  }
}
