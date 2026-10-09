// Azioni di sistema sul PC controllato: riavvio, blocco della sessione, blocco dell'input.
import { execFile } from 'node:child_process';
import { win32 } from '../native/win32.js';

export function isAdmin() {
  const w = win32();
  try {
    return Boolean(w?.isUserAnAdmin());
  } catch {
    return false;
  }
}

export function lockWorkstation() {
  const w = win32();
  return Boolean(w?.lockWorkStation());
}

/** Riavvio con preavviso di qualche secondo (l'utente remoto vede il messaggio di Windows). */
export function restartComputer(seconds = 5, message = 'Riavvio richiesto da una sessione Remoto') {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, error: 'Riavvio supportato solo su Windows' });
      return;
    }
    execFile('shutdown.exe', ['/r', '/t', String(seconds), '/c', message], { windowsHide: true }, (err) => {
      resolve(err ? { ok: false, error: err.message } : { ok: true });
    });
  });
}

/**
 * BlockInput blocca mouse e tastiera fisici (l'input iniettato dallo stesso thread passa).
 * Funziona solo se Remoto è avviato come amministratore.
 */
export class InputBlocker {
  constructor() {
    this.owners = new Set();
    this.active = false;
  }

  set(owner, on) {
    if (on) this.owners.add(owner);
    else this.owners.delete(owner);
    return this.#apply();
  }

  #apply() {
    const want = this.owners.size > 0;
    if (want === this.active) return { ok: true, active: this.active };
    const w = win32();
    if (!w) return { ok: false, active: false, error: 'Non supportato su questo sistema' };
    if (want && !isAdmin()) {
      this.owners.clear();
      return { ok: false, active: false, error: 'Serve avviare Remoto come amministratore sul PC remoto' };
    }
    const ok = Boolean(w.blockInput(want));
    if (ok) this.active = want;
    return { ok, active: this.active, error: ok ? undefined : 'Windows ha rifiutato il blocco dell’input' };
  }

  releaseAll() {
    this.owners.clear();
    return this.#apply();
  }
}
