// Installazione/rimozione del servizio "controllo completo" (RemotoService.exe) e lettura del suo stato.
// L'eseguibile del servizio è incluso nell'app (extraResources). Installare richiede i diritti di
// amministratore: si chiede l'elevazione (UAC) via PowerShell Start-Process -Verb RunAs.
import { app } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SERVICE_NAME = 'RemotoService';

function run(cmd, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || ''), err });
    });
  });
}

export class ServiceManager {
  constructor({ logger = console } = {}) {
    this.log = logger;
  }

  /** Percorso dell'eseguibile del servizio incluso nell'app. */
  exePath() {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'service', `${SERVICE_NAME}.exe`)
      : path.join(app.getAppPath(), 'build', 'service', `${SERVICE_NAME}.exe`);
  }

  #bundled() {
    try {
      return fs.existsSync(this.exePath());
    } catch {
      return false;
    }
  }

  /** Un servizio SYSTEM deve stare dove gli utenti non possono sostituirlo: Programmi (perché installi dall'app). */
  #inProgramFiles() {
    const exe = this.exePath().toLowerCase();
    const dirs = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['ProgramW6432']]
      .filter(Boolean)
      .map((d) => d.toLowerCase());
    return dirs.some((d) => exe.startsWith(d));
  }

  async status() {
    const supported = process.platform === 'win32';
    const bundled = supported && this.#bundled();
    let installed = false;
    let running = false;
    if (supported) {
      const q = await run('sc.exe', ['query', SERVICE_NAME], 15000);
      const out = `${q.stdout} ${q.stderr}`.toUpperCase();
      installed = /STATE\s*:/.test(out);
      running = /\bRUNNING\b/.test(out);
    }
    // si può installare solo quando l'app è installata in Programmi (il servizio rifiuta altrove)
    const canInstall = bundled && app.isPackaged && this.#inProgramFiles();
    let reason = '';
    if (!supported) reason = 'Disponibile solo su Windows.';
    else if (!bundled) reason = 'Componente del servizio non incluso in questa build.';
    else if (!app.isPackaged) reason = 'Disponibile solo nella versione installata (non in sviluppo).';
    else if (!this.#inProgramFiles()) reason = 'Disponibile solo con Remoto installato in “Programmi” (non nella versione portatile).';
    return { supported, bundled, installed, running, canInstall, reason };
  }

  async install() {
    const st = await this.status();
    if (!st.canInstall) return { ok: false, error: st.reason || 'Installazione non disponibile.' };
    return this.#elevate('install');
  }

  async uninstall() {
    if (process.platform !== 'win32') return { ok: false, error: 'Disponibile solo su Windows.' };
    return this.#elevate('uninstall');
  }

  async #elevate(verb) {
    const exe = this.exePath().replace(/'/g, "''");
    // l'uscita di PowerShell = codice di uscita del servizio; l'annullamento dell'UAC genera un'eccezione
    const script = `try { $p = Start-Process -FilePath '${exe}' -ArgumentList '${verb}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode } catch { [Console]::Error.Write($_.Exception.Message); exit 1223 }`;
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
    if (r.code === 0) {
      this.log.info?.(`servizio: ${verb} completato`);
      return { ok: true };
    }
    if (r.code === 1223 || /cancel|annull/i.test(r.stderr)) return { ok: false, error: 'Operazione annullata (UAC).' };
    const map = {
      4: 'Remoto deve essere installato in “Programmi”.',
      5: 'Servono i diritti di amministratore.',
      6: 'Errore del Gestore servizi di Windows.',
    };
    const error = map[r.code] || `Operazione non riuscita (codice ${r.code}).`;
    this.log.warn?.(`servizio: ${verb} fallito, codice ${r.code} ${r.stderr}`.trim());
    return { ok: false, error };
  }
}
