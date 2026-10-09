// Canali IPC. Ogni canale è ammesso solo per i ruoli di finestra elencati: una pagina
// compromessa non può chiedere più di quanto serve alla sua funzione.
import { ipcMain, app, shell, clipboard } from 'electron';
import { isValidId } from '../shared/ids.js';
import { sanitizeIceServers } from '../shared/protocol.js';

export function registerIpc(ctl) {
  const { windows } = ctl;

  const handle = (channel, roles, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      const entry = windows.entry(event.sender);
      if (!entry || !roles.includes(entry.role)) throw new Error(`Canale ${channel} non consentito`);
      return fn(entry, ...args);
    });

  const on = (channel, roles, fn) =>
    ipcMain.on(channel, (event, ...args) => {
      const entry = windows.entry(event.sender);
      if (!entry || !roles.includes(entry.role)) return;
      try {
        const r = fn(entry, ...args);
        if (r && typeof r.catch === 'function') r.catch((err) => ctl.log.warn(`ipc ${channel}: ${err.message}`));
      } catch (err) {
        ctl.log.error(`ipc ${channel}: ${err.stack || err.message}`);
      }
    });

  const HOME = ['home'];
  const SESSION = ['session'];
  const ENGINE = ['engine'];
  const ANY = ['home', 'prompt', 'panel', 'session', 'engine', 'overlay'];

  // ---------------- comuni ----------------
  handle('app:info', ANY, () => ({
    version: ctl.version,
    platform: process.platform,
    theme: ctl.config.get().general.theme,
    sounds: ctl.config.get().general.sounds,
  }));
  handle('app:copy', ANY, (_e, text) => ctl.copyText(String(text ?? '').slice(0, 10_000)));
  on('app:log', ANY, (e, level, msg) => ctl.log[level === 'error' ? 'error' : 'warn'](`[${e.role}] ${String(msg).slice(0, 2000)}`));

  // ---------------- finestra principale ----------------
  handle('home:init', HOME, () => ({
    me: { id: ctl.identity().id, name: ctl.identity().name },
    version: ctl.version,
    config: ctl.publicConfig(),
    status: ctl.status(),
    peers: ctl.discovery.peers(),
  }));
  handle('config:update', HOME, (_e, patch) => {
    ctl.updateConfig(sanitizeHomePatch(patch));
    return ctl.publicConfig();
  });
  handle('connect', HOME, (_e, { input, mode } = {}) => ctl.viewerSide.open({ input: String(input ?? ''), mode }));
  handle('book:save', HOME, (_e, entry) => ctl.saveBookEntry(entry || {}));
  handle('book:remove', HOME, (_e, key) => ctl.removeBookEntry(String(key)));
  handle('recent:remove', HOME, (_e, key) => ctl.config.set('recent', ctl.config.get().recent.filter((r) => r.key !== key)));
  handle('recent:clear', HOME, () => ctl.config.set('recent', []));
  handle('presence', HOME, async (_e, ids) => ctl.link.query((Array.isArray(ids) ? ids : []).filter(isValidId).slice(0, 200)));
  handle('wol', HOME, async (_e, mac) => {
    const { wake } = await import('./net/wol.js');
    await wake(String(mac));
    return true;
  });
  handle('log:get', HOME, () => ctl.config.get().accessLog);
  handle('log:clear', HOME, () => ctl.config.set('accessLog', []));
  handle('app:open-external', HOME, (_e, url) => ctl.openExternal(url));
  handle('app:open-logs', HOME, () => shell.openPath(ctl.log.dir));
  handle('app:quit', HOME, () => ctl.quit());
  handle('app:hide', HOME, (e) => e.win.hide());
  handle('host:answer', HOME, (_e, id, accepted) => ctl.hostSide.answer(String(id), Boolean(accepted)));
  handle('host:show-prompt', HOME, (_e, id) => ctl.hostSide.showPrompt(String(id)));
  handle('service:status', HOME, () => ctl.serviceStatus());
  handle('service:install', HOME, () => ctl.installService());
  handle('service:uninstall', HOME, () => ctl.uninstallService());

  // ---------------- richiesta in arrivo ----------------
  handle('prompt:init', ['prompt'], (e) => e.meta.request);
  on('prompt:answer', ['prompt'], (e, answer) => e.meta.finish?.({ accepted: Boolean(answer?.accepted), perms: answer?.perms }));
  on('prompt:fit', ['prompt'], (e, height) => ctl.hostSide.fitPrompt(e.win, height));

  // ---------------- pannello sessione (lato controllato) ----------------
  handle('panel:init', ['panel'], () => ctl.hostSide.panelState());
  on('panel:perms', ['panel'], (_e, id, perms) => ctl.host.setPermissions(String(id), perms));
  on('panel:disconnect', ['panel'], (_e, id) => ctl.host.disconnect(String(id)));
  on('panel:chat', ['panel'], (_e, id, text) => ctl.hostSide.sendChat(String(id), text));
  on('panel:resize', ['panel'], (_e, h) => ctl.hostSide.resizePanel(h));
  on('panel:open-home', ['panel'], () => ctl.showHome());
  on('panel:minimize', ['panel'], (e) => e.win.minimize());

  // ---------------- finestra di sessione (lato che controlla) ----------------
  handle('viewer:init', SESSION, (e) => ctl.viewerSide.init(e));
  on('viewer:signal', SESSION, (e, data) => ctl.viewerSide.signal(e, data));
  on('viewer:rtc', SESSION, (e, state, info) => ctl.viewerSide.rtc(e, state, info));
  on('viewer:close', SESSION, (e) => ctl.viewerSide.close(e));
  on('viewer:disconnect', SESSION, (e) => ctl.viewerSide.disconnect(e));
  on('viewer:reconnect', SESSION, (e) => ctl.viewerSide.reconnect(e));
  on('viewer:title', SESSION, (e, t) => ctl.viewerSide.setTitle(e, t));
  on('viewer:fullscreen', SESSION, (e, onoff) => ctl.viewerSide.setFullscreen(e, onoff));
  on('viewer:sync', SESSION, (e, onoff) => ctl.viewerSide.setSync(e, onoff));
  on('viewer:prefs', SESSION, (_e, patch) => ctl.viewerSide.savePrefs(patch));
  on('viewer:host-info', SESSION, (e, info) => ctl.viewerSide.hostInfo(e, info));
  on('viewer:perms', SESSION, (e, perms) => ctl.viewerSide.updatePerms(e, perms));
  on('viewer:clipboard-apply', SESSION, (e, payload) => ctl.viewerSide.applyClipboard(e, payload));
  handle('viewer:clipboard-text', SESSION, () => clipboard.readText().slice(0, 100_000));
  handle('viewer:screenshot', SESSION, (e, data) => ctl.viewerSide.saveScreenshot(e, data));
  handle('viewer:rec-open', SESSION, (e, ext) => ctl.viewerSide.recordOpen(e, ext));
  on('viewer:rec-write', SESSION, (e, h, data) => ctl.viewerSide.recordWrite(e, h, data));
  handle('viewer:rec-close', SESSION, (e, h) => ctl.viewerSide.recordClose(e, h));
  handle('viewer:show-item', SESSION, (_e, p) => ctl.viewerSide.showItem(p));
  handle('viewer:downloads-dir', SESSION, () => app.getPath('downloads'));

  // file locali (pannello sinistro del file manager)
  const files = ctl.files;
  handle('localfs:roots', SESSION, () => files.roots());
  handle('localfs:list', SESSION, (_e, p) => files.list(String(p)));
  handle('localfs:mkdir', SESSION, (_e, parent, name) => files.mkdir(String(parent), String(name)));
  handle('localfs:rename', SESSION, (_e, p, name) => files.rename(String(p), String(name)));
  handle('localfs:remove', SESSION, (_e, p) => files.remove(String(p)));
  handle('localfs:expand', SESSION, (_e, paths) => files.expand((Array.isArray(paths) ? paths : []).map(String)));
  handle('localfs:open-read', SESSION, (_e, p) => files.openRead(String(p)));
  handle('localfs:read', SESSION, (_e, h, len) => files.read(h, len));
  handle('localfs:close-read', SESSION, (_e, h) => files.closeRead(h));
  handle('localfs:begin-write', SESSION, (_e, dir) => files.beginWrite(String(dir)));
  handle('localfs:open-write', SESSION, (_e, ctx, rel, opts) => files.openWrite(ctx, String(rel), opts || {}));
  handle('localfs:write', SESSION, (_e, h, data) => files.write(h, data));
  handle('localfs:finish-write', SESSION, (_e, h) => files.finishWrite(h));
  handle('localfs:abort-write', SESSION, (_e, h) => files.abortWrite(h));
  handle('localfs:end-write', SESSION, (_e, ctx) => files.endWrite(ctx));

  // ---------------- engine (cattura e WebRTC lato controllato) ----------------
  const hs = ctl.hostSide;
  on('engine:ready', ENGINE, () => hs.engineLoaded());
  handle('engine:displays', ENGINE, () => hs.displays());
  on('engine:signal', ENGINE, (_e, id, data) => ctl.host.engineSignal(String(id), data));
  on('engine:state', ENGINE, (_e, id, state, info) => hs.onEngineState(String(id), state, info));
  on('engine:input', ENGINE, (_e, id, msg) => hs.onInput(String(id), msg));
  on('engine:display', ENGINE, (_e, id, displayId) => hs.onDisplay(String(id), displayId));
  on('engine:clipboard-in', ENGINE, (_e, id, payload) => hs.onClipboardIn(String(id), payload));
  on('engine:chat-in', ENGINE, (_e, id, text) => hs.onChatIn(String(id), text));
  on('engine:wb', ENGINE, (_e, id, msg) => hs.onWhiteboard(String(id), msg));
  handle('engine:privacy', ENGINE, (_e, id, onoff) => hs.setPrivacy(String(id), onoff));
  handle('engine:block-input', ENGINE, (_e, id, onoff) => hs.setBlockInput(String(id), onoff));
  handle('engine:system', ENGINE, (_e, id, op) => hs.system(String(id), String(op)));
  handle('engine:fs', ENGINE, (_e, id, op, args) => hs.fs(String(id), String(op), args || {}));
  handle('enginefs', ENGINE, (_e, id, op, ...args) => hs.fsStream(String(id), String(op), ...args));
  handle('engine:macs', ENGINE, async () => (await import('./net/discovery.js')).localMacs());
  handle('engine:audio-prefs', ENGINE, () => ctl.config.get().audio);
  on('engine:mic', ENGINE, (_e, id, info) => hs.onMic(String(id), info));
}

