// Remoto.exe --server: il server ID gira dentro l'app, senza finestre e senza Node installato.
// Un'icona nell'area di notifica mostra lo stato e permette di arrestarlo.
import { app, Tray, Menu, nativeImage, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRendezvousServer } from '../server/core.js';
import { serverOptions, consoleLogger, SERVER_HELP } from '../server/run.js';

const assets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');

export async function runServerMode(userData) {
  const { help, options } = serverOptions(process.argv.slice(1), process.env, { defaultDataDir: path.join(userData, 'server') });
  if (help) {
    dialog.showMessageBoxSync({ title: 'Remoto - server ID', message: SERVER_HELP });
    app.quit();
    return;
  }
  fs.mkdirSync(path.join(userData, 'logs'), { recursive: true });
  const logger = consoleLogger(fs.createWriteStream(path.join(userData, 'logs', 'server.log'), { flags: 'a' }));
  const server = createRendezvousServer({ ...options, logger });
  try {
    await server.start();
  } catch (err) {
    dialog.showErrorBox('Remoto - server ID', `Impossibile avviare il server sulla porta ${options.port}:\n${err.code === 'EADDRINUSE' ? 'la porta è già in uso' : err.message}`);
    app.exit(1);
    return;
  }

  let tray = null;
  const stop = async () => {
    tray?.destroy();
    await server.stop().catch(() => {});
    app.exit(0);
  };
  const refresh = () => {
    if (!tray) return;
    const online = server.onlineCount;
    tray.setToolTip(`Remoto - server ID sulla porta ${server.port} · ${online} online`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Server ID attivo sulla porta ${server.port}`, enabled: false },
        { label: `Postazioni online: ${online}`, enabled: false },
        { type: 'separator' },
        { label: 'Apri la pagina di stato', click: () => shell.openExternal(`http://127.0.0.1:${server.port}/`) },
        { label: 'Apri la cartella dei dati', click: () => shell.openPath(userData) },
        { type: 'separator' },
        { label: 'Arresta il server', click: () => stop() },
      ]),
    );
  };
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(assets, 'tray.png')));
    refresh();
    setInterval(refresh, 5000).unref?.();
  } catch (err) {
    logger.warn(`icona nell'area di notifica non disponibile: ${err.message}`);
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
