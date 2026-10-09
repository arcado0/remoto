// Flusso con l'app impacchettata (nessun Node esterno): host nascosto nell'area di notifica,
// richiesta dalla LAN, verifica che la finestra di richiesta sia davvero visibile.
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const EXE = path.resolve('out/win-unpacked/Remoto.exe');
const until = async (fn, ms = 30000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 200)); } };
async function launch(name) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `remoto-pkg-${name}-`));
  const app = await electron.launch({ executablePath: EXE, args: [], env: { ...process.env, REMOTO_PROFILE_DIR: profile, REMOTO_NAME: name, REMOTO_DIRECT_HOST: '127.0.0.1', REMOTO_DIRECT_PORT: '0', REMOTO_DISCOVERY: '0', REMOTO_E2E: '1', REMOTO_SERVER_URL: '' }, timeout: 60000 });
  return { app, profile };
}
const host = await launch('Host');
const viewer = await launch('Viewer');
try {
  await until(() => host.app.evaluate(() => Boolean(globalThis.__remoto?.direct?.port)));
  const hostHome = await until(() => host.app.windows().find((w) => w.url().includes('home/index.html')));
  await hostHome.waitForSelector('[data-testid="my-id"]');
  console.log('home impacchettata OK, ID', await hostHome.textContent('[data-testid="my-id"]'));
  await host.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('home'))?.hide());
  const port = await host.app.evaluate(() => globalThis.__remoto.direct.port);
  const vHome = await until(() => viewer.app.windows().find((w) => w.url().includes('home/index.html')));
  await vHome.waitForSelector('[data-testid="my-id"]');
  await vHome.fill('.connect-input input', `127.0.0.1:${port}`);
  await vHome.click('button:has-text("Connetti")');
  await until(() => host.app.windows().find((w) => w.url().includes('prompt/prompt.html')));
  await new Promise((r) => setTimeout(r, 1500));
  const info = await host.app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('prompt'));
    const b = w.getBounds();
    const c = screen.dipToScreenPoint({ x: b.x + Math.round(b.width / 2), y: b.y + 40 });
    const top = globalThis.__remoto.hostSide.input.api.topWindowAt(c.x, c.y);
    return { visible: w.isVisible(), bounds: b, topmostHere: String(top) === String(w.getNativeWindowHandle().readBigUInt64LE(0)) };
  });
  console.log('richiesta (app impacchettata, host nascosto):', JSON.stringify(info));
  const prompt = host.app.windows().find((w) => w.url().includes('prompt/prompt.html'));
  console.log('testo richiesta:', (await prompt.textContent('body')).replace(/\s+/g, ' ').slice(0, 120));
  await prompt.click('button:has-text("Accetta")');
  const sess = await until(() => viewer.app.windows().find((w) => w.url().includes('session/session.html')));
  await until(() => sess.evaluate(() => window.__remotoSession?.state.ui.state === 'connected'));
  await until(() => sess.evaluate(() => document.getElementById('screen').videoWidth > 0));
  console.log('sessione connessa con l’app impacchettata, video', await sess.evaluate(() => document.getElementById('screen').videoWidth));
  // le opzioni di bassa latenza devono valere anche nell'eseguibile (field trial impostati da main.js)
  const jb = await sess.evaluate(async () => {
    const read = async () => {
      let v = null;
      (await window.__remotoSession.state.peer.pc.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') v = r;
      });
      return v;
    };
    const a = await read();
    await new Promise((r) => setTimeout(r, 2000));
    const b = await read();
    return { jitterMs: ((b.jitterBufferDelay - a.jitterBufferDelay) / Math.max(1, b.jitterBufferEmittedCount - a.jitterBufferEmittedCount)) * 1000, fps: b.framesPerSecond };
  });
  console.log(`buffer del video ricevuto ${jb.jitterMs.toFixed(1)} ms (atteso < 20), ${jb.fps} fps`);
} catch (e) {
  console.log('ERRORE', e.stack);
} finally {
  for (const i of [viewer, host]) {
    await i.app.evaluate(() => globalThis.__remoto?.quit()).catch(() => {});
    await Promise.race([i.app.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
    try { i.app.process().kill(); } catch {}
    fs.rmSync(i.profile, { recursive: true, force: true, maxRetries: 3 });
  }
}
