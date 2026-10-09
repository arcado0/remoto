// Genera le icone dell'app (PNG per finestre e tray, ICO per Windows) dal logo SVG.
// Uso: npx electron scripts/make-icons.js
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7158ff"/>
      <stop offset="1" stop-color="#2aa4ff"/>
    </linearGradient>
    <linearGradient id="hl" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".22"/>
      <stop offset=".55" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#g)"/>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#hl)"/>
  <rect x="98" y="122" width="316" height="214" rx="32" fill="none" stroke="#fff" stroke-width="32"/>
  <path d="M200 408h112M256 340v68" fill="none" stroke="#fff" stroke-width="32" stroke-linecap="round"/>
  <path d="M232 172v126l30-29 22 49 26-12-22-48h42z" fill="#fff" stroke="#fff" stroke-width="10" stroke-linejoin="round"/>
</svg>`;

// a 16/32 px il dettaglio del puntatore si perde: versione semplificata per la tray
const TRAY = (active) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7158ff"/><stop offset="1" stop-color="#2aa4ff"/></linearGradient></defs>
  <rect x="2" y="2" width="60" height="60" rx="15" fill="url(#g)"/>
  <rect x="12" y="15" width="40" height="27" rx="5" fill="none" stroke="#fff" stroke-width="5.5"/>
  <path d="M24 52h16" stroke="#fff" stroke-width="5.5" stroke-linecap="round"/>
  ${active ? '<circle cx="50" cy="50" r="12" fill="#18c964" stroke="#fff" stroke-width="4"/>' : ''}
</svg>`;

async function render(win, svg, size) {
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = ${size};
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, ${size}, ${size});
    return c.toDataURL('image/png');
  })()`);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

/** ICO con voci PNG (supportato da Windows Vista in poi). */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 300, height: 300 });
  await win.loadURL('data:text/html,<!doctype html><title>icone</title>');
  const assets = path.join(root, 'src', 'assets');
  const build = path.join(root, 'build');
  fs.mkdirSync(assets, { recursive: true });
  fs.mkdirSync(build, { recursive: true });

  const big = await render(win, LOGO, 512);
  fs.writeFileSync(path.join(assets, 'icon.png'), await render(win, LOGO, 256));
  fs.writeFileSync(path.join(build, 'icon.png'), big);

  const icoSizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
  const entries = [];
  for (const size of icoSizes) entries.push({ size, png: await render(win, size <= 32 ? TRAY(false) : LOGO, size) });
  fs.writeFileSync(path.join(build, 'icon.ico'), buildIco(entries));

  for (const [name, active] of [['tray', false], ['tray-active', true]]) {
    fs.writeFileSync(path.join(assets, `${name}.png`), await render(win, TRAY(active), 16));
    fs.writeFileSync(path.join(assets, `${name}@2x.png`), await render(win, TRAY(active), 32));
  }
  fs.writeFileSync(path.join(assets, 'logo.svg'), LOGO);
  console.log('icone generate in src/assets e build/');
  app.quit();
});
