// Finestra di sessione: stato della connessione, video remoto, barra strumenti e pannelli.
import { h, icon, $, replace } from '../lib/dom.js';
import { bootPage, toast, modal, confirmDialog, openMenu, avatar, playSound } from '../lib/ui.js';
import { formatId } from '../../shared/ids.js';
import { reasonText } from '../../shared/protocol.js';
import { QUALITY_PRESETS } from '../../shared/quality.js';
import { PERMISSIONS } from '../../shared/permissions.js';
import { formatDuration } from '../../shared/format.js';
import { ViewerPeer } from './viewer-peer.js';
import { InputCapture } from './input.js';
import { Whiteboard, WB_COLORS } from './whiteboard.js';
import { StatsProbe, statsRows, CONN_LABELS } from './stats.js';
import { Recorder } from './recorder.js';
import { ChatPanel } from './chat.js';
import { FileManager, TransferList } from './files.js';
import { TransferEngine, newXid } from '../lib/transfers.js';
import { ClipboardAssembler, sendClipboard } from '../lib/clipchannel.js';

const appEl = $('#app');
const toolbarEl = $('#toolbar');
const statusEl = $('#status');
const video = $('#screen');
const wrap = $('#screen-wrap');
const scrollEl = $('#screen-scroll');
const sideEl = $('#side');
const statsEl = $('#stats');
const paletteEl = $('#wb-palette');
const dropHint = $('#drop-hint');
const hotzone = $('#hotzone');

const S = {
  info: null,
  ui: { state: 'connecting' },
  peer: null,
  hello: null,
  caps: {},
  secure: false,
  perms: {},
  displays: [],
  active: null,
  quality: 'balanced',
  scaleMode: 'fit',
  viewOnly: false,
  sync: true,
  audio: true,
  showStats: false,
  panel: null,
  wb: false,
  privacy: false,
  blocked: false,
  fullscreen: false,
  recorder: null,
  unread: 0,
  stats: null,
  restarting: false,
  restartDeadline: 0,
  reconnectTimer: null,
  connectedAt: 0,
  transfers: null,
  remoteDesk: null,
  mic: { deviceId: '', label: '', track: null, muted: false, status: null, warned: false },
  speaker: '',
};

const rpcPending = new Map();
let rpcId = 0;
let statsTimer = 0;
let probe = null;
let badgeEl = null;
let recTimeEl = null;

const isDesktop = () => S.info?.mode === 'desktop';
const connected = () => S.ui.state === 'connected';
const hostName = () => S.ui.hostName || S.hello?.name || S.info?.targetLabel || 'Postazione remota';
const hostIdLabel = () => (S.ui.hostId ? formatId(S.ui.hostId) : S.info?.targetLabel || '');
const cleanError = (err) => String(err?.message || err || 'Errore').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ---------------------------------------------------------------- avvio

await bootPage();
S.info = await remoto.invoke('viewer:init');
S.quality = S.info.prefs.quality;
S.scaleMode = S.info.prefs.scaleMode;
S.showStats = S.info.prefs.showStats;
S.audio = S.info.prefs.audio !== false;
S.sync = S.info.sync !== false;
S.speaker = S.info.prefs.speakerDevice || '';
if (S.speaker) video.setSinkId?.(S.speaker).catch(() => (S.speaker = ''));
if (!isDesktop()) appEl.classList.add('files-mode');
wrap.tabIndex = 0;

const transferList = new TransferList();
const clipAsm = new ClipboardAssembler((payload) => {
  if (S.sync && S.perms.clipboard) remoto.send('viewer:clipboard-apply', payload);
});
const chat = new ChatPanel({
  onSend: (text) => {
    if (!S.peer?.sendCtrl({ t: 'chat', text, ts: Date.now() })) {
      toast({ kind: 'bad', title: 'Messaggio non inviato', text: 'La sessione non è connessa.' });
      return false;
    }
    return true;
  },
  onClose: () => setPanel(null),
});
let fileManager = null;

const input = new InputCapture({
  surface: wrap,
  video,
  peer: () => S.peer,
  enabled: () => connected() && isDesktop() && S.perms.control && !S.viewOnly && !S.wb,
  scaleMode: () => S.scaleMode,
  onHotkey,
});

const whiteboard = new Whiteboard({ canvas: $('#wb-canvas'), video, peer: () => S.peer, scaleMode: () => S.scaleMode });

remoto.on('viewer:state', onState);
remoto.on('viewer:signal', (data) => S.peer?.handleSignal(data));
remoto.on('viewer:local-clipboard', (payload) => {
  const ch = S.peer?.channels.file;
  if (ch && S.sync && S.perms.clipboard) sendClipboard(ch, payload);
});
remoto.on('viewer:confirm-close', async () => {
  const ok = await confirmDialog({ title: 'Chiudere la sessione?', text: `La connessione con ${hostName()} verrà terminata.`, confirm: 'Disconnetti e chiudi', danger: true });
  if (ok) remoto.send('viewer:close');
});
remoto.on('viewer:forward-combo', (name) => S.peer?.sendCtrl({ t: 'combo', name }));
remoto.on('viewer:fullscreen', (on) => {
  S.fullscreen = on;
  appEl.classList.toggle('fullscreen', on);
  renderToolbar();
});

video.addEventListener('resize', () => {
  applyScaleMode();
  whiteboard.redraw();
});
setupFullscreenToolbar();
setupDragDrop();
onState(S.info.ui || { state: 'connecting' });

// ---------------------------------------------------------------- stato della sessione

function onState(patch) {
  const prev = S.ui.state;
  S.ui = { ...S.ui, ...patch };
  const st = S.ui.state;
  if (patch.state === 'accepted' && prev !== 'accepted') startPeer(S.ui.iceServers || []);
  if (patch.state === 'connected' && prev !== 'connected') onConnected();
  if (patch.state === 'failed' || patch.state === 'closed') onEnded(prev);
  if (patch.state === 'connecting' || patch.state === 'requesting') {
    S.hello = null;
    S.perms = {};
  }
  renderStatus();
  renderToolbar();
  updateTitle();
  if (st === 'waiting' && prev !== 'waiting') playSound('ding');
}

