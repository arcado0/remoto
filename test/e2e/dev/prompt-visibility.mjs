// Diagnostica: la finestra di richiesta è davvero visibile e in primo piano?
import { createRendezvousServer } from '../../../src/server/core.js';
import { launchRemoto, windowWith, closeRemoto } from '../launch.js';
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 150)); } };
const server = createRendezvousServer({ port: 0, host: '127.0.0.1' });
const { port } = await server.start();
const url = `ws://127.0.0.1:${port}/ws`;
const host = await launchRemoto({ name: 'Host', serverUrl: url });
const viewer = await launchRemoto({ name: 'Viewer', serverUrl: url });
try {
  await until(() => host.app.evaluate(() => globalThis.__remoto?.link.state === 'online'));
  await until(() => viewer.app.evaluate(() => globalThis.__remoto?.link.state === 'online'));
  const hostPort = await host.app.evaluate(() => globalThis.__remoto.direct.port);
  const home = await windowWith(viewer.app, 'home/index.html');
  await home.fill('.connect-input input', `127.0.0.1:${hostPort}`);
  await home.click('button:has-text("Connetti")');
  await windowWith(host.app, 'prompt/prompt.html');
  for (const delay of [300, 1500, 4000]) {
    await new Promise((r) => setTimeout(r, delay));
    const info = await host.app.evaluate(({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('prompt'));
      if (!w) return { exists: false };
      const b = w.getBounds();
      const c = screen.dipToScreenPoint({ x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) });
      const api = globalThis.__remoto.hostSide.input.api;
      const hwnd = w.getNativeWindowHandle().readBigUInt64LE(0);
      const top = api.topWindowAt(c.x, c.y);
      return { exists: true, visible: w.isVisible(), minimized: w.isMinimized(), onTop: w.isAlwaysOnTop(), bounds: b, opacity: w.getOpacity(), topmostHere: String(top) === String(hwnd), topHwnd: String(top), hwnd: String(hwnd) };
    });
    console.log(`dopo ${delay} ms:`, JSON.stringify(info));
  }
} finally {
  await closeRemoto(viewer); await closeRemoto(host); await server.stop();
}
