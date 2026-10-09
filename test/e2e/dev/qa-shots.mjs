// Screenshot di controllo visivo (sviluppo). Il video remoto è sfocato e il file manager
// mostra solo cartelle di prova, per non catturare contenuti reali dello schermo o del disco.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRendezvousServer } from '../../../src/server/core.js';
import { launchRemoto, windowWith, closeRemoto } from '../launch.js';

const out = process.argv[2] || '.';
const theme = process.argv[3] || 'light';
const PASSWORD = 'Prova-Remoto-2026';
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 150));
  }
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const BLUR = '#screen{filter:blur(32px) saturate(.35) brightness(.8) !important}';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remoto-qa-'));
for (const side of ['locale', 'remoto']) {
  const d = path.join(tmp, side);
  fs.mkdirSync(path.join(d, 'Documenti di progetto'), { recursive: true });
  fs.mkdirSync(path.join(d, 'Foto vacanze'));
  fs.writeFileSync(path.join(d, 'preventivo-2026.pdf'), Buffer.alloc(245_000));
  fs.writeFileSync(path.join(d, 'note riunione.txt'), 'note');
  fs.writeFileSync(path.join(d, 'installer.exe'), Buffer.alloc(3_400_000));
}

const server = createRendezvousServer({ port: 0, host: '127.0.0.1' });
const { port } = await server.start();
const url = `ws://127.0.0.1:${port}/ws`;
const host = await launchRemoto({ name: 'PC Ufficio', serverUrl: url });
const viewer = await launchRemoto({ name: 'Portatile', serverUrl: url });
const shot = async (page, name) => {
  await page.addStyleTag({ content: BLUR }).catch(() => {});
  await pause(250);
  await page.screenshot({ path: path.join(out, `${theme}-${name}.png`) });
  console.log('salvato', name);
};
try {
  await until(() => host.app.evaluate(() => globalThis.__remoto?.link.state === 'online'));
  await until(() => viewer.app.evaluate(() => globalThis.__remoto?.link.state === 'online'));
  for (const app of [host.app, viewer.app]) await app.evaluate((_e, t) => globalThis.__remoto.updateConfig({ general: { theme: t } }), theme);
  const hostId = await host.app.evaluate(() => globalThis.__remoto.identity().id);
  await host.app.evaluate((_e, pw) => globalThis.__remoto.setUnattendedPassword(pw), PASSWORD);

  const home = await windowWith(viewer.app, 'home/index.html');
  await home.fill('.connect-input input', hostId);
  await home.click('button:has-text("Connetti")');
  const sess = await windowWith(viewer.app, 'session/session.html');
  await sess.setViewportSize({ width: 1440, height: 860 }).catch(() => {});
  const prompt = await windowWith(host.app, 'prompt/prompt.html');
  await pause(400);
  await prompt.screenshot({ path: path.join(out, `${theme}-prompt.png`) });
  await sess.waitForSelector('input[type=password]');
  await sess.fill('input[type=password]', PASSWORD);
  await sess.click('button:has-text("Accedi")');
  await until(() => sess.evaluate(() => window.__remotoSession?.state.ui.state === 'connected'));
  await until(() => sess.evaluate(() => document.getElementById('screen').videoWidth > 0));
  await pause(2500);

  // chat con qualche messaggio
  await sess.click('button[aria-label="Chat"]');
  await sess.fill('.chat-form textarea', 'Ciao! Ti mostro dove si trova il file della fattura.');
  await sess.press('.chat-form textarea', 'Enter');
  await host.app.evaluate(() => {
    const s = globalThis.__remoto.host.list()[0];
    globalThis.__remoto.hostSide.sendChat(s.id, 'Perfetto, grazie mille!');
  });
  await pause(500);
  await shot(sess, 'session-chat');
  await sess.click('button[aria-label="Chiudi chat"]');

  // statistiche
  await sess.click('button[data-tip="Statistiche di connessione"]');
  await pause(1200);
  await shot(sess, 'session-stats');
  await sess.click('button[data-tip="Statistiche di connessione"]');

  // menu
  for (const [sel, name] of [['button[aria-label="Schermo remoto"]', 'menu-monitor'], ['button[aria-label="Tasti speciali"]', 'menu-tastiera'], ['button[aria-label="Altre azioni"]', 'menu-azioni']]) {
    await sess.click(sel);
    await pause(200);
    await shot(sess, name);
    await sess.keyboard.press('Escape');
  }

  // lavagna
  await sess.click('button[data-tip="Lavagna"]');
  await pause(300);
  await shot(sess, 'session-lavagna');
  await sess.click('button[data-tip="Lavagna"]');

  // file manager su cartelle di prova
  await sess.click('button[data-tip="Trasferimento file"]');
  await sess.waitForSelector('.fm-path input');
  const inputs = sess.locator('.fm-path input');
  await inputs.nth(0).fill(path.join(tmp, 'locale'));
  await inputs.nth(0).press('Enter');
  await inputs.nth(1).fill(path.join(tmp, 'remoto'));
  await inputs.nth(1).press('Enter');
  await pause(600);
  await sess.evaluate((a) => window.__remotoSession.upload([a.src], a.dest), { src: path.join(tmp, 'locale', 'installer.exe'), dest: path.join(tmp, 'remoto') });
  await pause(1200);
  await shot(sess, 'session-file');

  const panel = await windowWith(host.app, 'panel/panel.html');
  await pause(300);
  await panel.screenshot({ path: path.join(out, `${theme}-panel.png`) });

  // finestra principale e impostazioni
  await home.bringToFront();
  await home.setViewportSize({ width: 1180, height: 760 }).catch(() => {});
  await pause(500);
  await home.screenshot({ path: path.join(out, `${theme}-home.png`) });
  if (theme === 'light') {
    await home.click('button[aria-label="Impostazioni"]');
    for (const [label, name] of [['Generale', 'set-generale'], ['Sicurezza', 'set-sicurezza'], ['Rete', 'set-rete'], ['Visualizzazione', 'set-visualizzazione'], ['Registro accessi', 'set-registro'], ['Informazioni', 'set-info']]) {
      await home.click(`.settings-nav button:has-text("${label}")`);
      await pause(350);
      await home.screenshot({ path: path.join(out, `${theme}-${name}.png`) });
    }
    const hhome = await windowWith(host.app, 'home/index.html');
    await hhome.click('button[aria-label="Impostazioni"]');
    await hhome.click('.settings-nav button:has-text("Registro accessi")');
    await pause(400);
    await hhome.screenshot({ path: path.join(out, `${theme}-host-registro.png`) });
  }
  console.log('fatto');
} catch (err) {
  console.log('ERRORE', err.stack);
} finally {
  await closeRemoto(viewer);
  await closeRemoto(host);
  await server.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}