function startPeer(iceServers) {
  teardownPeer();
  const peer = new ViewerPeer({ iceServers });
  S.peer = peer;
  probe = new StatsProbe(peer.pc);
  peer.addEventListener('track', (e) => {
    video.srcObject = e.detail.stream;
    video.muted = !S.audio;
    video.play().catch(() => {});
  });
  peer.addEventListener('ctrl', (e) => onCtrl(e.detail));
  peer.addEventListener('channel', (e) => {
    if (e.detail.label === 'file') setupFileChannel(e.detail.channel);
  });
  peer.addEventListener('state', async (e) => {
    const st = e.detail.state;
    if (st === 'connected' && S.ui.state !== 'connected') {
      const s = await probe.sample().catch(() => null);
      remoto.send('viewer:rtc', 'connected', { connType: s?.conn || '' });
    } else if (st === 'failed') remoto.send('viewer:rtc', 'failed', { reason: 'webrtc-failed' });
    if (badgeEl) renderBadge();
  });
}

function teardownPeer() {
  input.releaseAll();
  S.mic.track?.stop();
  S.mic = { ...S.mic, track: null, status: null };
  if (S.recorder?.active) stopRecording();
  S.peer?.close();
  S.peer = null;
  S.transfers = null;
  probe = null;
  clearInterval(statsTimer);
  statsTimer = 0;
  video.srcObject = null;
  for (const p of rpcPending.values()) p.reject(new Error('Sessione terminata'));
  rpcPending.clear();
}

function onConnected() {
  S.connectedAt = Date.now();
  S.restarting = false;
  clearTimeout(S.reconnectTimer);
  playSound('pop');
  statsTimer = setInterval(updateStats, 1000);
  updateStats();
  if (!isDesktop()) setPanel('files');
  else wrap.focus({ preventScroll: true });
}

function onEnded(prev) {
  teardownPeer();
  if (S.wb) toggleWhiteboard(false);
  if (S.fullscreen) remoto.send('viewer:fullscreen', false);
  if (prev === 'connected') playSound('bye');
  if (S.restarting && Date.now() < S.restartDeadline) {
    clearTimeout(S.reconnectTimer);
    S.reconnectTimer = setTimeout(() => remoto.send('viewer:reconnect'), 6000);
  } else S.restarting = false;
}

function setupFileChannel(ch) {
  S.transfers = new TransferEngine({
    channel: ch,
    backend: localBackend,
    canReceive: () => 'Upload dal computer remoto non previsto',
    onOther: (msg) => clipAsm.add(msg),
  });
  transferList.bind(S.transfers);
}

// ---------------------------------------------------------------- messaggi dal PC remoto

function onCtrl(msg) {
  switch (msg.t) {
    case 'hello':
      S.hello = msg;
      S.caps = msg.caps || {};
      S.perms = msg.perms || {};
      S.displays = msg.displays || [];
      S.active = msg.active;
      remoto.send('viewer:host-info', { macs: msg.macs, os: msg.os });
      remoto.send('viewer:perms', S.perms);
      if (msg.quality !== S.quality) S.peer.sendCtrl({ t: 'quality', preset: S.quality });
      if (msg.audio) S.peer.sendCtrl({ t: 'audio', on: S.audio });
      restoreMic();
      // in modalità "solo file" il file manager si apre appena si conoscono i permessi
      if (!isDesktop() && S.panel !== 'files') {
        renderToolbar();
        setPanel('files');
        return;
      }
      break;
    case 'perms': {
      const before = S.perms;
      S.perms = msg.perms || {};
      remoto.send('viewer:perms', S.perms);
      const changed = PERMISSIONS.filter((p) => before[p.key] !== S.perms[p.key]);
      if (changed.length) toast({ kind: 'info', title: 'Permessi aggiornati dal computer remoto', text: changed.map((p) => `${p.label}: ${S.perms[p.key] ? 'sì' : 'no'}`).join(' · ') });
      if (!S.perms.whiteboard && S.wb) toggleWhiteboard(false);
      if (!S.perms.microphone && S.mic.track) selectMic('', '', { remember: false });
      if (S.perms.microphone && !S.mic.track) restoreMic();
      if (!S.perms.files && S.panel === 'files' && isDesktop()) setPanel(null);
      if (!S.perms.privacy) S.privacy = false;
      if (!S.perms.blockInput) S.blocked = false;
      break;
    }
    case 'displays':
      S.displays = msg.displays || [];
      S.active = msg.active;
      break;
    case 'quality':
      S.quality = msg.preset;
      break;
    case 'chat':
      chat.add({ from: 'them', text: String(msg.text || ''), ts: msg.ts });
      if (S.panel !== 'chat') {
        S.unread++;
        toast({ kind: 'info', title: `Messaggio da ${hostName()}`, text: String(msg.text || '').slice(0, 140), actions: [{ label: 'Apri chat', onClick: () => setPanel('chat') }] });
      }
      playSound('msg');
      break;
    case 'privacy':
      S.privacy = Boolean(msg.active);
      if (!msg.ok) toast({ kind: 'bad', title: 'Modalità privacy non disponibile', text: msg.error || '' });
      else toast({ kind: 'ok', title: S.privacy ? 'Modalità privacy attiva' : 'Modalità privacy disattivata', text: S.privacy ? 'Lo schermo del computer remoto è oscurato per chi è davanti.' : '' });
      break;
    case 'block':
      S.blocked = Boolean(msg.active);
      if (!msg.ok) toast({ kind: 'bad', title: 'Blocco dell’input non riuscito', text: msg.error || '' });
      else toast({ kind: 'ok', title: S.blocked ? 'Input del computer remoto bloccato' : 'Input del computer remoto sbloccato' });
      break;
    case 'sys-res':
      if (!msg.ok) toast({ kind: 'bad', title: 'Operazione non riuscita', text: msg.error || '' });
      else if (msg.op === 'restart') {
        S.restarting = true;
        S.restartDeadline = Date.now() + 5 * 60_000;
        toast({ kind: 'info', title: 'Riavvio del computer remoto', text: 'Remoto ritenterà la connessione quando il computer sarà di nuovo online: la richiesta andrà accettata sul PC remoto.', timeout: 9000 });
      } else if (msg.op === 'lock') toast({ kind: 'ok', title: 'Sessione Windows remota bloccata' });
      break;
    case 'fs-res': {
      const p = rpcPending.get(msg.id);
      if (p) {
        rpcPending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error || 'Errore sul computer remoto'));
      }
      return;
    }
    case 'notice':
      toast({ kind: msg.kind === 'error' ? 'bad' : 'info', title: msg.text || 'Avviso dal computer remoto' });
      return;
    case 'mic-status':
      S.mic.status = msg;
      if (!msg.ok && msg.reason === 'no-virtual-device' && S.mic.track && !S.mic.warned) {
        S.mic.warned = true;
        toast({ kind: 'info', title: 'Sul PC remoto manca un cavo audio virtuale', text: 'Il tuo microfono arriva, ma le app (Teams…) non possono usarlo: installa VB-CABLE sul PC remoto e scegli "CABLE Output" come microfono.', timeout: 12000 });
      }
      break;
    case 'caps':
      S.caps = msg.caps || {};
      break;
    case 'secure':
      S.secure = Boolean(msg.on);
      toast(
        S.secure
          ? { kind: 'info', title: 'Richiesta di Windows (UAC o schermata di blocco)', text: 'Il PC remoto mostra una finestra protetta: la vedi e puoi usarla grazie al controllo completo.', timeout: 8000 }
          : { kind: 'ok', title: 'Finestra protetta chiusa', timeout: 4000 },
      );
      break;
    default:
      return;
  }
  renderToolbar();
  updateTitle();
}

