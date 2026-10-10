// Cavo audio virtuale con un clic, anche dalla versione portable. Serve perché le app di questo PC
// (Teams, Zoom…) usino come microfono la voce di chi controlla: Windows non permette a un programma di
// creare un microfono senza un driver, e un driver non può stare dentro un'app portable.
// Remoto non ridistribuisce nulla: scarica il pacchetto ufficiale di VB-CABLE (gratuito, VB-Audio) dal
// sito del produttore, ne verifica la firma digitale e solo allora lo installa (richiesta UAC).
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const VBCABLE_PAGE = 'https://vb-audio.com/Cable/';
const DOWNLOAD_BASE = 'https://download.vb-audio.com/Download_CABLE/';
const MAX_ZIP_BYTES = 30 * 1024 * 1024;
/** Il programma d'installazione deve essere firmato da VB-Audio. */
export const VBCABLE_SIGNER = /VB-Audio|Vincent Burel/i;

/**
 * Link al pacchetto più recente nella pagina ufficiale. Si prende solo il nome del file
 * ("VBCABLE_Driver_PackNN.zip"): l'indirizzo resta sempre download.vb-audio.com.
 */
export function findPackUrl(html) {
  let best = null;
  for (const m of String(html || '').matchAll(/Download_CABLE\/(VBCABLE_Driver_Pack(\d+)\.zip)/gi)) {
    const n = Number(m[2]);
    if (!best || n > best.n) best = { n, file: m[1] };
  }
  return best ? DOWNLOAD_BASE + best.file : null;
}

/** "Valid|CN=VB-Audio Software, ..." (uscita di Get-AuthenticodeSignature) → firma accettata? */
export function signatureOk(line) {
  const [status, subject = ''] = String(line || '').trim().split('|');
  return status === 'Valid' && VBCABLE_SIGNER.test(subject);
}

function run(cmd, args, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: typeof err?.code === 'number' ? err.code : err ? 1 : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

const psQuote = (s) => String(s).replace(/'/g, "''");

export class VirtualCableInstaller {
  /**
   * @param {object} o
   * @param {string} o.dir  cartella temporanea di lavoro
   * @param {(url: string) => Promise<Response>} [o.fetch]  di norma net.fetch di Electron (rispetta il proxy di sistema)
   */
  constructor({ dir, fetch = globalThis.fetch, exec = run, arch = process.arch, platform = process.platform, logger = console }) {
    this.dir = dir;
    this.fetch = fetch;
    this.exec = exec;
    this.arch = arch;
    this.platform = platform;
    this.log = logger;
    this.busy = false;
  }

  async #get(url, kind) {
    const res = await this.fetch(url);
    if (!res.ok) throw new Error(`download non riuscito (${res.status})`);
    if (kind === 'text') return res.text();
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_ZIP_BYTES) throw new Error('pacchetto troppo grande');
    return buf;
  }

  /**
   * @param {(step: 'download'|'verify'|'install') => void} [onStep]
   * @returns {Promise<{ok: boolean, error?: string, cancelled?: boolean}>}
   */
  async install(onStep = () => {}) {
    if (this.platform !== 'win32') return { ok: false, error: 'Disponibile solo su Windows.' };
    if (this.busy) return { ok: false, error: 'Installazione già in corso.' };
    this.busy = true;
    try {
      onStep('download');
      const url = findPackUrl(await this.#get(VBCABLE_PAGE, 'text'));
      if (!url) throw new Error('la pagina di VB-CABLE è cambiata');
      const zip = await this.#get(url, 'buffer');
      await fsp.rm(this.dir, { recursive: true, force: true });
      const out = path.join(this.dir, 'pacchetto');
      await fsp.mkdir(out, { recursive: true });
      const zipPath = path.join(this.dir, path.basename(url));
      await fsp.writeFile(zipPath, zip);
      const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      const x = await this.exec(tar, ['-xf', zipPath, '-C', out]);
      if (x.code !== 0) throw new Error('pacchetto non leggibile');
      const setup = path.join(out, this.arch === 'ia32' ? 'VBCABLE_Setup.exe' : 'VBCABLE_Setup_x64.exe');
      if (!fs.existsSync(setup)) throw new Error('programma d’installazione non trovato nel pacchetto');

      onStep('verify');
      const sig = await this.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$s = Get-AuthenticodeSignature -LiteralPath '${psQuote(setup)}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`]);
      if (!signatureOk(sig.stdout)) {
        this.log.warn?.(`cavo audio: firma non valida (${sig.stdout.trim()})`);
        throw new Error('la firma digitale del pacchetto non è quella di VB-Audio');
      }

      onStep('install');
      // -i installa, -h senza finestre; l'annullamento dell'UAC genera un'eccezione (codice 1223)
      const script = `try { $p = Start-Process -FilePath '${psQuote(setup)}' -ArgumentList '-i','-h' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { [Console]::Error.Write($_.Exception.Message); exit 1223 }`;
      const r = await this.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], 300_000);
      if (r.code === 1223 || /cancel|annull/i.test(r.stderr)) return { ok: false, cancelled: true, error: 'Installazione annullata (UAC).' };
      if (r.code !== 0) throw new Error(`il programma d’installazione ha restituito il codice ${r.code}`);
      this.log.info?.(`cavo audio: VB-CABLE installato (${path.basename(url)})`);
      return { ok: true };
    } catch (err) {
      this.log.warn?.(`cavo audio: ${err.message}`);
      return { ok: false, error: `Installazione automatica non riuscita: ${err.message}.` };
    } finally {
      // si attende la pulizia: un'installazione successiva non deve trovarsi la cartella cancellata a metà
      await fsp.rm(this.dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      this.busy = false;
    }
  }
}
