// Controller dell'applicazione: identità, rete (server ID, LAN, server integrato), finestre,
// servizi condivisi. La logica lato host e lato viewer sta in host-side.js e viewer-side.js.
import { app, screen, clipboard, ClipboardItem, shell, session, Notification, net } from 'electron';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { ConfigStore } from './config.js';
import { createLogger } from './logger.js';
import { crypt } from './secure.js';
import { WindowManager } from './windows/window-manager.js';
import { ServerLink } from './net/server-link.js';
import { DirectListener } from './net/direct.js';
import { Discovery, localMacs } from './net/discovery.js';
import { UdpHub } from './net/lan-udp.js';
import { rankAddresses, primaryAddress } from './net/addresses.js';
import { FileService } from './features/files.js';
import { ClipboardBridge } from './features/clipboard.js';
import { isAdmin } from './features/system.js';
import { ServiceManager } from './features/service-manager.js';
import { VirtualCableInstaller } from './features/virtual-cable.js';
import { ClipTemp } from './features/clip-temp.js';
import { clipboardFiles } from './native/clipboard-files.js';
import { win32 } from './native/win32.js';
import { HostSide } from './host-side.js';
import { ViewerSide } from './viewer-side.js';
import { registerIpc } from './ipc.js';
import { createTray } from './tray.js';
import { createRendezvousServer } from '../server/core.js';
import { generateId, isValidId, parseTarget, targetKey } from '../shared/ids.js';
import { DEFAULT_PORTS, normalizeServerUrl, sanitizeName } from '../shared/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..');

export class RemotoApp {
  constructor({ version, startHidden = false, profile = null }) {
    this.version = version;
    this.startHidden = startHidden;
    this.profile = profile;
    this.quitting = false;
    this.secretCache = null;
    this.embedded = null;
    this.embeddedState = { running: false, port: null, error: null };
    this.overrides = {
      directHost: process.env.REMOTO_DIRECT_HOST || null,
      directPort: process.env.REMOTO_DIRECT_PORT ? Number(process.env.REMOTO_DIRECT_PORT) : null,
      discovery: process.env.REMOTO_DISCOVERY === '0' ? false : null,
      discoveryPort: process.env.REMOTO_DISCOVERY_PORT ? Number(process.env.REMOTO_DISCOVERY_PORT) : null,
      // per i test: annunci verso destinazioni fisse ("127.0.0.1:47902,...") al posto del broadcast
      discoveryTargets: process.env.REMOTO_DISCOVERY_TARGETS ? process.env.REMOTO_DISCOVERY_TARGETS.split(',').filter(Boolean) : null,
    };
    this.assets = {
      icon: path.join(SRC, 'assets', 'icon.png'),
      tray: path.join(SRC, 'assets', 'tray.png'),
      trayActive: path.join(SRC, 'assets', 'tray-active.png'),
    };
  }