// ---------------------------------------------------------------- file

function rpc(op, args = {}) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    const timer = setTimeout(() => {
      rpcPending.delete(id);
      reject(new Error('Nessuna risposta dal computer remoto'));
    }, 30_000);
    rpcPending.set(id, { resolve, reject, timer });
    if (!S.peer?.sendCtrl({ t: 'fs', id, op, args })) {
      clearTimeout(timer);
      rpcPending.delete(id);
      reject(new Error('Sessione non connessa'));
    }
  });
}

const localBackend = {
  roots: () => remoto.invoke('localfs:roots'),
  list: (p) => remoto.invoke('localfs:list', p),
  mkdir: (parent, name) => remoto.invoke('localfs:mkdir', parent, name),
  rename: (p, name) => remoto.invoke('localfs:rename', p, name),
  remove: (p) => remoto.invoke('localfs:remove', p),
  expand: (paths) => remoto.invoke('localfs:expand', paths),
  openRead: (p) => remoto.invoke('localfs:open-read', p),
  read: (handle, len) => remoto.invoke('localfs:read', handle, len),
  closeRead: (handle) => remoto.invoke('localfs:close-read', handle),
  beginWrite: (dir) => remoto.invoke('localfs:begin-write', dir),
  openWrite: (ctx, rel, opts) => remoto.invoke('localfs:open-write', ctx, rel, opts),
  write: (handle, data) => remoto.invoke('localfs:write', handle, data),
  finishWrite: (handle) => remoto.invoke('localfs:finish-write', handle),
  abortWrite: (handle) => remoto.invoke('localfs:abort-write', handle),
  endWrite: (ctx) => remoto.invoke('localfs:end-write', ctx),
};

const remoteBackend = {
  roots: () => rpc('roots'),
  list: (p) => rpc('list', { path: p }),
  mkdir: (parent, name) => rpc('mkdir', { parent, name }),
  rename: (p, name) => rpc('rename', { path: p, name }),
  remove: (p) => rpc('remove', { path: p }),
};

function upload(paths, dest, after) {
  if (!S.transfers || !S.perms.files) {
    toast({ kind: 'bad', title: 'Trasferimento non disponibile', text: S.perms.files ? 'La sessione non è connessa.' : 'Il computer remoto non consente il trasferimento file.' });
    return;
  }
  const x = newXid();
  const onDone = (e) => {
    if (e.detail.x !== x) return;
    S.transfers?.removeEventListener('done', onDone);
    if (e.detail.ok) after?.();
    if (S.panel !== 'files') {
      toast(e.detail.ok ? { kind: 'ok', title: 'File inviati', text: `${e.detail.name} → ${dest}` } : { kind: 'bad', title: 'Invio non riuscito', text: e.detail.error });
    }
  };
  S.transfers.addEventListener('done', onDone);
  S.transfers.send(x, paths, { mode: 'upload', dest });
}

async function download(paths, dest, after) {
  if (!S.transfers || !S.perms.files) return;
  const x = newXid();
  try {
    await S.transfers.expectDownload(x, dest);
  } catch (err) {
    toast({ kind: 'bad', title: 'Cartella di destinazione non valida', text: cleanError(err) });
    return;
  }
  const onDone = (e) => {
    if (e.detail.x !== x) return;
    S.transfers?.removeEventListener('done', onDone);
    if (e.detail.ok) after?.();
  };
  S.transfers.addEventListener('done', onDone);
  try {
    await rpc('download', { paths, x });
  } catch (err) {
    S.transfers?.removeEventListener('done', onDone);
    await S.transfers?.dropExpected(x);
    toast({ kind: 'bad', title: 'Download non avviato', text: cleanError(err) });
  }
}

async function remoteDesktopDir() {
  if (S.remoteDesk) return S.remoteDesk;
  const roots = await rpc('roots');
  const r = roots.find((x) => x.name === 'Desktop') || roots.find((x) => x.kind === 'home') || roots[0];
  S.remoteDesk = r?.path || null;
  return S.remoteDesk;
}

function setupDragDrop() {
  const stage = $('#stage');
  let depth = 0;
  stage.addEventListener('dragenter', (e) => {
    if (![...e.dataTransfer.types].includes('Files') || !connected()) return;
    depth++;
    replace(dropHint, h('div', { class: 'col', style: { alignItems: 'center' } }, icon('upload', 'xl'), S.perms.files ? 'Rilascia per inviare i file al Desktop del computer remoto' : 'Il computer remoto non consente il trasferimento file'));
    dropHint.classList.remove('hidden');
  });
  stage.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) dropHint.classList.add('hidden');
  });
  stage.addEventListener('dragover', (e) => {
    if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
  });
  stage.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    dropHint.classList.add('hidden');
    if (!connected() || !S.perms.files) return;
    const paths = [...e.dataTransfer.files].map((f) => remoto.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    try {
      const dest = await remoteDesktopDir();
      toast({ kind: 'info', title: 'Invio in corso…', text: `${paths.length} elemento/i verso il Desktop remoto` });
      upload(paths, dest, () => fileManager?.refreshRemote());
    } catch (err) {
      toast({ kind: 'bad', title: 'Invio non riuscito', text: cleanError(err) });
    }
  });
}

