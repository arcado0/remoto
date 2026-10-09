// Registro persistente degli ID: a ogni ID corrisponde l'hash del segreto del suo proprietario.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

export class IdRegistry {
  constructor({ file = null, now = Date.now, saveDelayMs = 2000 } = {}) {
    this.file = file;
    this.now = now;
    this.saveDelayMs = saveDelayMs;
    this.entries = new Map();
    this.dirty = false;
    this.timer = null;
    if (file) this.#load();
  }

  #load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [id, e] of Object.entries(data.ids || {})) {
        if (e && typeof e.h === 'string') this.entries.set(id, { h: e.h, c: e.c || 0, s: e.s || 0 });
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  get size() {
    return this.entries.size;
  }

  has(id) {
    return this.entries.has(id);
  }

  /** 'ok' (segreto corretto), 'new' (ID libero: non ancora registrato) o 'mismatch'. */
  check(id, secret) {
    const e = this.entries.get(id);
    if (!e) return 'new';
    const a = Buffer.from(e.h, 'hex');
    const b = Buffer.from(hashSecret(secret), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? 'ok' : 'mismatch';
  }

  register(id, secret) {
    const t = this.now();
    this.entries.set(id, { h: hashSecret(secret), c: t, s: t });
    // un nuovo ID si salva subito: perderlo con un arresto brusco lo renderebbe "rubabile"
    this.dirty = true;
    this.flush();
  }

  touch(id) {
    const e = this.entries.get(id);
    if (!e) return;
    e.s = this.now();
    this.#scheduleSave();
  }

  #scheduleSave() {
    this.dirty = true;
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.saveDelayMs);
    this.timer.unref?.();
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.file || !this.dirty) return;
    const ids = Object.fromEntries(this.entries);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, ids }));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }
}
