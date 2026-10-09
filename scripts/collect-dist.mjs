// Raccoglie in dist/ solo ciò che si distribuisce, a partire dall'output di electron-builder in out/:
//   dist/Remoto-<versione>-portable-win64.zip   cartella "Remoto" con Remoto.exe e "Remoto-dati":
//                                                si estrae e si avvia, niente installazione né Node
//   dist/Remoto-Setup-<versione>.exe             installer (solo se è stato costruito con "npm run dist")
// I file intermedi (win-unpacked, blockmap, log di electron-builder) restano in out/.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const out = path.join(root, 'out');
const dist = path.join(root, 'dist');
const src = path.join(out, 'win-unpacked');
if (!fs.existsSync(path.join(src, 'Remoto.exe'))) {
  console.error('Manca out/win-unpacked/Remoto.exe: esegui prima "npm run dist:dir".');
  process.exit(1);
}
fs.mkdirSync(dist, { recursive: true });

// ---- zip portable ----
const stage = path.join(out, 'zip-stage');
const zip = path.join(dist, `Remoto-${pkg.version}-portable-win64.zip`);
fs.rmSync(stage, { recursive: true, force: true });
fs.rmSync(zip, { force: true });
const app = path.join(stage, 'Remoto');
fs.cpSync(src, app, { recursive: true });
fs.rmSync(path.join(app, 'Remoto-dati'), { recursive: true, force: true });
fs.mkdirSync(path.join(app, 'Remoto-dati'));
fs.writeFileSync(
  path.join(app, 'Remoto-dati', 'LEGGIMI.txt'),
  [
    `Remoto ${pkg.version} - versione portable`,
    '',
    'In questa cartella Remoto salva impostazioni, ID della postazione e log.',
    'Copiando la cartella "Remoto" (anche su una chiavetta USB) si porta tutto con sé.',
    'Se cancelli questa cartella, Remoto userà %APPDATA%\\Remoto come la versione installata.',
    '',
    'Avvio: Remoto.exe            (postazione)',
    '       Remoto.exe --server   (solo server ID, per collegarsi via Internet)',
    '',
    'Al primo avvio Windows può chiedere se consentire Remoto nel firewall: in rete locale',
    'Remoto funziona comunque, anche se si risponde "Annulla".',
    '',
  ].join('\r\n'),
);
// tar di Windows (bsdtar) crea zip con -a in base all'estensione
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'zip';
execFileSync(tar, ['-a', '-c', '-f', zip, '-C', stage, 'Remoto'], { stdio: 'inherit' });
fs.rmSync(stage, { recursive: true, force: true });
console.log(`creato ${path.relative(root, zip)} (${(fs.statSync(zip).size / 1048576).toFixed(1)} MB)`);

// ---- installer, se c'è ----
const setupName = `Remoto-Setup-${pkg.version}.exe`;
if (fs.existsSync(path.join(out, setupName))) {
  fs.copyFileSync(path.join(out, setupName), path.join(dist, setupName));
  console.log(`copiato dist/${setupName}`);
}
