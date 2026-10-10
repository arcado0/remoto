// Lato "postazione controllata": collega HostManager all'engine nascosto (WebRTC e cattura),
// alla finestra di accettazione, al pannello di sessione e alle funzioni di sistema.
// Ogni richiesta arrivata dal viewer viene autorizzata qui, sui permessi della sessione.
import { app, screen, desktopCapturer, nativeImage } from 'electron';
import path from 'node:path';
import { HostManager } from './sessions/host-manager.js';
import { InputInjector } from './native/input.js';
import { ServiceClient } from './native/service-client.js';
import { win32 } from './native/win32.js';
import { PrivacyOverlay, WhiteboardOverlay } from './features/overlays.js';
import { InputBlocker, isAdmin, lockWorkstation, restartComputer } from './features/system.js';
import { AudioRedirect } from './features/audio-redirect.js';
import * as audioDevices from './native/audio-devices.js';
import { formatId } from '../shared/ids.js';
import { sharesSubnet } from '../shared/netinfo.js';
import os from 'node:os';
import { TIMEOUTS, LIMITS } from '../shared/protocol.js';

// Fotogrammi del desktop protetto (UAC/blocco) inviati dal servizio: quante volte al secondo e larghezza massima.
const SECURE_FPS = 9;
const SECURE_MAX_WIDTH = 1600;

export class HostSide {
  constructor(ctl) {
    this.ctl = ctl;
    this.input = new InputInjector();
    this.privacy = new PrivacyOverlay({ windows: ctl.windows, screen });
    this.whiteboard = new WhiteboardOverlay({ windows: ctl.windows, screen });
    this.blocker = new InputBlocker();
    this.extras = new Map(); // id sessione → stato locale (monitor, chat, handle file)
    this.engineWin = null;
    this.engineReady = false;
    this.engineQueue = [];
    this.displayCache = [];
    this.panel = null;
    this.prompts = new Map(); // id sessione → { win, finish, request }
    // servizio "controllo completo" (facoltativo): se installato e in esecuzione, input e cattura passano
    // da lì e superano i limiti di sistema (finestre di amministratore, richieste UAC, schermata di blocco).
    this.service = this.#createService();
    if (this.service) this.input.setSink(this.service);
    this.secureTimer = null;
    // casse e microfono di questo PC disattivati durante le sessioni (audio solo da chi controlla)
    this.audio = new AudioRedirect({
      devices: audioDevices,
      file: path.join(app.getPath('userData'), 'audio-ripristino.json'),
      enabled: () => ctl.config.get().audio?.exclusive !== false,
      logger: { info: (m) => ctl.log.info(m), warn: (m) => ctl.log.warn(m) },
    });
    this.audio.recover();

    this.manager = new HostManager({
      getSettings: () => this.#settings(),
      getIdentity: () => ctl.identity(),
      engine: {
        start: (info) => this.#engineStart(info),
        signal: (id, data) => this.#toEngine('engine:signal', id, data),
        stop: (id) => this.#toEngine('engine:stop', id),
        setPermissions: (id, perms) => this.#onPerms(id, perms),
      },
      prompts: { open: (req) => this.#openPrompt(req) },
    });
    this.manager.on('change', (list) => this.#onSessionsChanged(list));
    this.manager.on('active', (s) => this.#onActive(s));
    this.manager.on('ended', (s, reason) => this.#onEnded(s, reason));
    this.manager.on('log', (entry) => ctl.addAccessLog(entry));
    ctl.clipboard.on('change', (payload) => this.#onLocalClipboard(payload));
  }

  #settings() {
    const c = this.ctl.config.get();
    return {
      allowIncoming: c.security.allowIncoming,
      permissions: c.security.permissions,
      acl: c.security.acl,
      maxSessions: c.security.maxSessions,
    };
  }

  // ---------- servizio "controllo completo" ----------

  #createService() {
    if (process.platform !== 'win32') return null;
    const sid = win32()?.sessionId?.();
    if (sid == null) return null;
    const client = new ServiceClient({
      pipePath: `\\\\.\\pipe\\remoto-input-${sid}`,
      logger: { info: (m) => this.ctl.log.info(m), warn: (m) => this.ctl.log.warn(m) },
      retryMs: 8000,
    });
    client.on('state', (up) => this.#onServiceState(up));
    client.on('desktop', () => this.#onDesktop());
    return client;
  }

  /** Capacità extra da annunciare al viewer: controllo completo e invio di Ctrl+Alt+Canc. */
  caps() {
    const on = Boolean(this.service?.connected);
    return { fullControl: on, sas: on };
  }

  /** Avvia la connessione al servizio quando c'è una sessione in corso (altrimenti resta fermo). */
  #ensureService() {
    if (this.service && !this.service.running) this.service.start();
  }

  #onServiceState(up) {
    this.ctl.log.info(up ? 'controllo completo disponibile: servizio collegato' : 'controllo completo non più disponibile');
    this.#toEngine('engine:caps', this.caps());
    this.#onDesktop();
    this.ctl.pushStatus();
  }

  /** Cambio di desktop sul controllato: su desktop protetto si passa ai fotogrammi del servizio. */
  #onDesktop() {
    const secure = Boolean(this.service?.secure);
    if (secure && !this.secureTimer) this.#startSecure();
    else if (!secure && this.secureTimer) this.#stopSecure();
  }

  #startSecure() {
    this.ctl.log.info(`desktop protetto attivo (${this.service.desktop}): i fotogrammi arrivano dal servizio`);
    this.#toEngine('engine:secure', true);
    const tick = async () => {
      if (!this.service?.secure) return this.#stopSecure();
      try {
        const f = await this.service.capture(SECURE_MAX_WIDTH);
        const jpeg = nativeImage.createFromBitmap(f.data, { width: f.w, height: f.h }).toJPEG(72);
        this.#toEngine('engine:secure-frame', { w: f.w, h: f.h, jpeg });
      } catch (err) {
        this.ctl.log.warn(`cattura desktop protetto: ${err.message}`);
      }
      if (this.secureTimer) this.secureTimer = setTimeout(tick, Math.round(1000 / SECURE_FPS));
      return undefined;
    };
    this.secureTimer = setTimeout(tick, 0);
  }

  #stopSecure() {
    if (!this.secureTimer) return;
    clearTimeout(this.secureTimer);
    this.secureTimer = null;
    this.#toEngine('engine:secure', false);
  }

