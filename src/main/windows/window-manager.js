// Crea e traccia le finestre per ruolo. Il ruolo decide quali canali IPC la finestra può usare.
import { BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROLES = Object.freeze(['home', 'prompt', 'panel', 'session', 'engine', 'overlay']);

export class WindowManager {
  constructor({ rendererDir, preload, icon, log }) {
    this.rendererDir = rendererDir;
    this.preload = preload;
    this.icon = icon;
    this.log = log;
    this.entries = new Map(); // webContents.id → { role, win, meta }
  }

  create(role, { page, query = {}, bounds, meta = {}, webPreferences = {}, ...options }) {
    if (!ROLES.includes(role)) throw new Error(`ruolo sconosciuto: ${role}`);
    const win = new BrowserWindow({
      ...(bounds || {}),
      icon: this.icon,
      autoHideMenuBar: true,
      backgroundColor: '#0f1120',
      title: 'Remoto',
      ...options,
      webPreferences: {
        preload: this.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        backgroundThrottling: true,
        ...webPreferences,
      },
    });
    win.setMenu(null);
    const wc = win.webContents;
    const id = wc.id;
    this.entries.set(id, { role, win, meta });
    win.on('closed', () => this.entries.delete(id));

    // nessuna navigazione: le pagine sono locali e fisse
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.on('will-redirect', (e) => e.preventDefault());
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('render-process-gone', (_e, details) => this.log?.warn(`renderer ${role} terminato: ${details.reason}`));
    wc.on('console-message', (event) => {
      const level = event.level ?? 'info';
      if (level === 'error' || level === 3) this.log?.warn(`[${role}] ${event.message}`);
    });

    const url = pathToFileURL(path.join(this.rendererDir, page));
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    win.loadURL(url.toString()).catch((err) => this.log?.error(`caricamento ${page}: ${err.message}`));
    return win;
  }

  entry(webContents) {
    return webContents ? this.entries.get(webContents.id) || null : null;
  }

  byRole(role) {
    return [...this.entries.values()].filter((e) => e.role === role && !e.win.isDestroyed());
  }

  first(role) {
    return this.byRole(role)[0]?.win || null;
  }

  send(win, channel, ...args) {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, ...args);
  }

  sendRole(role, channel, ...args) {
    for (const e of this.byRole(role)) this.send(e.win, channel, ...args);
  }
}
