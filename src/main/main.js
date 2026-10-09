// Punto di ingresso del processo principale.
//   Remoto.exe              app completa (postazione)
//   Remoto.exe --server     solo server ID, senza finestre (nessun Node da installare)
import { app, dialog } from 'electron';
import { configureProfile } from './paths.js';
import { applyChromiumFlags, LOW_LATENCY_TRIALS } from './chromium-flags.js';

const serverMode = process.argv.includes('--server');
const { profile, userData } = configureProfile(app, { kind: serverMode ? 'server' : '' });

app.setAppUserModelId('it.remoto.app');

if (serverMode) startServerMode();
else startApp();

function startServerMode() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    const { runServerMode } = await import('./server-mode.js');
    await runServerMode(userData);
  });
}

function startApp() {
  applyChromiumFlags(app.commandLine, {
    // candidati ICE con gli IP reali (non nomi mDNS): in LAN le connessioni dirette restano affidabili
    disableFeatures: ['WebRtcHideLocalIpsWithMdns'],
    fieldTrials: LOW_LATENCY_TRIALS,
  });
  if (process.env.REMOTO_FAKE_MEDIA === '1') app.commandLine.appendSwitch('use-fake-device-for-media-stream');

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  const startHidden = process.argv.includes('--hidden');
  let ctl = null;

  app.on('second-instance', () => ctl?.showHome());
  app.on('window-all-closed', () => {
    // resta attivo nell'area di notifica: le richieste di connessione devono arrivare
  });
  app.on('before-quit', (e) => {
    if (ctl && !ctl.quitting) {
      e.preventDefault();
      ctl.quit();
    }
  });

  process.on('uncaughtException', (err) => {
    ctl?.log?.error(`eccezione non gestita: ${err.stack || err}`);
  });
  process.on('unhandledRejection', (err) => {
    ctl?.log?.error(`promessa rifiutata non gestita: ${err?.stack || err}`);
  });

  // niente "await" al livello del modulo: con un main ESM Electron emette "ready" solo dopo
  // aver valutato tutto il modulo, e un await su whenReady() qui si bloccherebbe per sempre
  app.whenReady().then(async () => {
    try {
      const { RemotoApp } = await import('./app.js');
      ctl = new RemotoApp({ version: app.getVersion(), startHidden, profile });
      await ctl.start();
    } catch (err) {
      console.error(err);
      dialog.showErrorBox('Remoto', `Impossibile avviare Remoto:\n\n${err.stack || err.message}`);
      app.exit(1);
    }
  });
}