  #sas() {
    if (this.service?.connected) this.service.sas().catch((err) => this.ctl.log.warn(`Ctrl+Alt+Canc: ${err.message}`));
    else this.ctl.log.info('Ctrl+Alt+Canc ignorato: servizio di controllo completo non disponibile');
  }

  /** Stato per la finestra principale e il vassoio. */
  serviceState() {
    return { connected: Boolean(this.service?.connected), secure: Boolean(this.service?.secure) };
  }

  // ---------- engine ----------

  createEngine() {
    this.engineReady = false;
    const win = this.ctl.windows.create('engine', {
      page: 'engine/engine.html',
      show: false,
      width: 640,
      height: 480,
      skipTaskbar: true,
      webPreferences: { backgroundThrottling: false },
    });
    win.webContents.on('render-process-gone', (_e, d) => {
      this.ctl.log.error(`engine terminato (${d.reason}): chiusura delle sessioni`);
      this.engineReady = false;
      this.manager.closeAll('error');
      if (!this.ctl.quitting) setTimeout(() => this.createEngine(), 1000);
    });
    this.engineWin = win;
  }

  engineLoaded() {
    this.engineReady = true;
    const queue = this.engineQueue;
    this.engineQueue = [];
    for (const [channel, args] of queue) this.ctl.windows.send(this.engineWin, channel, ...args);
  }

  #toEngine(channel, ...args) {
    if (!this.engineReady) {
      this.engineQueue.push([channel, args]);
      return;
    }
    this.ctl.windows.send(this.engineWin, channel, ...args);
  }

  #engineStart(info) {
    const s = this.manager.get(info.id);
    const c = this.ctl.config.get();
    const primary = screen.getPrimaryDisplay();
    this.extras.set(info.id, { displayId: String(primary.id), chat: [], reads: new Set(), writes: new Set(), ctxs: new Set() });
    this.#ensureService();
    const extra = Array.isArray(c.network.iceServers) ? c.network.iceServers : [];
    const ice = s?.kind === 'relay' ? [...(this.ctl.link.iceServers || []), ...extra] : extra;
    const exclusiveAudio = c.audio?.exclusive !== false && this.audio.available;
    // stessa rete locale (connessione diretta, o via server ma nella stessa sottorete): banda da LAN da subito
    const lan = info.kind === 'direct' || sharesSubnet(info.viewerAddrs, os.networkInterfaces());
    this.#toEngine('engine:start', { ...info, iceServers: ice, hostName: this.ctl.identity().name, admin: isAdmin(), caps: this.caps(), platform: process.platform, exclusiveAudio, lan });
  }

  async displays() {
    const all = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    let sources = [];
    try {
      sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    } catch (err) {
      this.ctl.log.warn(`elenco schermi: ${err.message}`);
    }
    this.displayCache = all.map((d, i) => {
      const src = sources.find((x) => String(x.display_id) === String(d.id)) || sources[i] || null;
      const phys =
        process.platform === 'win32'
          ? screen.dipToScreenRect(null, d.bounds)
          : { x: Math.round(d.bounds.x * d.scaleFactor), y: Math.round(d.bounds.y * d.scaleFactor), width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) };
      return { id: String(d.id), sourceId: src?.id || null, label: `Schermo ${i + 1}`, primary: d.id === primary.id, width: phys.width, height: phys.height, phys, scaleFactor: d.scaleFactor };
    });
    return this.displayCache;
  }

  #rectFor(displayId) {
    const d = this.displayCache.find((x) => x.id === displayId) || this.displayCache.find((x) => x.primary) || this.displayCache[0];
    if (d) return d.phys;
    const p = screen.getPrimaryDisplay();
    return process.platform === 'win32' ? screen.dipToScreenRect(null, p.bounds) : p.bounds;
  }

  async displaysChanged() {
    this.input.refresh();
    const list = await this.displays();
    this.privacy.refresh();
    this.#toEngine('engine:displays-changed', list);
  }

  // ---------- richieste dall'engine (già passate dai permessi dell'engine, ricontrollate qui) ----------

  #session(id, perm) {
    const s = this.manager.get(id);
    if (!s || (s.state !== 'active' && s.state !== 'connecting')) return null;
    if (perm && !s.perms?.[perm]) return null;
    return s;
  }

  onEngineState(id, state, info = {}) {
    if (state === 'connected') this.manager.engineConnected(id, info);
    else if (state === 'failed') this.manager.engineFailed(id, info.reason || 'webrtc-failed');
    else if (state === 'info') this.manager.engineConnected(id, info);
  }

  onInput(id, msg) {
    const s = this.manager.get(id);
    if (!s || s.state !== 'active' || !s.perms?.control || !msg) return;
    // sul desktop protetto il servizio cattura il monitor principale: le coordinate vanno riferite a quello
    const rect = this.service?.secure ? this.#rectFor(null) : this.#rectFor(this.extras.get(id)?.displayId);
    switch (msg.t) {
      case 'mm':
        this.input.move(rect, msg.x, msg.y);
        break;
      case 'mb':
        this.input.button(id, rect, msg.b, Boolean(msg.d), msg.x, msg.y);
        break;
      case 'mw':
        this.input.wheel(rect, msg.dx, msg.dy, msg.x, msg.y);
        break;
      case 'k':
        this.input.key(id, msg.c, Boolean(msg.d), msg.key);
        break;
      case 'text':
        if (typeof msg.s === 'string') this.input.text(msg.s);
        break;
      case 'combo':
        // Ctrl+Alt+Canc vero richiede il servizio (SendInput non può generarlo): lì passa di lì
        if (String(msg.name) === 'ctrl-alt-del') this.#sas();
        else this.input.combo(id, String(msg.name));
        break;
      case 'release':
        this.input.releaseAll(id);
        break;
      default:
        break;
    }
  }

  onDisplay(id, displayId) {
    const e = this.extras.get(id);
    if (e) e.displayId = String(displayId);
  }

  onClipboardIn(id, payload) {
    if (this.#session(id, 'clipboard')) this.ctl.clipboard.apply(payload);
  }

  /** File dagli appunti di chi controlla: solo con i permessi "Appunti" e "File", in una cartella scelta qui. */
  async clipFilesPrepare(id) {
    if (!this.#session(id, 'clipboard') || !this.#session(id, 'files')) throw new Error('Copia di file tramite appunti non consentita');
    return this.ctl.clipTemp.prepare();
  }

  async clipFilesApply(id, dir) {
    if (!this.#session(id, 'clipboard') || !this.#session(id, 'files')) throw new Error('Copia di file tramite appunti non consentita');
    return this.ctl.applyClipboardFiles(dir);
  }

  #onLocalClipboard(payload) {
    const ids = this.manager.list().filter((s) => s.state === 'active' && s.perms?.clipboard).map((s) => s.id);
    if (ids.length) this.#toEngine('engine:host-clipboard', ids, payload);
  }

  wantsClipboard() {
    return this.manager.list().some((s) => s.state === 'active' && s.perms?.clipboard);
  }

  onChatIn(id, text) {
    const e = this.extras.get(id);
    if (!e || typeof text !== 'string') return;
    const msg = { id, from: 'viewer', text: text.slice(0, LIMITS.maxChatLength), ts: Date.now() };
    e.chat.push(msg);
    this.#showPanel();
    this.ctl.windows.send(this.panel, 'panel:chat', msg);
  }

  sendChat(id, text) {
    const e = this.extras.get(id);
    if (!e || typeof text !== 'string' || !text.trim()) return;
    const msg = { id, from: 'me', text: text.slice(0, LIMITS.maxChatLength), ts: Date.now() };
    e.chat.push(msg);
    this.#toEngine('engine:host-chat', id, msg.text);
    this.ctl.windows.send(this.panel, 'panel:chat', msg);
  }

  /** Stato del microfono di chi è collegato (instradato su un cavo audio virtuale o no). */
  onMic(id, info) {
    const e = this.extras.get(id);
    if (!e || !info || typeof info !== 'object') return;
    e.mic = { active: Boolean(info.active), routed: Boolean(info.routed), device: String(info.device || '').slice(0, 120), reason: String(info.reason || '') };
    // la voce di chi controlla suona su un cavo virtuale: il suo lato "microfono" diventa quello di questo PC
    this.audio.setMic(id, e.mic.routed && this.#session(id, 'microphone') ? e.mic.device : null);
    this.#pushPanel();
  }

  /** L'engine invia (o smette di inviare) l'audio di sistema a questa sessione: le casse locali tacciono. */
  onAudioOut(id, on) {
    this.audio.setSpeakers(id, Boolean(on) && Boolean(this.#session(id, 'audio')));
    this.#pushPanel();
  }

  audioPrefsChanged() {
    this.#toEngine('engine:audio-prefs-changed');
    this.audio.refresh();
    this.#pushPanel();
  }

  #withMic(list) {
    const audio = this.audio.state();
    return list.map((s) => ({ ...s, mic: this.extras.get(s.id)?.mic || null, audio }));
  }

  #pushPanel() {
    const live = this.manager.list().filter((s) => s.state === 'connecting' || s.state === 'active');
    this.ctl.windows.send(this.panel, 'panel:sessions', this.#withMic(live));
  }

  onWhiteboard(id, msg) {
    if (!this.#session(id, 'whiteboard') || !msg) return;
    this.whiteboard.op(id, this.extras.get(id)?.displayId, msg);
  }

  setPrivacy(id, on) {
    if (!this.#session(id, 'privacy')) return { ok: false, error: 'Permesso non concesso' };
    const active = this.privacy.set(id, Boolean(on));
    return { ok: true, active };
  }

  setBlockInput(id, on) {
    if (!this.#session(id, 'blockInput')) return { ok: false, error: 'Permesso non concesso' };
    return this.blocker.set(id, Boolean(on));
  }

  async system(id, op) {
    if (!this.#session(id, 'system')) return { ok: false, error: 'Permesso non concesso' };
    if (op === 'lock') return { ok: lockWorkstation() };
    if (op === 'restart') return restartComputer(5);
    return { ok: false, error: 'Operazione sconosciuta' };
  }

  // ---------- file (permesso "File") ----------

  async fs(id, op, args = {}) {
    if (!this.#session(id, 'files')) throw new Error('Trasferimento file non consentito');
    const f = this.ctl.files;
    switch (op) {
      case 'roots':
        return f.roots();
      case 'list':
        return f.list(String(args.path));
      case 'mkdir':
        return f.mkdir(String(args.parent), String(args.name));
      case 'rename':
        return f.rename(String(args.path), String(args.name));
      case 'remove':
        return f.remove(String(args.path));
      case 'expand':
        return f.expand((Array.isArray(args.paths) ? args.paths : []).map(String));
      default:
        throw new Error('Operazione sconosciuta');
    }
  }

  async fsStream(id, op, ...args) {
    if (!this.#session(id, 'files')) throw new Error('Trasferimento file non consentito');
    const e = this.extras.get(id);
    const f = this.ctl.files;
    const own = (set, h) => {
      if (!set.has(h)) throw new Error('Handle non valido');
    };
    switch (op) {
      case 'open-read': {
        const h = await f.openRead(String(args[0]));
        e.reads.add(h);
        return h;
      }
      case 'read':
        own(e.reads, args[0]);
        return f.read(args[0], args[1]);
      case 'close-read':
        e.reads.delete(args[0]);
        return f.closeRead(args[0]);
      case 'begin-write': {
        const ctx = await f.beginWrite(String(args[0]));
        e.ctxs.add(ctx);
        return ctx;
      }
      case 'open-write': {
        own(e.ctxs, args[0]);
        const h = await f.openWrite(args[0], String(args[1]), args[2] || {});
        if (h) e.writes.add(h);
        return h;
      }
      case 'write':
        own(e.writes, args[0]);
        return f.write(args[0], args[1]);
      case 'finish-write':
        own(e.writes, args[0]);
        e.writes.delete(args[0]);
        return f.finishWrite(args[0]);
      case 'abort-write':
        e.writes.delete(args[0]);
        return f.abortWrite(args[0]);
      case 'end-write':
        e.ctxs.delete(args[0]);
        return f.endWrite(args[0]);
      default:
        throw new Error('Operazione sconosciuta');
    }
  }

  // ---------- permessi, sessioni, pannello ----------

  #onPerms(id, perms) {
    this.#toEngine('engine:perms', id, perms);
    if (!perms.privacy) this.privacy.set(id, false);
    if (!perms.blockInput) this.blocker.set(id, false);
    if (!perms.whiteboard) this.whiteboard.release(id);
    if (!perms.control) this.input.releaseAll(id);
    // permessi revocati: casse e microfono di questo PC tornano subito come prima
    if (!perms.audio) this.audio.setSpeakers(id, false);
    if (!perms.microphone) this.audio.setMic(id, null);
    this.ctl.updateClipboardUsage();
  }

  #onActive(s) {
    this.ctl.notify('Sessione remota avviata', `${s.viewerName}${s.viewerId ? ` (${formatId(s.viewerId)})` : ''} è connesso a questo computer`);
    this.ctl.updateClipboardUsage();
  }

  #onEnded(s, reason) {
    const e = this.extras.get(s.id);
    this.audio.release(s.id);
    this.input.forget(s.id);
    this.privacy.set(s.id, false);
    this.blocker.set(s.id, false);
    this.whiteboard.release(s.id);
    if (e) {
      for (const h of e.reads) this.ctl.files.closeRead(h);
      for (const h of e.writes) this.ctl.files.abortWrite(h);
      for (const c of e.ctxs) this.ctl.files.endWrite(c);
    }
    this.extras.delete(s.id);
    this.ctl.updateClipboardUsage();
    const wasConnected = Boolean(s.connectedAt);
    const who = `${s.viewerName}${s.viewerId ? ` (${formatId(s.viewerId)})` : ''}${s.address ? ` da ${s.address}` : ''}`;
    this.ctl.log.info(`sessione in arrivo da ${who} terminata: ${reason}${s.endDetail ? ` [${s.endDetail}]` : ''}`);
    if (wasConnected) this.ctl.notify('Sessione remota terminata', `${s.viewerName} si è disconnesso`);
    else if (s.wasPending && (reason === 'connection-lost' || reason === 'viewer-closed')) {
      // la richiesta è sparita prima che qualcuno potesse rispondere: lo si dice, invece di lasciare
      // una notifica che al clic non apre più nulla
      this.ctl.notify(
        'Richiesta di connessione annullata',
        reason === 'connection-lost'
          ? `La connessione con ${s.viewerName} si è interrotta prima della risposta. Se succede sempre, un antivirus, un firewall o la VPN sta bloccando Remoto.`
          : `${s.viewerName} ha annullato la richiesta.`,
        () => this.ctl.showHome(),
      );
    }
    if (wasConnected && this.ctl.config.get().security.lockOnEnd && this.manager.activeCount() === 0) {
      this.ctl.log.info('blocco della sessione Windows a fine connessione');
      lockWorkstation();
    }
  }

  #onSessionsChanged(list) {
    const live = list.filter((s) => s.state === 'connecting' || s.state === 'active');
    if (live.length) this.#showPanel();
    else {
      // niente sessioni: si lascia la pipe del servizio (così non resta un collegamento aperto a riposo)
      this.#stopSecure();
      this.service?.stop();
      if (this.panel && !this.panel.isDestroyed()) {
        this.panel.destroy();
        this.panel = null;
      }
    }
    this.ctl.windows.send(this.panel, 'panel:sessions', this.#withMic(live));
    this.ctl.pushStatus();
  }

  #showPanel() {
    if (this.panel && !this.panel.isDestroyed()) {
      if (!this.panel.isVisible()) this.panel.showInactive();
      return;
    }
    const { workArea } = screen.getPrimaryDisplay();
    const W = 360;
    const H = 260;
    this.panel = this.ctl.windows.create('panel', {
      page: 'panel/panel.html',
      x: workArea.x + workArea.width - W - 16,
      y: workArea.y + workArea.height - H - 16,
      width: W,
      height: H,
      frame: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      show: false,
      title: 'Remoto - sessione attiva',
    });
    this.panel.once('ready-to-show', () => this.panel?.showInactive());
    this.panel.on('closed', () => {
      this.panel = null;
    });
  }

  resizePanel(height) {
    if (!this.panel || this.panel.isDestroyed()) return;
    const h = Math.max(120, Math.min(640, Math.round(Number(height) || 260)));
    const b = this.panel.getBounds();
    const { workArea } = screen.getDisplayMatching(b);
    const y = Math.min(b.y + (b.height - h), workArea.y + workArea.height - h - 8);
    this.panel.setBounds({ x: b.x, y: Math.max(workArea.y, y), width: b.width, height: h });
  }

  panelState() {
    const list = this.manager.list().filter((s) => s.state === 'connecting' || s.state === 'active');
    const chat = list.flatMap((s) => this.extras.get(s.id)?.chat || []);
    return { sessions: this.#withMic(list), chat };
  }

  #openPrompt(request) {
    // al centro dello schermo su cui si trova il mouse (quello che l'utente sta guardando):
    // in basso a destra la finestra finirebbe sotto le notifiche di Windows
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { workArea } = display;
    const W = 440;
    const H = 470;
    const n = this.prompts.size;
    const win = this.ctl.windows.create('prompt', {
      page: 'prompt/prompt.html',
      x: Math.round(workArea.x + (workArea.width - W) / 2 + n * 28),
      y: Math.round(workArea.y + (workArea.height - H) / 2 + n * 28),
      width: W,
      height: H,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: false,
      show: false,
      title: 'Remoto - richiesta di connessione',
      meta: { request: { ...request, timeoutMs: TIMEOUTS.promptMs, admin: isAdmin() } },
    });
    let done = false;
    let resolveFn;
    const result = new Promise((r) => (resolveFn = r));
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.prompts.delete(request.id);
      resolveFn(r);
      if (!win.isDestroyed()) win.destroy();
      this.ctl.pushStatus();
    };
    const timer = setTimeout(() => finish({ accepted: false, reason: 'timeout' }), TIMEOUTS.promptMs);
    this.ctl.windows.entry(win.webContents).meta.finish = finish;
    this.prompts.set(request.id, { win, finish, request });
    win.once('ready-to-show', () => this.showPrompt(request.id));
    win.on('closed', () => finish({ accepted: false, reason: 'declined' }));
    // la notifica porta alla richiesta (prima non faceva nulla al clic)
    this.ctl.notify('Richiesta di connessione', `${request.viewerName}${request.viewerId ? ` (${formatId(request.viewerId)})` : ''} vuole connettersi a questo computer. Clicca per rispondere.`, () => this.showPrompt(request.id) || this.ctl.showHome());
    return { result, close: () => finish(null) };
  }

  /** Adatta l'altezza della richiesta al contenuto, restando centrata e dentro lo schermo. */
  fitPrompt(win, height) {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const { workArea } = screen.getDisplayMatching(b);
    const h = Math.max(360, Math.min(Math.round(Number(height) || b.height), workArea.height - 32));
    if (Math.abs(h - b.height) < 4) return;
    const y = Math.max(workArea.y + 16, Math.min(b.y - Math.round((h - b.height) / 2), workArea.y + workArea.height - h - 16));
    win.setBounds({ x: b.x, y, width: b.width, height: h });
  }

  /** Porta in primo piano la finestra di una richiesta (o l'ultima in attesa). */
  showPrompt(id) {
    const p = id ? this.prompts.get(id) : [...this.prompts.values()].pop();
    if (!p || p.win.isDestroyed()) return false;
    p.win.setAlwaysOnTop(true, 'screen-saver');
    if (p.win.isMinimized()) p.win.restore();
    p.win.show();
    p.win.moveTop();
    p.win.focus();
    p.win.flashFrame(true);
    return true;
  }

  /** Risposta data dalla finestra principale invece che dalla finestra di richiesta. */
  answer(id, accepted) {
    const p = this.prompts.get(id);
    if (!p) return false;
    p.finish(accepted ? { accepted: true, perms: p.request.perms } : { accepted: false, reason: 'declined' });
    return true;
  }

  shutdown() {
    this.audio.restoreAll();
    this.#stopSecure();
    this.service?.stop();
    this.privacy.releaseAll();
    this.blocker.releaseAll();
    this.whiteboard.releaseAll();
  }
}