// ---------------------------------------------------------------- pannelli laterali

async function setPanel(name) {
  if (name === 'files' && (!connected() || !S.perms.files)) return;
  S.panel = name;
  sideEl.classList.toggle('hidden', !name);
  sideEl.classList.toggle('wide', name === 'files' && isDesktop());
  if (name === 'chat') {
    S.unread = 0;
    replace(sideEl, chat.el);
    chat.focus();
  } else if (name === 'files') {
    if (!fileManager) {
      fileManager = new FileManager({ localBackend, remoteBackend, upload, download, transferList, onClose: () => setPanel(null), full: !isDesktop() });
      replace(sideEl, fileManager.el);
      fileManager.init();
    } else replace(sideEl, fileManager.el);
  } else {
    replace(sideEl);
    wrap.focus({ preventScroll: true });
  }
  renderToolbar();
}

// ---------------------------------------------------------------- azioni

function toggleViewOnly() {
  S.viewOnly = !S.viewOnly;
  if (S.viewOnly) input.releaseAll();
  toast({ kind: 'info', title: S.viewOnly ? 'Sola visualizzazione' : 'Controllo attivo', text: S.viewOnly ? 'Mouse e tastiera non vengono inviati al computer remoto.' : '' });
  renderToolbar();
}

function toggleSync() {
  S.sync = !S.sync;
  remoto.send('viewer:sync', S.sync);
  renderToolbar();
}

function toggleAudio() {
  S.audio = !S.audio;
  video.muted = !S.audio;
  S.peer?.sendCtrl({ t: 'audio', on: S.audio });
  remoto.send('viewer:prefs', { audio: S.audio });
  renderToolbar();
}

// ---------------------------------------------------------------- audio e microfono

async function audioDevices(kind) {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind && d.deviceId !== 'communications');
  } catch {
    return [];
  }
}

/** Usa un microfono di questo PC nelle app del PC remoto ('' = microfono del PC remoto). */
async function selectMic(deviceId, label = '', { remember = true } = {}) {
  S.mic.track?.stop();
  S.mic.track = null;
  if (!deviceId) {
    S.mic = { ...S.mic, deviceId: '', label: '' };
    await S.peer?.setMicTrack(null).catch(() => {});
    if (remember) remoto.send('viewer:prefs', { micDevice: '', micLabel: '' });
    renderToolbar();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    const track = stream.getAudioTracks()[0];
    track.enabled = !S.mic.muted;
    await S.peer?.setMicTrack(track);
    S.mic = { ...S.mic, deviceId, label: label || track.label, track };
    if (remember) remoto.send('viewer:prefs', { micDevice: deviceId, micLabel: S.mic.label });
  } catch (err) {
    toast({ kind: 'bad', title: 'Microfono non disponibile', text: cleanError(err) });
  }
  renderToolbar();
}

/** All'inizio della sessione si riprende il microfono scelto l'ultima volta. */
async function restoreMic() {
  const want = S.info.prefs.micDevice;
  if (!want || S.mic.track || !S.perms.microphone || !S.peer?.micAvailable) return;
  const inputs = await audioDevices('audioinput');
  const d = inputs.find((x) => x.deviceId === want) || inputs.find((x) => x.label && x.label === S.info.prefs.micLabel);
  if (d) selectMic(d.deviceId, d.label, { remember: false });
}

function toggleMicMute() {
  S.mic.muted = !S.mic.muted;
  if (S.mic.track) S.mic.track.enabled = !S.mic.muted;
  renderToolbar();
}

async function selectSpeaker(deviceId) {
  try {
    await video.setSinkId(deviceId === 'default' ? '' : deviceId);
    S.speaker = deviceId;
    remoto.send('viewer:prefs', { speakerDevice: deviceId });
  } catch (err) {
    toast({ kind: 'bad', title: 'Uscita audio non disponibile', text: cleanError(err) });
  }
}

async function audioMenu(el) {
  const [outputs, inputs] = await Promise.all([audioDevices('audiooutput'), audioDevices('audioinput')]);
  const p = S.perms;
  const st = S.mic.status;
  const micBlocked = !p.microphone || !S.peer?.micAvailable;
  openMenu(el, [
    { title: 'Audio del PC remoto' },
    { label: S.audio ? 'Ascolto attivo' : 'Ascolto disattivato', sub: S.hello?.audio ? 'Clic per cambiare' : 'Il PC remoto non trasmette audio', icon: S.audio ? 'volume' : 'volume-x', checked: S.audio && S.hello?.audio, disabled: !S.hello?.audio, onClick: () => toggleAudio() },
    ...outputs.map((d) => ({ label: d.label || 'Uscita audio', sub: 'Ascolta su questo dispositivo', icon: 'headphones', checked: (S.speaker || 'default') === d.deviceId, onClick: () => selectSpeaker(d.deviceId) })),
    { divider: true },
    { title: 'Microfono per le app del PC remoto' },
    { label: 'Microfono del PC remoto', sub: 'Il mio microfono non viene inviato', icon: 'monitor', checked: !S.mic.deviceId, onClick: () => selectMic('') },
    ...inputs.map((d) => ({
      label: d.label || 'Microfono',
      sub: !p.microphone ? 'Non consentito dal PC remoto' : 'Usa questo microfono sul PC remoto',
      icon: 'mic',
      checked: S.mic.deviceId === d.deviceId,
      disabled: micBlocked,
      onClick: () => selectMic(d.deviceId, d.label),
    })),
    S.mic.track && st?.ok ? { label: `Sul PC remoto è il microfono "${st.device}"`, sub: 'Nelle app scegli il lato "Output" del cavo virtuale', icon: 'check', disabled: true } : null,
    S.mic.track && st && !st.ok && st.reason === 'no-virtual-device' ? { label: 'Sul PC remoto manca un cavo audio virtuale', sub: 'Installa VB-CABLE sul PC remoto', icon: 'alert', disabled: true } : null,
    S.mic.track && st && !st.ok && st.reason === 'disabled' ? { label: 'Il PC remoto non usa microfoni esterni', sub: 'Impostazioni › Audio sul PC remoto', icon: 'alert', disabled: true } : null,
  ]);
}

