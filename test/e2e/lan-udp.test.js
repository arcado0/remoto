// Test end-to-end: due istanze reali in "rete locale" senza server, con la porta TCP dell'host
// irraggiungibile (come quando il Windows Firewall blocca le connessioni in entrata): la sessione
// deve nascere dalla segnalazione UDP sulla porta del rilevamento e arrivare fino al video.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { launchRemoto, windowWith, closeRemoto } from './launch.js';

const HOST_UDP = 47912;
const VIEWER_UDP = 47913;

let host;
let viewer;

async function until(fn, ms = 20_000, label = 'condizione') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout in attesa di: ${label}`);
    await new Promise((r) => setTimeout(r, 120));
  }
}

before(async () => {
  const lan = (port, peerPort) => ({ REMOTO_DISCOVERY: '1', REMOTO_DISCOVERY_PORT: String(port), REMOTO_DISCOVERY_TARGETS: `127.0.0.1:${peerPort}` });
  host = await launchRemoto({ name: 'PC Firewall', env: lan(HOST_UDP, VIEWER_UDP) });
  viewer = await launchRemoto({ name: 'Portatile LAN', env: lan(VIEWER_UDP, HOST_UDP) });
});

after(async () => {
  await closeRemoto(viewer);
  await closeRemoto(host);
});

test('LAN con il TCP dell’host bloccato: la richiesta passa via UDP e la sessione parte', async () => {
  // la porta TCP annunciata non risponde (porta 9: chiusa), come con il firewall che blocca Remoto
  await until(() => host.app.evaluate(() => globalThis.__remoto?.discovery.running), 30_000, 'rilevamento host');
  await host.app.evaluate(() => {
    globalThis.__remoto.direct.port = 9;
    globalThis.__remoto.discovery.announce();
  });
  const hostId = await host.app.evaluate(() => globalThis.__remoto.identity().id);
  await until(() => viewer.app.evaluate((_electron, id) => globalThis.__remoto?.discovery.find(id)?.port === 9, hostId), 15_000, 'host visto in LAN dal viewer');

  const before = new Set(viewer.app.windows());
  const home = await windowWith(viewer.app, 'home/index.html');
  await home.fill('.connect-input input', hostId);
  await home.click('button:has-text("Connetti")');
  const sess = await until(() => viewer.app.windows().find((w) => !before.has(w) && w.url().includes('session/session.html')), 15_000, 'finestra di sessione');
  await sess.waitForFunction(() => window.__remotoSession);
  const prompt = await windowWith(host.app, 'prompt/prompt.html');
  await prompt.click('button:has-text("Accetta")');
  await until(() => sess.evaluate(() => window.__remotoSession.state.ui.state === 'connected'), 30_000, 'sessione connessa');
  await until(() => sess.evaluate(() => document.getElementById('screen').videoWidth > 0), 20_000, 'video');

  const via = await viewer.app.evaluate(() => [...globalThis.__remoto.viewer.sessions.values()][0]?.via);
  assert.match(via, /^udp /, `percorso usato: ${via}`);
  assert.equal(await host.app.evaluate(() => globalThis.__remoto.lanUdp.transports.size), 1);

  // chiusura dal viewer: l'host lo sa subito (messaggio "x"), senza aspettare i timeout
  await sess.evaluate(() => remoto.send('viewer:disconnect'));
  await until(() => host.app.evaluate(() => globalThis.__remoto.host.list().length === 0), 10_000, 'sessione chiusa sull’host');
});