/** Dalla finestra principale si accettano solo i rami di configurazione modificabili. */
function sanitizeHomePatch(patch) {
  if (!patch || typeof patch !== 'object') return {};
  const out = {};
  const pick = (src, keys) => Object.fromEntries(Object.entries(src || {}).filter(([k]) => keys.includes(k)));
  if (patch.profile) out.profile = pick(patch.profile, ['name']);
  if (patch.general) out.general = pick(patch.general, ['theme', 'startWithWindows', 'closeToTray', 'sounds']);
  if (patch.viewer) out.viewer = pick(patch.viewer, ['quality', 'codec', 'scaleMode', 'showStats', 'clipboardSync', 'audio', 'micDevice', 'micLabel', 'speakerDevice']);
  if (patch.audio) out.audio = pick(patch.audio, ['micSink', 'micSinkLabel']);
  if (patch.embeddedServer) out.embeddedServer = pick(patch.embeddedServer, ['enabled', 'port']);
  if (patch.network) {
    out.network = pick(patch.network, ['serverUrl', 'direct', 'discovery', 'iceServers']);
    if (out.network.direct) out.network.direct = pick(out.network.direct, ['enabled', 'port']);
    if (out.network.discovery) out.network.discovery = pick(out.network.discovery, ['enabled']);
    if ('iceServers' in out.network) out.network.iceServers = sanitizeIceServers(out.network.iceServers);
  }
  if (patch.security) {
    out.security = pick(patch.security, ['allowIncoming', 'permissions', 'acl', 'maxSessions', 'lockOnEnd']);
    if (out.security.acl) out.security.acl = (Array.isArray(out.security.acl) ? out.security.acl : []).filter(isValidId);
  }
  return out;
}