function toggleStats() {
  S.showStats = !S.showStats;
  statsEl.classList.toggle('hidden', !S.showStats);
  remoto.send('viewer:prefs', { showStats: S.showStats });
  renderStatsOverlay();
  renderToolbar();
}

function toggleWhiteboard(force) {
  S.wb = typeof force === 'boolean' ? force : !S.wb;
  if (S.wb) input.releaseAll();
  whiteboard.setActive(S.wb);
  paletteEl.classList.toggle('hidden', !S.wb);
  if (S.wb) renderPalette();
  renderToolbar();
}

function renderPalette() {
  replace(
    paletteEl,
    h('button', { class: `icon-btn ${whiteboard.tool === 'pen' ? 'active' : ''}`, 'data-tip': 'Penna', 'data-tip-pos': 'up', onClick: () => {
      whiteboard.tool = 'pen';
      renderPalette();
    } }, icon('pen')),
    h('button', { class: `icon-btn ${whiteboard.tool === 'highlighter' ? 'active' : ''}`, 'data-tip': 'Evidenziatore (sfuma)', 'data-tip-pos': 'up', onClick: () => {
      whiteboard.tool = 'highlighter';
      renderPalette();
    } }, icon('highlighter')),
    h('span', { class: 'sep', style: { width: '1px', height: '22px', background: 'var(--border)', margin: '0 4px' } }),
    WB_COLORS.map((c) =>
      h('button', { class: `swatch ${whiteboard.color === c ? 'active' : ''}`, style: { background: c }, 'aria-label': `Colore ${c}`, onClick: () => {
        whiteboard.color = c;
        renderPalette();
      } }),
    ),
    h('span', { class: 'sep', style: { width: '1px', height: '22px', background: 'var(--border)', margin: '0 4px' } }),
    h('button', { class: 'icon-btn', 'data-tip': 'Cancella tutto', 'data-tip-pos': 'up', onClick: () => whiteboard.clear() }, icon('trash')),
    h('button', { class: 'icon-btn', 'data-tip': 'Chiudi lavagna', 'data-tip-pos': 'up', onClick: () => toggleWhiteboard(false) }, icon('x')),
  );
}

function setScaleMode(mode) {
  S.scaleMode = mode;
  remoto.send('viewer:prefs', { scaleMode: mode });
  applyScaleMode();
  renderToolbar();
}

function applyScaleMode() {
  const original = S.scaleMode === 'original';
  scrollEl.classList.toggle('original', original);
  if (original && video.videoWidth) {
    const dpr = window.devicePixelRatio || 1;
    video.style.width = `${video.videoWidth / dpr}px`;
    video.style.height = `${video.videoHeight / dpr}px`;
  } else {
    video.style.width = '';
    video.style.height = '';
  }
  whiteboard.redraw();
}

async function screenshot() {
  if (!video.videoWidth) return;
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const file = await remoto.invoke('viewer:screenshot', await blob.arrayBuffer());
  toast({ kind: 'ok', title: 'Screenshot salvato', text: file, actions: [{ label: 'Mostra nella cartella', onClick: () => remoto.invoke('viewer:show-item', file) }] });
}

async function toggleRecording() {
  if (S.recorder?.active) return stopRecording();
  if (!video.srcObject) return undefined;
  try {
    S.recorder = new Recorder(video.srcObject);
    await S.recorder.start();
    toast({ kind: 'info', title: 'Registrazione avviata', text: 'Il video viene salvato nella cartella Video\\Remoto.' });
  } catch (err) {
    S.recorder = null;
    toast({ kind: 'bad', title: 'Registrazione non avviata', text: cleanError(err) });
  }
  renderToolbar();
  return undefined;
}

async function stopRecording() {
  const rec = S.recorder;
  S.recorder = null;
  renderToolbar();
  const file = await rec?.stop().catch(() => null);
  if (file) toast({ kind: 'ok', title: 'Registrazione salvata', text: file, actions: [{ label: 'Mostra nella cartella', onClick: () => remoto.invoke('viewer:show-item', file) }] });
}

async function typeClipboard() {
  const text = await remoto.invoke('viewer:clipboard-text');
  if (!text) {
    toast({ kind: 'info', title: 'Gli appunti locali non contengono testo' });
    return;
  }
  if (text.length > 2000 && !(await confirmDialog({ title: 'Digitare un testo lungo?', text: `Verranno digitati ${text.length} caratteri sul computer remoto.`, confirm: 'Digita' }))) return;
  S.peer?.sendCtrl({ t: 'text', s: text });
}

async function sysAction(op) {
  const texts = {
    restart: { title: 'Riavviare il computer remoto?', text: 'Il computer remoto si riavvierà tra pochi secondi. Remoto proverà a riconnettersi: quando il PC sarà di nuovo acceso (con Remoto avviato), la richiesta andrà accettata là.', confirm: 'Riavvia' },
    lock: { title: 'Bloccare la sessione Windows remota?', text: 'Sul computer remoto comparirà la schermata di blocco: per continuare servirà la password dell’utente Windows.', confirm: 'Blocca' },
  }[op];
  if (await confirmDialog({ ...texts, danger: true })) S.peer?.sendCtrl({ t: 'sys', op });
}

function sessionInfo() {
  const rows = [
    ['Postazione', hostName()],
    ['ID', S.ui.hostId ? formatId(S.ui.hostId) : '—'],
    ['Instradamento', S.ui.route === 'direct' ? 'Connessione diretta (LAN/IP)' : 'Tramite server ID'],
    ['Collegamento', CONN_LABELS[S.stats?.conn || ''] || '—'],
    ['Sistema remoto', S.hello?.os === 'win32' ? 'Windows' : S.hello?.os || '—'],
    ['Remoto come amministratore', S.hello?.admin ? 'Sì' : 'No'],
    ['Controllo completo', S.caps?.fullControl ? 'Sì (finestre di amministratore, UAC, blocco)' : 'No'],
    ['Durata', S.connectedAt ? formatDuration(Date.now() - S.connectedAt) : '—'],
  ];
  modal({
    title: 'Informazioni sulla sessione',
    body: h(
      'div',
      { class: 'col', style: { gap: '14px' } },
      h('div', { class: 'col', style: { gap: '6px' } }, rows.map(([k, v]) => h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('span', { class: 'muted' }, k), h('strong', { class: 'selectable' }, v)))),
      h('div', { class: 'field-label' }, 'Permessi concessi'),
      h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } }, PERMISSIONS.map((p) => h('span', { class: `badge ${S.perms[p.key] ? 'ok' : ''}` }, icon(S.perms[p.key] ? 'check' : 'x', 'sm'), p.label))),
    ),
    actions: [{ label: 'Chiudi', kind: 'primary', value: true }],
  });
}