  async start() {
    const userData = app.getPath('userData');
    this.log = createLogger(path.join(userData, 'logs'), { toConsole: !app.isPackaged });
    this.log.info(`Remoto ${this.version} avvio (profilo ${userData})`);
    this.config = new ConfigStore({ file: path.join(userData, 'config.json'), crypt });
    this.config.load();
    this.#applyEnvConfig();
    this.#ensureIdentity();

    this.windows = new WindowManager({
      rendererDir: path.join(SRC, 'renderer'),
      preload: path.join(SRC, 'preload', 'bridge.cjs'),
      icon: this.assets.icon,
      log: this.log,
    });
    this.#setupPermissions();

    this.files = new FileService({
      specialFolders: {
        home: app.getPath('home'),
        desktop: app.getPath('desktop'),
        documents: app.getPath('documents'),
        downloads: app.getPath('downloads'),
        pictures: app.getPath('pictures'),
        videos: app.getPath('videos'),
        music: app.getPath('music'),
      },
    });
    // la finestra nascosta dell'engine fa da proprietaria degli appunti quando vi si mettono i file ricevuti
    const ownerHwnd = () => {
      const w = this.hostSide?.engineWin;
      return w && !w.isDestroyed() ? w.getNativeWindowHandle().readBigUInt64LE(0) : 0n;
    };
    this.clipboard = new ClipboardBridge({ clipboard, ClipboardItem, sequence: () => win32()?.getClipboardSequenceNumber() ?? null, files: clipboardFiles(ownerHwnd) });
    this.clipTemp = new ClipTemp(path.join(app.getPath('temp'), 'Remoto-appunti'));
    this.clipTemp.cleanAll();

    this.link = new ServerLink({
      getIdentity: () => this.identity(),
      onIdTaken: () => this.#regenerateId('il server ha rifiutato l’ID'),
      logger: this.log,
      version: this.version,
    });
    this.direct = null;
    this.discovery = new Discovery({
      port: this.overrides.discoveryPort || DEFAULT_PORTS.discovery,
      getAnnouncement: () => this.#announcement(),
      targets: this.overrides.discoveryTargets,
      logger: this.log,
    });
    // segnalazione UDP sulla stessa porta del rilevamento (vedi lan-udp.js)
    this.lanUdp = new UdpHub({
      send: (buf, port, address) => this.discovery.sendRaw(buf, port, address),
      getIdentity: () => this.identity(),
      logger: this.log,
    });
    this.discovery.onDatagram = (m, rinfo) => this.lanUdp.handle(m, rinfo);

    this.hostSide = new HostSide(this);
    this.viewerSide = new ViewerSide(this);
    this.serviceManager = new ServiceManager({ logger: this.log });
    this.cable = new VirtualCableInstaller({ dir: path.join(app.getPath('temp'), 'Remoto-cavo-audio'), fetch: (url) => net.fetch(url), logger: this.log });
    this.serviceCache = { supported: process.platform === 'win32', bundled: false, installed: false, running: false, canInstall: false, reason: '' };
    this.host = this.hostSide.manager;
    this.viewer = this.viewerSide.manager;
    this.log.info(`controllo remoto di mouse e tastiera: ${this.hostSide.input.available ? 'disponibile (SendInput)' : 'non disponibile su questo sistema'}; amministratore: ${isAdmin() ? 'sì' : 'no'}`);

    this.lanUdp.on('incoming', (transport, meta) => {
      this.log.info(`richiesta in LAN via UDP da ${meta.address}`);
      this.host.addTransport(transport);
    });
    this.link.on('state', () => this.pushStatus());
    this.link.on('relay', ({ from, sid, data }) => {
      if (this.viewer.handleRelay(from, sid, data)) return;
      this.host.handleRelay(this.link, from, sid, data);
    });
    this.link.on('relay-fail', ({ to, sid, code }) => {
      if (this.viewer.handleRelayFail(to, sid, code)) return;
      this.host.handleRelayFail(to, sid);
    });
    this.discovery.on('change', (peers) => this.windows.sendRole('home', 'home:peers', peers));
    this.config.on('change', (_c, patch) => this.#onConfigChange(patch));

    registerIpc(this);
    this.hostSide.createEngine();
    this.tray = createTray(this);
    if (!this.startHidden) this.showHome();

    screen.on('display-added', () => this.hostSide.displaysChanged());
    screen.on('display-removed', () => this.hostSide.displaysChanged());
    screen.on('display-metrics-changed', () => this.hostSide.displaysChanged());

    await this.#applyNetwork();
    this.#refreshPrimaryAddress();
    // la scheda di rete in uso può cambiare (Wi-Fi ↔ cavo, VPN): si ricontrolla ogni tanto
    setInterval(() => this.#refreshPrimaryAddress(), 30_000).unref?.();
    this.#applyLoginItem();
    if (process.platform === 'win32') this.serviceStatus().catch(() => {});
    if (process.env.REMOTO_E2E === '1') globalThis.__remoto = this;
  }

  // ---------- identità ----------

  identity() {
    const c = this.config.get();
    if (this.secretCache === null) this.secretCache = this.config.decrypt(c.identity.secret);
    return { id: c.identity.id, secret: this.secretCache, name: c.profile.name };
  }

  #ensureIdentity() {
    const c = this.config.get();
    const patch = {};
    if (!isValidId(c.identity.id)) patch.id = generateId();
    if (!this.config.decrypt(c.identity.secret)) patch.secret = this.config.encrypt(crypto.randomBytes(32).toString('hex'));
    if (Object.keys(patch).length) {
      this.config.update({ identity: patch });
      this.log.info(`identità: ID ${this.config.get().identity.id}`);
    }
    this.secretCache = null;
  }

  #regenerateId(why) {
    const id = generateId();
    this.log.warn(`nuovo ID ${id}: ${why}`);
    this.config.update({ identity: { id, secret: this.config.encrypt(crypto.randomBytes(32).toString('hex')) } });
    this.secretCache = null;
    this.pushStatus();
    this.tray?.update();
  }

