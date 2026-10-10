// Cartella temporanea dei file arrivati dagli appunti dell'altro PC: da qui Esplora risorse li copia
// quando si incolla. Ogni "copia" ha la sua sottocartella; si tengono solo le ultime, il resto si cancella
// (e tutto all'avvio di Remoto).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const PART_SUFFIX = '.remoto-part';

export class ClipTemp {
  constructor(base, { keep = 3 } = {}) {
    this.base = path.resolve(base);
    this.keep = keep;
  }

  async cleanAll() {
    await fsp.rm(this.base, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
  }

  /** Nuova sottocartella vuota per una copia in arrivo. */
  async prepare() {
    await fsp.mkdir(this.base, { recursive: true });
    const old = (await fsp.readdir(this.base, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    for (const name of old.slice(0, Math.max(0, old.length - (this.keep - 1)))) {
      await fsp.rm(path.join(this.base, name), { recursive: true, force: true }).catch(() => {});
    }
    const dir = path.join(this.base, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.mkdir(dir);
    return dir;
  }

  /** true solo per una sottocartella creata qui (mai percorsi scelti da altri). */
  owns(dir) {
    if (typeof dir !== 'string' || !dir) return false;
    const rel = path.relative(this.base, path.resolve(dir));
    return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep) && fs.existsSync(dir);
  }

  /** File e cartelle di primo livello ricevuti (quelli da mettere negli appunti). */
  async entries(dir) {
    const names = await fsp.readdir(dir);
    return names.filter((n) => !n.endsWith(PART_SUFFIX)).map((n) => path.join(dir, n));
  }
}