function onHotkey(e) {
  if (!(e.ctrlKey && e.altKey && e.shiftKey)) return false;
  if (e.code === 'KeyF' && isDesktop()) remoto.send('viewer:fullscreen', !S.fullscreen);
  else if (e.code === 'KeyV') toggleViewOnly();
  else if (e.code === 'KeyS' && connected()) screenshot();
  else return false;
  return true;
}

// ---------------------------------------------------------------- barra strumenti

function tbBtn({ iconName, label, tip, active, disabled, onClick, caret, badge, cls = '' }) {
  const b = h(
    'button',
    {
      class: `tb-btn ${active ? 'active' : ''} ${cls}`,
      tabindex: '-1',
      disabled,
      'data-tip': tip || null,
      'aria-label': tip || label || '',
      onMousedown: (e) => e.preventDefault(),
      onClick: (e) => onClick?.(e.currentTarget),
    },
    iconName ? icon(iconName) : null,
    label ? h('span', null, label) : null,
    caret ? icon('chevron-down', 'caret') : null,
    badge ? h('span', { class: 'badge-dot' }, String(badge)) : null,
  );
  return b;
}

function renderBadge() {
  if (!badgeEl) return;
  const st = S.peer?.pc.connectionState;
  if (connected() && st === 'disconnected') {
    badgeEl.className = 'badge warn';
    replace(badgeEl, h('span', { class: 'dot warn pulse' }), 'Riconnessione…');
    return;
  }
  if (!connected()) {
    badgeEl.className = 'badge';
    replace(badgeEl, 'Non connesso');
    return;
  }
  const conn = S.stats?.conn || S.ui.connType || '';
  badgeEl.className = `badge ${conn === 'relay' ? 'warn' : 'ok'}`;
  replace(badgeEl, h('span', { class: `dot ${conn === 'relay' ? 'warn' : 'ok'}` }), `${CONN_LABELS[conn] || 'Connesso'}${S.stats?.rtt != null ? ` · ${S.stats.rtt} ms` : ''}`);
}

function renderToolbar() {
  const on = connected();
  const desk = isDesktop();
  const control = on && S.perms.control && !S.viewOnly;
  const p = S.perms;
  badgeEl = h('span', { class: 'badge' });
  recTimeEl = null;

  const host = h(
    'div',
    { class: 'host' },
    avatar(hostName(), 'sm'),
    h('div', { class: 'grow' }, h('div', { class: 'name ellipsis' }, hostName()), h('div', { class: 'sub' }, h('span', { class: 'mono' }, hostIdLabel()))),
  );

  const items = [host, badgeEl];
  if (desk) {
    items.push(
      h('div', { class: 'sep' }),
      h(
        'div',
        { class: 'tb-group' },
        tbBtn({ iconName: 'monitor', tip: 'Schermo remoto', caret: true, disabled: !on || !S.displays.length, onClick: (el) => displayMenu(el) }),
        tbBtn({ iconName: 'gauge', tip: `Qualità: ${QUALITY_PRESETS[S.quality]?.label || ''}`, caret: true, disabled: !on, onClick: (el) => qualityMenu(el) }),
        tbBtn({ iconName: S.scaleMode === 'fit' ? 'fit' : 'maximize', tip: S.scaleMode === 'fit' ? 'Adatta alla finestra (clic: dimensione originale)' : 'Dimensione originale (clic: adatta)', disabled: !on, onClick: () => setScaleMode(S.scaleMode === 'fit' ? 'original' : 'fit') }),
      ),
      h('div', { class: 'sep' }),
      h(
        'div',
        { class: 'tb-group' },
        tbBtn({ iconName: 'keyboard', tip: 'Tasti speciali', caret: true, disabled: !control, onClick: (el) => keyboardMenu(el) }),
        tbBtn({ iconName: S.viewOnly || !p.control ? 'eye' : 'mouse', tip: !p.control ? 'Il remoto non consente il controllo' : S.viewOnly ? 'Sola visualizzazione (clic: controlla)' : 'Controllo attivo (clic: sola visualizzazione)', active: S.viewOnly, disabled: !on || !p.control, onClick: () => toggleViewOnly() }),
        tbBtn({ iconName: 'clipboard', tip: !p.clipboard ? 'Appunti non consentiti dal remoto' : S.sync ? 'Appunti sincronizzati (clic: disattiva)' : 'Appunti non sincronizzati (clic: attiva)', active: on && S.sync && p.clipboard, disabled: !on || !p.clipboard, onClick: () => toggleSync() }),
        tbBtn({ iconName: S.mic.track ? 'headphones' : S.audio && S.hello?.audio ? 'volume' : 'volume-x', tip: 'Audio e microfono', caret: true, disabled: !on, onClick: (el) => audioMenu(el) }),
        S.mic.track ? tbBtn({ iconName: S.mic.muted ? 'mic-off' : 'mic', tip: S.mic.muted ? 'Microfono silenziato (clic: riattiva)' : `Il tuo microfono parla sul PC remoto (clic: silenzia)`, active: !S.mic.muted, cls: S.mic.muted ? 'alert' : '', onClick: () => toggleMicMute() }) : null,
      ),
    );
  }
  items.push(
    h('div', { class: 'sep' }),
    h(
      'div',
      { class: 'tb-group' },
      tbBtn({ iconName: 'chat', tip: 'Chat', active: S.panel === 'chat', badge: S.unread || null, disabled: !on, onClick: () => setPanel(S.panel === 'chat' ? null : 'chat') }),
      desk && tbBtn({ iconName: 'folder', tip: p.files ? 'Trasferimento file' : 'Trasferimento file non consentito', active: S.panel === 'files', disabled: !on || !p.files, onClick: () => setPanel(S.panel === 'files' ? null : 'files') }),
      desk && tbBtn({ iconName: 'pen', tip: p.whiteboard ? 'Lavagna' : 'Lavagna non consentita', active: S.wb, disabled: !on || !p.whiteboard, onClick: () => toggleWhiteboard() }),
      desk && tbBtn({ iconName: 'more', tip: 'Altre azioni', disabled: !on, onClick: (el) => actionsMenu(el) }),
    ),
    h('div', { class: 'spacer' }),
  );
  if (S.recorder?.active) {
    recTimeEl = h('span', { class: 'mono', style: { fontSize: '12px' } }, formatDuration(Date.now() - S.recorder.startedAt));
    items.push(h('button', { class: 'tb-btn alert', tabindex: '-1', 'data-tip': 'Ferma la registrazione', onClick: () => stopRecording() }, h('span', { class: 'rec-dot' }), recTimeEl));
  }
  if (desk) {
    items.push(
      tbBtn({ iconName: 'activity', tip: 'Statistiche di connessione', active: S.showStats, disabled: !on, onClick: () => toggleStats() }),
      tbBtn({ iconName: S.fullscreen ? 'minimize' : 'maximize', tip: S.fullscreen ? 'Esci da schermo intero (Ctrl+Alt+Maiusc+F)' : 'Schermo intero (Ctrl+Alt+Maiusc+F)', onClick: () => remoto.send('viewer:fullscreen', !S.fullscreen) }),
    );
  }
  items.push(
    on
      ? h('button', { class: 'btn danger sm disconnect', tabindex: '-1', 'aria-label': 'Disconnetti', onMousedown: (e) => e.preventDefault(), onClick: () => remoto.send('viewer:disconnect') }, icon('plug', 'sm'), 'Disconnetti')
      : h('button', { class: 'btn sm disconnect', tabindex: '-1', 'aria-label': 'Chiudi', onClick: () => remoto.send('viewer:close') }, icon('x', 'sm'), 'Chiudi'),
  );
  replace(toolbarEl, ...items);
  renderBadge();
  wrap.classList.toggle('control', on && desk && control && !S.wb);
  wrap.classList.toggle('view-only', !(on && control));
  statsEl.classList.toggle('hidden', !(S.showStats && on && desk));
}