  #announcement() {
    const me = this.identity();
    return { id: me.id, name: me.name, port: this.direct?.listening ? this.direct.port : 0, macs: localMacs(), os: `${os.type()} ${os.release()}` };
  }

  /** Variabili d'ambiente per test e installazioni preconfigurate. */
  #applyEnvConfig() {
    const patch = {};
    if (process.env.REMOTO_SERVER_URL !== undefined) patch.network = { serverUrl: process.env.REMOTO_SERVER_URL };
    if (process.env.REMOTO_NAME) patch.profile = { name: sanitizeName(process.env.REMOTO_NAME) };
    // i test girano sul PC dello sviluppatore: le sue casse e i suoi microfoni non si toccano
    if (process.env.REMOTO_AUDIO_EXCLUSIVE !== undefined) patch.audio = { exclusive: process.env.REMOTO_AUDIO_EXCLUSIVE !== '0' };
    if (Object.keys(patch).length) this.config.update(patch);
  }

  // ---------- configurazione ----------

  updateConfig(patch) {
    return this.config.update(patch);
  }

  #onConfigChange(patch) {
    if (patch.network || patch.embeddedServer) this.#applyNetwork().catch((err) => this.log.error(`rete: ${err.message}`));
    if (patch.profile) {
      this.link.reconnect();
      this.discovery.announce();
    }
    if (patch.general) this.#applyLoginItem();
    if (patch.audio) this.hostSide.audioPrefsChanged();
    this.windows.sendRole('home', 'home:config', this.publicConfig());
    this.tray?.update();
  }

  /** Configurazione senza segreti, per le pagine. */
  publicConfig() {
    const c = this.config.get();
    return {
      profile: c.profile,
      network: c.network,
      embeddedServer: c.embeddedServer,
      security: {
        allowIncoming: c.security.allowIncoming,
        permissions: c.security.permissions,
        acl: c.security.acl,
        maxSessions: c.security.maxSessions,
        lockOnEnd: c.security.lockOnEnd,
      },
      viewer: c.viewer,
      audio: c.audio,
      general: c.general,
      addressBook: c.addressBook,
      recent: c.recent,
    };
  }

  #applyLoginItem() {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return;
    const want = Boolean(this.config.get().general.startWithWindows);
    // in sviluppo (electron.exe) si tocca il registro solo se l'utente l'ha chiesto
    if (!app.isPackaged && !want && !this.loginItemTouched) return;
    this.loginItemTouched = true;
    const args = app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
    if (this.profile) args.push(`--profile=${this.profile}`);
    try {
      // nel .exe portable autoestraente process.execPath è la copia temporanea: serve l'originale
      app.setLoginItemSettings({ openAtLogin: want, path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args });
    } catch (err) {
      this.log.warn(`avvio automatico: ${err.message}`);
    }
  }

  // ---------- rete ----------

  async #applyNetwork() {
    const c = this.config.get();

    // server integrato (prima del collegamento: chi lo usa in locale lo trova già acceso)
    const es = c.embeddedServer;
    if (es.enabled && (!this.embedded || this.embeddedState.port !== es.port)) {
      await this.#stopEmbedded();
      try {
        this.embedded = createRendezvousServer({ port: es.port, host: '0.0.0.0', dataDir: path.join(app.getPath('userData'), 'server'), logger: this.log, name: `Server ID di ${c.profile.name}` });
        await this.embedded.start();
        this.embeddedState = { running: true, port: es.port, error: null };
      } catch (err) {
        this.embedded = null;
        this.embeddedState = { running: false, port: es.port, error: err.code === 'EADDRINUSE' ? `Porta ${es.port} già in uso` : err.message };
        this.log.error(`server integrato: ${err.message}`);
      }
    } else if (!es.enabled && this.embedded) await this.#stopEmbedded();

    // server ID
    this.link.setUrl(normalizeServerUrl(c.network.serverUrl));
    if (!this.link.running) this.link.start();

    // connessioni dirette LAN
    const wantDirect = c.network.direct.enabled;
    const port = this.overrides.directPort ?? c.network.direct.port;
    const host = this.overrides.directHost || '0.0.0.0';
    if (this.direct && (!wantDirect || this.direct.port !== port || this.direct.host !== host)) {
      await this.direct.stop();
      this.direct = null;
    }
    if (wantDirect && !this.direct) {
      // porta occupata (es. seconda istanza con --profile): si provano le successive
      const attempts = port === 0 ? [0] : Array.from({ length: 11 }, (_, i) => port + i);
      for (const p of attempts) {
        const listener = new DirectListener({ port: p, host, getIdentity: () => this.identity(), logger: this.log });
        listener.on('incoming', (transport) => this.host.addTransport(transport));
        try {
          await listener.start();
          this.direct = listener;
          this.directError = null;
          if (p !== port) this.log.info(`connessioni dirette sulla porta ${p} (la ${port} è occupata)`);
          break;
        } catch (err) {
          this.directError = listener.error || err.message;
          if (err.code !== 'EADDRINUSE') break;
        }
      }
      if (!this.direct) this.log.warn(`connessioni dirette: ${this.directError}`);
      this.discovery.announce();
    }

    // rilevamento LAN
    const wantDiscovery = this.overrides.discovery ?? c.network.discovery.enabled;
    if (wantDiscovery && !this.discovery.running) await this.discovery.start().catch((err) => this.log.warn(`rilevamento LAN: ${err.message}`));
    else if (!wantDiscovery && this.discovery.running) {
      this.lanUdp.closeAll('discovery-off');
      this.discovery.stop();
    }

    this.pushStatus();
  }

  async #stopEmbedded() {
    if (!this.embedded) return;
    await this.embedded.stop().catch(() => {});
    this.embedded = null;
    this.embeddedState = { running: false, port: null, error: null };
  }

  async #refreshPrimaryAddress() {
    const prev = this.primaryAddr;
    this.primaryAddr = await primaryAddress();
    if (prev !== undefined && prev !== this.primaryAddr) this.pushStatus();
  }

  /** Indirizzi di questa postazione, quello giusto per primo (vedi net/addresses.js). */
  localAddresses() {
    return rankAddresses(os.networkInterfaces(), this.primaryAddr || null);
  }

  status() {
    const c = this.config.get();
    return {
      server: { url: normalizeServerUrl(c.network.serverUrl), state: this.link.state, detail: this.link.detail },
      direct: { enabled: c.network.direct.enabled, listening: Boolean(this.direct?.listening), port: this.direct?.port || c.network.direct.port, error: this.direct ? null : this.directError || null },
      discovery: { enabled: c.network.discovery.enabled, running: this.discovery.running, count: this.discovery.peers().length },
      embedded: { ...this.embeddedState, enabled: c.embeddedServer.enabled },
      addresses: this.localAddresses(),
      admin: isAdmin(),
      fullControl: { ...this.serviceCache, ...this.hostSide.serviceState() },
      hostSessions: this.host.list(),
    };
  }

  /** Stato del servizio "controllo completo" (installato/in esecuzione/collegato). */
  async serviceStatus() {
    this.serviceCache = await this.serviceManager.status();
    this.pushStatus();
    return { ...this.serviceCache, ...this.hostSide.serviceState() };
  }

  /** Installa VB-CABLE (pacchetto ufficiale, firma verificata, UAC): poi la voce di chi controlla lo usa da sola. */
  async installVirtualCable() {
    const step = (s) => {
      this.windows.sendRole('home', 'audio:cable-step', s);
      this.windows.sendRole('panel', 'audio:cable-step', s);
    };
    const r = await this.cable.install(step);
    step(r.ok ? 'done' : 'failed');
    // i dispositivi nuovi compaiono dopo qualche istante: l'engine ricollega il microfono remoto
    if (r.ok) setTimeout(() => this.hostSide.audioPrefsChanged(), 3000);
    return r;
  }

  async installService() {
    const r = await this.serviceManager.install();
    await this.serviceStatus();
    return r;
  }

  async uninstallService() {
    const r = await this.serviceManager.uninstall();
    await this.serviceStatus();
    return r;
  }

  pushStatus() {
    this.windows?.sendRole('home', 'home:status', this.status());
    this.tray?.update();
  }

  // ---------- finestre e utilità ----------

  #setupPermissions() {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      const role = this.windows.entry(wc)?.role;
      if (permission === 'media') {
        const types = details.mediaTypes || [];
        // l'engine cattura lo schermo; la sessione solo il microfono, mai la webcam
        return callback(role === 'engine' || (role === 'session' && !types.includes('video')));
      }
      if (permission === 'speaker-selection') return callback(role === 'engine' || role === 'session');
      if (permission === 'fullscreen') return callback(role === 'session');
      if (permission === 'clipboard-sanitized-write') return callback(true);
      return callback(false);
    });
    ses.setPermissionCheckHandler((wc, permission) => {
      const role = wc ? this.windows.entry(wc)?.role : null;
      if (permission === 'media') return role === 'engine' || role === 'session' || role === 'home';
      if (permission === 'speaker-selection') return role === 'engine' || role === 'session' || role === 'home';
      if (permission === 'fullscreen') return role === 'session';
      return permission === 'clipboard-sanitized-write';
    });
  }

  showHome() {
    let win = this.windows.first('home');
    if (!win) {
      win = this.windows.create('home', {
        page: 'home/index.html',
        width: 1080,
        height: 700,
        minWidth: 880,
        minHeight: 600,
        show: false,
        title: 'Remoto',
      });
      win.once('ready-to-show', () => win.show());
      win.webContents.on('render-process-gone', () => {
        if (!this.quitting && !win.isDestroyed()) setTimeout(() => !win.isDestroyed() && win.reload(), 500);
      });
      win.on('close', (e) => {
        if (!this.quitting && this.config.get().general.closeToTray) {
          e.preventDefault();
          win.hide();
          if (!this.config.get().general.trayHintShown) {
            this.config.update({ general: { trayHintShown: true } });
            this.notify('Remoto è ancora attivo', 'Resta nell’area di notifica per accettare le connessioni. Per uscire usa “Esci da Remoto” nel menu dell’icona.');
          }
        }
      });
    } else {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    return win;
  }

  /** File ricevuti dagli appunti dell'altro PC (cartella creata da clipTemp) → appunti di questo PC. */
  async applyClipboardFiles(dir) {
    if (!this.clipTemp.owns(dir)) throw new Error('Cartella non valida');
    const paths = await this.clipTemp.entries(dir);
    if (!paths.length || !this.clipboard.applyFiles(paths)) throw new Error('Appunti di Windows non disponibili');
    this.log.info(`appunti: ${paths.length} file pronti da incollare`);
    return { count: paths.length, names: paths.map((p) => path.basename(p)).slice(0, 5) };
  }

  copyText(text) {
    Promise.resolve(clipboard.writeText(String(text ?? ''))).catch(() => {});
  }

  notify(title, body, onClick) {
    if (!Notification.isSupported()) return;
    try {
      const n = new Notification({ title, body, icon: this.assets.icon, silent: false });
      // riferimento tenuto finché la notifica è viva, altrimenti il clic andrebbe perso
      this.notifications ||= new Set();
      this.notifications.add(n);
      const drop = () => this.notifications.delete(n);
      n.on('click', () => {
        drop();
        onClick?.();
      });
      n.on('close', drop);
      n.on('failed', drop);
      n.show();
    } catch {
      /* notifiche disattivate */
    }
  }

  openExternal(url) {
    if (/^https:\/\//i.test(String(url))) shell.openExternal(url);
  }

  async quit() {
    if (this.quitting) return;
    this.quitting = true;
    try {
      this.host.closeAll('host-closed');
      this.viewer.closeAll('viewer-closed');
      this.hostSide.shutdown();
      this.link.stop();
      this.lanUdp.closeAll('closed');
      this.discovery.stop();
      await this.direct?.stop();
      await this.#stopEmbedded();
      await this.files.closeAll();
    } catch (err) {
      this.log.error(`chiusura: ${err.message}`);
    }
    this.tray?.destroy();
    app.quit();
  }

  // ---------- rubrica e recenti ----------

  saveBookEntry(entry) {
    const target = parseTarget(entry?.input, DEFAULT_PORTS.direct);
    if (!target) return { ok: false, error: 'ID o indirizzo non valido' };
    const key = targetKey(target);
    const list = this.config.get().addressBook.filter((e) => e.key !== key && e.key !== entry.oldKey);
    const prev = this.config.get().addressBook.find((e) => e.key === key || e.key === entry.oldKey);
    list.unshift({
      key,
      target,
      alias: sanitizeName(entry.alias, ''),
      notes: String(entry.notes || '').slice(0, 500),
      mac: typeof entry.mac === 'string' ? entry.mac.slice(0, 17) : prev?.mac || '',
      createdAt: prev?.createdAt || Date.now(),
    });
    this.config.set('addressBook', list.slice(0, 500));
    return { ok: true, key };
  }

  removeBookEntry(key) {
    this.config.set('addressBook', this.config.get().addressBook.filter((e) => e.key !== key));
  }

  addRecent({ target, hostId, hostName }) {
    const key = targetKey(target);
    const recent = this.config.get().recent;
    const prev = recent.find((e) => e.key === key);
    const entry = { key, target, hostId: hostId || prev?.hostId || null, name: hostName || prev?.name || '', lastConnected: Date.now(), count: (prev?.count || 0) + 1, mac: prev?.mac || '' };
    this.config.set('recent', [entry, ...recent.filter((e) => e.key !== key)].slice(0, 40));
  }

  /** MAC comunicati dall'host in sessione: servono al Wake-on-LAN dalla rubrica. */
  learnMac(target, hostId, macs) {
    const mac = Array.isArray(macs) ? macs.find((m) => typeof m === 'string' && /^[0-9a-f:]{17}$/i.test(m)) : null;
    if (!mac) return;
    const c = this.config.get();
    const key = targetKey(target);
    const match = (e) => e.key === key || (hostId && (e.hostId === hostId || e.target?.id === hostId));
    if (c.recent.some(match)) this.config.set('recent', c.recent.map((e) => (match(e) ? { ...e, mac } : e)));
    if (c.addressBook.some(match)) this.config.set('addressBook', c.addressBook.map((e) => (match(e) && !e.mac ? { ...e, mac } : e)));
  }

  addAccessLog(entry) {
    const log = [entry, ...this.config.get().accessLog].slice(0, 300);
    this.config.set('accessLog', log);
  }

  async displays() {
    return this.hostSide.displays();
  }

  /** Il controllo degli appunti gira solo se una sessione (host o viewer) lo usa. */
  updateClipboardUsage() {
    const need = this.hostSide.wantsClipboard() || this.viewerSide.wantsClipboard();
    if (need && !this.clipboardRetained) {
      this.clipboard.retain();
      this.clipboardRetained = true;
    } else if (!need && this.clipboardRetained) {
      this.clipboard.release();
      this.clipboardRetained = false;
    }
  }
}
