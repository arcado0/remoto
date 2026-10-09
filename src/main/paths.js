// Cartella del profilo (impostazioni, log, registro del server integrato):
//   1. REMOTO_PROFILE_DIR (test)
//   2. versione portable: cartella "Remoto-dati" accanto all'eseguibile
//      - .exe portable autoestraente: accanto al .exe originale (PORTABLE_EXECUTABLE_DIR)
//      - versione zip: se la cartella "Remoto-dati" esiste accanto a Remoto.exe
//   3. %APPDATA%\Remoto (versione installata)
// --profile=<nome> aggiunge un suffisso (più istanze sullo stesso PC).
import fs from 'node:fs';
import path from 'node:path';

export function profileArg(argv = process.argv) {
  const flag = argv.find((a) => a.startsWith('--profile='));
  const name = flag ? flag.slice('--profile='.length).replace(/[^a-zA-Z0-9_-]/g, '') : '';
  return name || null;
}

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.scrittura-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** Cartella dati della versione portable, oppure null se l'app è installata. */
export function portableDataDir({ isPackaged, execPath = process.execPath, env = process.env, suffix = '' }) {
  const name = `Remoto-dati${suffix}`;
  if (env.PORTABLE_EXECUTABLE_DIR) {
    const dir = path.join(env.PORTABLE_EXECUTABLE_DIR, name);
    if (writable(dir)) return dir;
    return null; // supporto in sola lettura: si ripiega su %APPDATA%
  }
  if (isPackaged) {
    const dir = path.join(path.dirname(execPath), name);
    if (fs.existsSync(dir) && writable(dir)) return dir;
  }
  return null;
}

export function configureProfile(app, { kind = '' } = {}) {
  const name = profileArg();
  const nameSuffix = name ? `-${name}` : '';
  const fullSuffix = `${kind ? `-${kind}` : ''}${nameSuffix}`;
  // in portable la modalità server riusa la cartella "Remoto-dati" (i suoi dati stanno in una
  // sottocartella "server"): non si crea una "Remoto-dati-server" accanto all'eseguibile che non esiste
  const portable = process.env.REMOTO_PROFILE_DIR ? null : portableDataDir({ isPackaged: app.isPackaged, suffix: nameSuffix });
  if (process.env.REMOTO_PROFILE_DIR) app.setPath('userData', path.resolve(process.env.REMOTO_PROFILE_DIR));
  else if (portable) app.setPath('userData', portable);
  else app.setPath('userData', path.join(app.getPath('appData'), `Remoto${fullSuffix}`));
  return { userData: app.getPath('userData'), profile: name, portable: Boolean(portable) };
}