function displayMenu(el) {
  openMenu(el, [
    { title: 'Schermo del computer remoto' },
    ...S.displays.map((d) => ({
      label: `${d.label}${d.primary ? ' (principale)' : ''}`,
      sub: `${d.width} × ${d.height}`,
      icon: 'monitor',
      checked: d.id === S.active,
      onClick: () => S.peer?.sendCtrl({ t: 'display', id: d.id }),
    })),
  ]);
}

function qualityMenu(el) {
  const desc = { quality: 'Massima nitidezza, più banda', balanced: 'Buon compromesso (consigliato)', speed: 'Fluidità su connessioni lente' };
  openMenu(el, [
    { title: 'Qualità dell’immagine' },
    ...Object.entries(QUALITY_PRESETS).map(([key, preset]) => ({
      label: preset.label,
      sub: desc[key],
      icon: key === 'speed' ? 'zap' : key === 'quality' ? 'sparkles' : 'gauge',
      checked: key === S.quality,
      onClick: () => {
        S.quality = key;
        S.peer?.sendCtrl({ t: 'quality', preset: key });
        remoto.send('viewer:prefs', { quality: key });
        renderToolbar();
      },
    })),
  ]);
}

function keyboardMenu(el) {
  const combo = (name) => () => S.peer?.sendCtrl({ t: 'combo', name });
  openMenu(el, [
    { title: 'Invia al computer remoto' },
    {
      label: 'Ctrl + Alt + Canc',
      sub: S.caps?.sas ? 'Richiede il controllo completo' : 'Non disponibile: manca il servizio di controllo completo sul PC remoto',
      icon: 'shield',
      disabled: !S.caps?.sas,
      onClick: combo('ctrl-alt-del'),
    },
    { label: 'Ctrl + Maiusc + Esc', sub: 'Gestione attività', icon: 'activity', onClick: combo('ctrl-shift-esc') },
    { label: 'Tasto Windows', sub: 'Menu Start', icon: 'grid', onClick: combo('win') },
    { label: 'Win + R', sub: 'Esegui', icon: 'terminal', onClick: combo('win-r') },
    { label: 'Win + D', sub: 'Mostra desktop', icon: 'monitor', onClick: combo('win-d') },
    { label: 'Win + E', sub: 'Esplora file', icon: 'folder', onClick: combo('win-e') },
    { label: 'Win + Tab', sub: 'Visualizzazione attività', icon: 'list', onClick: combo('win-tab') },
    { label: 'Alt + Tab', sub: 'Cambia finestra', icon: 'copy', onClick: combo('alt-tab') },
    { label: 'Alt + F4', sub: 'Chiudi la finestra attiva', icon: 'x', onClick: combo('alt-f4') },
    { label: 'Stamp', sub: 'Cattura schermo sul remoto', icon: 'camera', onClick: combo('printscreen') },
    { divider: true },
    { label: 'Digita il testo degli appunti', sub: 'Utile dove incollare non funziona', icon: 'type', onClick: () => typeClipboard() },
    { divider: true },
    { label: 'Ctrl + Alt + Canc', sub: 'Richiede un servizio di sistema', icon: 'lock', disabled: true, tooltip: 'Windows accetta Ctrl+Alt+Canc solo da un servizio di sistema' },
  ]);
}

