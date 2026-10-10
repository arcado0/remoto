// Collaudo degli appunti di Windows con file veri (CF_HDROP): Remoto mette due file negli appunti e
// PowerShell (come Esplora risorse) deve vederli come "file copiati". Il contenuto precedente degli
// appunti (testo o file) viene ripristinato alla fine.
//   node test/e2e/dev/clipboard-files-check.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchRemoto, closeRemoto } from '../launch.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remoto-appunti-prova-'));
const a = path.join(dir, 'prova uno.txt');
const b = path.join(dir, 'Cartella è');
fs.writeFileSync(a, 'uno');
fs.mkdirSync(b);

const inst = await launchRemoto({ name: 'Prova appunti' });
let saved = null;
try {
  await new Promise((r) => setTimeout(r, 2500)); // la finestra dell'engine (proprietaria degli appunti) deve esistere
  // contenuto attuale (file, testo o immagine) letto e poi ripristinato con lo stesso sincronizzatore dell'app
  saved = await inst.app.evaluate(async () => (await globalThis.__remoto.clipboard.read()) || { kind: 'empty' });
  console.log(`appunti prima: ${saved.kind === 'files' ? `${saved.paths.length} file` : saved.kind === 'text' ? `testo (${saved.data.length} caratteri)` : saved.kind === 'image' ? 'immagine' : 'vuoti'}`);
  const wrote = await inst.app.evaluate((_e, paths) => globalThis.__remoto.clipboard.files.writeFiles(paths), [a, b]);
  const back = await inst.app.evaluate(() => globalThis.__remoto.clipboard.files.readFiles());
  // -Sta: gli appunti OLE (Esplora risorse, .NET) vogliono un thread STA
  const ps = execFileSync('powershell.exe', ['-NoProfile', '-Sta', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
  console.log(`scrittura: ${wrote} · rilettura: ${JSON.stringify(back)} · PowerShell vede: ${JSON.stringify(ps)}`);
  const ok = wrote && JSON.stringify(back) === JSON.stringify([a, b]) && JSON.stringify(ps) === JSON.stringify([a, b]);
  console.log(ok ? 'RISULTATO: file negli appunti come da Esplora risorse' : 'RISULTATO: qualcosa non torna');

  // testo: una copia vera deve essere rilevata dal sincronizzatore (con l'API vecchia non succedeva mai)
  const seen = await inst.app.evaluate(async () => {
    const b = globalThis.__remoto.clipboard;
    const got = new Promise((r) => {
      b.once('change', r);
      setTimeout(() => r(null), 4000);
    });
    b.retain();
    await new Promise((r) => setTimeout(r, 800));
    await b.clipboard.writeText(`copia di prova ${Date.now()}`);
    const p = await got;
    b.release();
    return p;
  });
  console.log(seen?.kind === 'text' && seen.data.startsWith('copia di prova') ? 'RISULTATO: copia di testo rilevata' : `RISULTATO: copia di testo NON rilevata (${JSON.stringify(seen)})`);
} catch (err) {
  console.error('ERRORE', err.stack || err.message);
} finally {
  if (saved) {
    await inst.app
      .evaluate(async (_e, s) => {
        const bridge = globalThis.__remoto.clipboard;
        if (s.kind === 'files') bridge.applyFiles(s.paths);
        else if (s.kind === 'text' || s.kind === 'image') await bridge.apply(s);
        else bridge.clipboard.clear();
      }, saved)
      .catch(() => {});
    console.log('appunti ripristinati');
  }
  await closeRemoto(inst);
  fs.rmSync(dir, { recursive: true, force: true });
}
