// Lato "postazione che controlla": una finestra per sessione, collegata a ViewerManager.
import { app, screen, shell } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ViewerManager } from './sessions/viewer-manager.js';
import { connectDirect } from './net/direct.js';
import { parseTarget, targetLabel, formatId } from '../shared/ids.js';
import { DEFAULT_PORTS, reasonText } from '../shared/protocol.js';
import { sanitizeFileName } from '../shared/transfer.js';

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export class ViewerSide {
  constructor(ctl) {
    this.ctl = ctl;
    this.wins = new Map(); // windowId → { win, target, mode, sync, recordings }
    const config = ctl.config;
    this.manager = new ViewerManager({
      getIdentity: () => ctl.identity(),
      link: ctl.link,
      discovery: { find: (id) => (ctl.discovery.running ? ctl.discovery.find(id) : null) },
      connectDirect,
      // segnalazione UDP in LAN: passa anche se il firewall dell'altro PC blocca le connessioni in entrata
      connectUdp: (opts) => ctl.lanUdp.connect(opts),
      udpPort: DEFAULT_PORTS.discovery,
      getExtraIce: () => (Array.isArray(config.get().network.iceServers) ? config.get().network.iceServers : []),
    });
    this.manager.on('state', (s, patch) => this.#send(s.windowId, 'viewer:state', patch));
    this.manager.on('signal', (s, data) => this.#send(s.windowId, 'viewer:signal', data));
    this.manager.on('accepted', (s) => {
      ctl.log.info(`sessione verso ${targetLabel(s.target)} accettata (percorso ${s.route}${s.via ? `, ${s.via}` : ''})`);
      ctl.addRecent({ target: s.target, hostId: s.hostId, hostName: s.hostName });
    });
    this.manager.on('connected', () => ctl.updateClipboardUsage());
    this.manager.on('closed', (s, reason, detail) => {
      ctl.log.info(`sessione verso ${targetLabel(s.target)} terminata: ${reason}${detail ? ` [${detail}]` : ''} (stato ${s.ui.state}, percorso ${s.route || 'nessuno'})`);
      ctl.updateClipboardUsage();
    });
    ctl.clipboard.on('change', (payload) => this.#onLocalClipboard(payload));
  }

  #send(windowId, channel, ...args) {
    const w = this.wins.get(windowId);
    if (w) this.ctl.windows.send(w.win, channel, ...args);
  }

  /** Apre una sessione verso "ID o indirizzo" in una nuova finestra. */
  open({ input, mode = 'desktop' }) {
    const target = parseTarget(input, DEFAULT_PORTS.direct);
    if (!target) return { ok: false, error: 'Inserisci un ID di 9 cifre oppure un indirizzo IP o un nome host.' };
    if (target.kind === 'id' && target.id === this.ctl.identity().id) return { ok: false, error: reasonText('self') };
    const windowId = crypto.randomUUID();
    const { workArea } = screen.getPrimaryDisplay();
    const width = Math.min(1440, Math.round(workArea.width * 0.82));
    const height = Math.min(900, Math.round(workArea.height * 0.85));
    const win = this.ctl.windows.create('session', {
      page: 'session/session.html',
      width,
      height,
      minWidth: 720,
      minHeight: 460,
      show: false,
      title: `${targetLabel(target)} - Remoto`,
      meta: { windowId },
      webPreferences: { backgroundThrottling: false },
    });
    const w = { win, target, mode: mode === 'files' ? 'files' : 'desktop', sync: this.ctl.config.get().viewer.clipboardSync, allowClose: false, recordings: new Map() };
    this.wins.set(windowId, w);
    win.once('ready-to-show', () => win.show());
    win.on('close', (e) => {
      if (this.ctl.quitting || w.allowClose) return;
      const s = this.manager.findByWindow(windowId);
      if (s && s.state === 'connected') {
        e.preventDefault();
        this.ctl.windows.send(win, 'viewer:confirm-close');
      }
    });
    // pagina della sessione arrestata: la connessione WebRTC è persa, si chiude e si ricarica
    // la finestra, che mostrerà "Sessione terminata" con il pulsante Riconnetti
    win.webContents.on('render-process-gone', () => {
      const s = this.manager.findByWindow(windowId);
      if (s) this.manager.close(s.sid, 'error');
      if (!this.ctl.quitting && !win.isDestroyed()) setTimeout(() => !win.isDestroyed() && win.reload(), 500);
    });
    win.on('enter-full-screen', () => this.ctl.windows.send(win, 'viewer:fullscreen', true));
    win.on('leave-full-screen', () => this.ctl.windows.send(win, 'viewer:fullscreen', false));
    win.on('closed', () => {
      const s = this.manager.findByWindow(windowId);
      if (s) this.manager.close(s.sid);
      for (const r of w.recordings.values()) r.fh.close().catch(() => {});
      this.wins.delete(windowId);
      this.ctl.updateClipboardUsage();
    });
    // Alt+F4 va al PC remoto quando si controlla, non chiude la finestra locale
    win.webContents.on('before-input-event', (e, inputEv) => {
      if (inputEv.type === 'keyDown' && inputEv.alt && inputEv.key === 'F4') {
        const s = this.manager.findByWindow(windowId);
        if (s?.state === 'connected') {
          e.preventDefault();
          this.ctl.windows.send(win, 'viewer:forward-combo', 'alt-f4');
        }
      }
    });
    this.#connect(windowId);
    return { ok: true, windowId };
  }

  #connect(windowId) {
    const w = this.wins.get(windowId);
    if (!w) return;
    const v = this.ctl.config.get().viewer;
    this.manager.connect({ target: w.target, mode: w.mode, windowId, prefs: { codec: v.codec, quality: v.quality, audio: v.audio } });
  }

  // ---------- richieste dalla finestra di sessione ----------

  #byEntry(entry) {
    const w = this.wins.get(entry.meta.windowId);
    const s = this.manager.findByWindow(entry.meta.windowId);
    return { w, s };
  }

  init(entry) {
    const { w, s } = this.#byEntry(entry);
    if (!w) return null;
    const me = this.ctl.identity();
    return {
      windowId: entry.meta.windowId,
      target: w.target,
      targetLabel: targetLabel(w.target),
      mode: w.mode,
      prefs: this.ctl.config.get().viewer,
      sync: w.sync,
      me: { id: me.id, name: me.name },
      // nessuna sessione legata alla finestra (es. pagina ricaricata dopo un errore): chiusa
      ui: s?.ui || { state: 'closed', reason: 'ended' },
    };
  }

  signal(entry, data) {
    const { s } = this.#byEntry(entry);
    if (s && data && (data.k === 'sdp' || data.k === 'ice')) this.manager.signal(s.sid, data);
  }

  rtc(entry, state, info = {}) {
    const { s } = this.#byEntry(entry);
    if (!s) return;
    if (state === 'connected') this.manager.rtcConnected(s.sid, info);
    else if (state === 'failed') this.manager.rtcFailed(s.sid, info.reason || 'webrtc-failed');
  }

  close(entry) {
    const { w, s } = this.#byEntry(entry);
    if (s) this.manager.close(s.sid);
    if (w) {
      w.allowClose = true;
      if (!w.win.isDestroyed()) w.win.close();
    }
  }

  disconnect(entry) {
    const { s } = this.#byEntry(entry);
    if (s) this.manager.close(s.sid);
  }

  reconnect(entry) {
    const { s } = this.#byEntry(entry);
    if (s) this.manager.close(s.sid, 'viewer-closed');
    this.#connect(entry.meta.windowId);
  }

  setTitle(entry, title) {
    const { w } = this.#byEntry(entry);
    if (w && typeof title === 'string') w.win.setTitle(title.slice(0, 120));
  }

  setFullscreen(entry, on) {
    const { w } = this.#byEntry(entry);
    if (w) w.win.setFullScreen(Boolean(on));
  }

  setSync(entry, on) {
    const { w } = this.#byEntry(entry);
    if (!w) return;
    w.sync = Boolean(on);
    this.ctl.config.update({ viewer: { clipboardSync: w.sync } });
    this.ctl.updateClipboardUsage();
  }

  savePrefs(patch) {
    const allowed = {};
    for (const k of ['quality', 'codec', 'scaleMode', 'showStats', 'audio', 'micDevice', 'micLabel', 'speakerDevice']) if (patch && k in patch) allowed[k] = patch[k];
    if (Object.keys(allowed).length) this.ctl.config.update({ viewer: allowed });
  }

  /** Permessi cambiati dal remoto durante la sessione (arrivano sul canale dati). */
  updatePerms(entry, perms) {
    const { s } = this.#byEntry(entry);
    if (s && perms && typeof perms === 'object') {
      s.perms = { ...s.perms, ...perms };
      this.ctl.updateClipboardUsage();
    }
  }

  hostInfo(entry, info) {
    const { w, s } = this.#byEntry(entry);
    if (w && info) this.ctl.learnMac(w.target, s?.hostId, info.macs);
  }

  applyClipboard(entry, payload) {
    const { w, s } = this.#byEntry(entry);
    if (w?.sync && s?.state === 'connected' && s.perms?.clipboard) this.ctl.clipboard.apply(payload);
  }

  #onLocalClipboard(payload) {
    for (const [windowId, w] of this.wins) {
      const s = this.manager.findByWindow(windowId);
      if (w.sync && s?.state === 'connected' && s.perms?.clipboard) this.ctl.windows.send(w.win, 'viewer:local-clipboard', payload);
    }
  }

  wantsClipboard() {
    for (const [windowId, w] of this.wins) {
      const s = this.manager.findByWindow(windowId);
      if (w.sync && s?.state === 'connected' && s.perms?.clipboard) return true;
    }
    return false;
  }

  // ---------- screenshot e registrazioni ----------

  #hostLabel(entry) {
    const { w, s } = this.#byEntry(entry);
    const base = s?.hostName || (s?.hostId ? formatId(s.hostId) : w ? targetLabel(w.target) : 'remoto');
    return sanitizeFileName(base).replace(/\s+/g, '_');
  }

  /** Cartella di screenshot e registrazioni (REMOTO_MEDIA_DIR la sostituisce, per i test). */
  #mediaDir(kind) {
    if (process.env.REMOTO_MEDIA_DIR) return process.env.REMOTO_MEDIA_DIR;
    return path.join(app.getPath(kind), 'Remoto');
  }

  async saveScreenshot(entry, data) {
    const dir = this.#mediaDir('pictures');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `Remoto_${this.#hostLabel(entry)}_${stamp()}.png`);
    await fsp.writeFile(file, Buffer.from(data));
    return file;
  }

  async recordOpen(entry, ext = 'webm') {
    const { w } = this.#byEntry(entry);
    if (!w) throw new Error('Finestra non valida');
    const dir = this.#mediaDir('videos');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `Remoto_${this.#hostLabel(entry)}_${stamp()}.${ext === 'mp4' ? 'mp4' : 'webm'}`);
    const fh = await fsp.open(file, 'w');
    const handle = crypto.randomBytes(6).toString('hex');
    w.recordings.set(handle, { fh, file, chain: Promise.resolve() });
    return handle;
  }

  recordWrite(entry, handle, data) {
    const { w } = this.#byEntry(entry);
    const r = w?.recordings.get(handle);
    if (!r) return;
    const buf = Buffer.from(data);
    r.chain = r.chain.then(() => r.fh.write(buf)).catch((err) => this.ctl.log.warn(`registrazione: ${err.message}`));
  }

  async recordClose(entry, handle) {
    const { w } = this.#byEntry(entry);
    const r = w?.recordings.get(handle);
    if (!r) return null;
    w.recordings.delete(handle);
    await r.chain;
    await r.fh.close();
    return r.file;
  }

  showItem(p) {
    if (typeof p === 'string' && fs.existsSync(p)) shell.showItemInFolder(p);
  }
}