function actionsMenu(el) {
  const p = S.perms;
  openMenu(el, [
    { label: 'Screenshot', icon: 'camera', shortcut: 'Ctrl+Alt+Maiusc+S', onClick: () => screenshot() },
    { label: S.recorder?.active ? 'Ferma registrazione' : 'Registra la sessione', icon: S.recorder?.active ? 'stop' : 'record', onClick: () => toggleRecording() },
    { divider: true },
    { label: 'Modalità privacy', sub: p.privacy ? 'Oscura lo schermo per chi è davanti al PC remoto' : 'Non consentita dal computer remoto', icon: 'eye-off', checked: S.privacy, disabled: !p.privacy, onClick: () => S.peer?.sendCtrl({ t: 'privacy', on: !S.privacy }) },
    { label: 'Blocca mouse e tastiera del remoto', sub: !p.blockInput ? 'Non consentito dal computer remoto' : S.hello?.admin ? 'Chi è davanti al PC remoto non può interferire' : 'Richiede Remoto avviato come amministratore sul PC remoto', icon: 'lock', checked: S.blocked, disabled: !p.blockInput || !S.hello?.admin, onClick: () => S.peer?.sendCtrl({ t: 'block', on: !S.blocked }) },
    { divider: true },
    { label: 'Blocca la sessione Windows', icon: 'unlock', disabled: !p.system, sub: p.system ? '' : 'Non consentito dal computer remoto', onClick: () => sysAction('lock') },
    { label: 'Riavvia il computer remoto', icon: 'power', danger: p.system, disabled: !p.system, sub: p.system ? 'La riconnessione andrà riaccettata sul PC remoto' : 'Non consentito dal computer remoto', onClick: () => sysAction('restart') },
    { divider: true },
    { label: 'Riconnetti', icon: 'refresh', onClick: () => remoto.send('viewer:reconnect') },
    { label: 'Informazioni sulla sessione', icon: 'info', onClick: () => sessionInfo() },
  ], { align: 'right' });
}

function setupFullscreenToolbar() {
  let hideTimer = 0;
  const show = () => {
    clearTimeout(hideTimer);
    appEl.classList.add('toolbar-visible');
  };
  const hideSoon = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => appEl.classList.remove('toolbar-visible'), 900);
  };
  hotzone.addEventListener('mouseenter', show);
  toolbarEl.addEventListener('mouseenter', show);
  toolbarEl.addEventListener('mouseleave', hideSoon);
}

// ---------------------------------------------------------------- livello di stato

function steps(n) {
  return h('div', { class: 'steps' }, [1, 2, 3].map((i) => h('span', { class: i <= n ? 'on' : '' })));
}

function renderStatus() {
  const st = S.ui.state;
  if (st === 'connected') {
    statusEl.classList.add('hidden');
    return;
  }
  statusEl.classList.remove('hidden');
  const target = h('div', { class: 'target' }, S.ui.hostId ? formatId(S.ui.hostId) : S.info.targetLabel);
  const cancel = h('button', { class: 'btn', onClick: () => remoto.send('viewer:close') }, 'Annulla');
  let card;
  if (st === 'connecting' || st === 'requesting') {
    card = [
      h('div', { class: 'spinner lg' }),
      h('h2', null, S.info.mode === 'files' ? 'Apertura del trasferimento file' : 'Connessione in corso'),
      target,
      h('p', { class: 'muted' }, st === 'requesting' ? (S.ui.route === 'direct' ? 'Richiesta inviata direttamente in rete locale…' : 'Richiesta inviata tramite il server ID…') : 'Ricerca della postazione…'),
      steps(1),
      h('div', { class: 'buttons' }, cancel),
    ];
  } else if (st === 'waiting') {
    card = [
      h('div', { class: 'state-icon' }, icon('user')),
      h('h2', null, 'In attesa di conferma'),
      target,
      h('p', { class: 'muted' }, `Chi è davanti a ${hostName()} deve accettare la richiesta.`),
      h('div', { class: 'row', style: { justifyContent: 'center' } }, h('span', { class: 'dot ok pulse' }), h('span', { class: 'faint' }, 'Richiesta mostrata sul computer remoto')),
      steps(2),
      h('div', { class: 'buttons' }, cancel),
    ];
  } else if (st === 'accepted') {
    card = [h('div', { class: 'spinner lg' }), h('h2', null, 'Accesso consentito'), target, h('p', { class: 'muted' }, 'Avvio della connessione diretta cifrata…'), steps(3)];
  } else {
    const closed = st === 'closed';
    const restarting = S.restarting && Date.now() < S.restartDeadline;
    card = [
      h('div', { class: `state-icon ${closed || restarting ? '' : 'bad'}` }, icon(restarting ? 'refresh' : closed ? 'plug' : 'alert')),
      h('h2', null, restarting ? 'Riavvio in corso' : closed ? 'Sessione terminata' : 'Connessione non riuscita'),
      target,
      h('p', { class: 'muted' }, restarting ? 'In attesa che il computer remoto torni online: nuovo tentativo ogni pochi secondi.' : reasonText(S.ui.reason)),
      !restarting && S.ui.detail ? h('p', { class: 'faint', style: { fontSize: '12px' } }, `Dettaglio tecnico: ${S.ui.detail}`) : null,
      h(
        'div',
        { class: 'buttons' },
        h('button', { class: 'btn primary', onClick: () => remoto.send('viewer:reconnect') }, icon('refresh', 'sm'), 'Riconnetti'),
        h('button', { class: 'btn', onClick: () => remoto.send('viewer:close') }, 'Chiudi'),
      ),
    ];
  }
  replace(statusEl, h('div', { class: 'status-card' }, card));
}

function updateTitle() {
  const name = hostName();
  const id = S.ui.hostId ? ` (${formatId(S.ui.hostId)})` : '';
  const mode = isDesktop() ? '' : ' · trasferimento file';
  remoto.send('viewer:title', `${name}${id}${mode} - Remoto`);
}

// ---------------------------------------------------------------- statistiche

async function updateStats() {
  if (!probe) return;
  try {
    S.stats = await probe.sample();
  } catch {
    return;
  }
  renderBadge();
  renderStatsOverlay();
  if (recTimeEl && S.recorder?.active) recTimeEl.textContent = formatDuration(Date.now() - S.recorder.startedAt);
}

function renderStatsOverlay() {
  if (!S.showStats || !S.stats) return;
  replace(statsEl, statsRows(S.stats).map(([k, v]) => h('div', { class: 'st-row' }, h('span', null, k), h('span', null, v))));
}

// aggancio per i test end-to-end (visibile solo dentro questa pagina)
window.__remotoSession = { state: S, rpc, upload, download, screenshot, toggleRecording, stopRecording, transferList, selectMic, audioDevices };
