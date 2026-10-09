// Una sessione in arrivo vista dall'engine: cattura dello schermo, RTCPeerConnection (offerente),
// canali dati. Ogni messaggio del viewer è filtrato sui permessi; il main ricontrolla comunque.
import { getPreset, orderCodecs, CAPTURE_FRAMERATE } from '../../shared/quality.js';
import { TransferEngine } from '../lib/transfers.js';
import { ClipboardAssembler, sendClipboard } from '../lib/clipchannel.js';
import { classifyPair, selectedPair } from '../../shared/netinfo.js';

const INPUT_TYPES = new Set(['mb', 'mw', 'k', 'text', 'combo', 'release']);

// Fotogrammi al secondo per lo stream del desktop protetto (UAC/blocco) ricostruito dai fotogrammi del servizio.
const SECURE_FPS = 9;

/** Cavi audio virtuali noti: lì si riproduce il microfono di chi si collega, che Teams & co. vedono come microfono. */
export const VIRTUAL_CABLE = /(CABLE[- ]?(A |B )?Input|VB-Audio|Virtual Audio Cable|Voicemeeter.*(Input|VAIO)|Hi-Fi Cable|Virtual Cable)/i;

function fsBackend(id) {
  const s = (op, ...args) => remoto.invoke('enginefs', id, op, ...args);
  return {
    expand: (paths) => remoto.invoke('engine:fs', id, 'expand', { paths }),
    openRead: (p) => s('open-read', p),
    read: (h, len) => s('read', h, len),
    closeRead: (h) => s('close-read', h),
    beginWrite: (dir) => s('begin-write', dir),
    openWrite: (ctx, rel, opts) => s('open-write', ctx, rel, opts),
    write: (h, data) => s('write', h, data),
    finishWrite: (h) => s('finish-write', h),
    abortWrite: (h) => s('abort-write', h),
    endWrite: (ctx) => s('end-write', ctx),
  };
}

/** Tipo di collegamento dalla coppia di candidati ICE scelta. */
export async function connectionType(pc) {
  try {
    const sel = selectedPair(await pc.getStats());
    return sel ? classifyPair(sel.local, sel.remote) : '';
  } catch {
    return '';
  }
}

export class HostPeer {
  constructor(info) {
    this.id = info.id;
    this.mode = info.mode;
    this.perms = info.perms;
    this.prefs = info.prefs || { quality: 'balanced', codec: 'auto', audio: true };
    this.iceServers = info.iceServers || [];
    this.hostName = info.hostName;
    this.admin = info.admin;
    this.caps = info.caps || { fullControl: false, sas: false };
    this.platform = info.platform;
    this.pendingIce = [];
    this.closed = false;
    this.reported = false;
    this.restartTried = false;
    this.privacy = false;
    this.blocked = false;
    this.secure = false; // il controllato è su un desktop protetto
    this.secureActive = false; // stiamo trasmettendo i fotogrammi del servizio al posto della cattura normale
  }

  async start() {
    this.displays = await remoto.invoke('engine:displays');
    this.active = this.displays.find((d) => d.primary) || this.displays[0];
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
    this.pc = pc;
    this.ctrl = pc.createDataChannel('ctrl', { ordered: true });
    this.move = pc.createDataChannel('move', { ordered: false, maxRetransmits: 0 });
    this.file = pc.createDataChannel('file', { ordered: true });
    this.ctrl.onmessage = (e) => this.#onCtrl(e.data);
    this.move.onmessage = (e) => this.#onMove(e.data);
    this.ctrl.onopen = () => {
      this.#sendHello();
      this.#reportConnected();
    };
    this.transfers = new TransferEngine({
      channel: this.file,
      backend: fsBackend(this.id),
      canReceive: () => (this.perms.files ? true : 'Il trasferimento file non è consentito'),
      onOther: (msg) => this.clip.add(msg),
    });
    this.clip = new ClipboardAssembler((payload) => {
      if (this.perms.clipboard) remoto.send('engine:clipboard-in', this.id, payload);
    });
    if (this.mode === 'desktop') await this.#startMedia();
    if (this.closed) return;
    pc.onicecandidate = (e) => {
      if (e.candidate) this.#signal({ k: 'ice', c: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => this.#onConnectionState();
    await this.#offer();
  }

  // ---------- media ----------

  async #capture(display, withAudio) {
    // la frequenza di cattura non segue il preset: più è alta, più l'immagine catturata è recente
    const video = {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: display.sourceId,
        maxWidth: display.width,
        maxHeight: display.height,
        maxFrameRate: CAPTURE_FRAMERATE,
      },
    };
    if (withAudio) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } }, video });
      } catch (err) {
        console.warn('audio di sistema non disponibile:', err.message);
      }
    }
    return navigator.mediaDevices.getUserMedia({ audio: false, video });
  }

  async #startMedia() {
    const preset = getPreset(this.prefs.quality);
    this.stream = await this.#capture(this.active, this.perms.audio && this.prefs.audio !== false);
    this.videoTrack = this.stream.getVideoTracks()[0];
    this.videoTrack.contentHint = preset.contentHint;
    this.videoTrack.onended = () => this.#onTrackEnded();
    const vt = this.pc.addTransceiver(this.videoTrack, { direction: 'sendonly', streams: [this.stream] });
    this.videoSender = vt.sender;
    try {
      const caps = RTCRtpSender.getCapabilities('video');
      if (caps) vt.setCodecPreferences(orderCodecs(caps.codecs, this.prefs.codec));
    } catch (err) {
      console.warn('preferenze codec:', err.message);
    }
    const audioTrack = this.stream.getAudioTracks()[0];
    if (audioTrack) this.audioSender = this.pc.addTransceiver(audioTrack, { direction: 'sendonly', streams: [this.stream] }).sender;
    // microfono di chi si collega: il canale c'è sempre, il viewer ci attacca la traccia quando vuole
    this.micTransceiver = this.pc.addTransceiver('audio', { direction: 'recvonly' });
    this.pc.addEventListener('track', (e) => {
      if (e.transceiver !== this.micTransceiver) return;
      this.micTrack = e.track;
      e.track.onunmute = () => this.#micActivity(true);
      e.track.onmute = () => this.#micActivity(false);
      this.routeMic().catch((err) => console.warn('microfono remoto:', err.message));
    });
    remoto.send('engine:display', this.id, this.active.id);
  }

  async #applyQuality(name) {
    const p = getPreset(name);
    this.prefs.quality = name;
    if (!this.videoSender) return;
    const params = this.videoSender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = p.maxBitrate;
    params.encodings[0].maxFramerate = p.maxFramerate;
    params.encodings[0].scaleResolutionDownBy = p.scale;
    params.degradationPreference = p.degradation;
    try {
      await this.videoSender.setParameters(params);
    } catch (err) {
      console.warn('setParameters:', err.message);
    }
    if (this.videoTrack) this.videoTrack.contentHint = p.contentHint;
  }

  async #switchDisplay(displayId) {
    if (this.secureActive) return; // mentre è attivo il desktop protetto la traccia è quella del servizio
    const d = this.displays.find((x) => x.id === String(displayId));
    if (!d || !this.videoSender || (this.active && d.id === this.active.id && this.videoTrack?.readyState === 'live')) return;
    const stream = await this.#capture(d, false);
    const track = stream.getVideoTracks()[0];
    track.contentHint = getPreset(this.prefs.quality).contentHint;
    track.onended = () => this.#onTrackEnded();
    await this.videoSender.replaceTrack(track);
    if (this.videoTrack && this.videoTrack !== track) {
      this.videoTrack.onended = null;
      this.videoTrack.stop();
    }
    this.videoTrack = track;
    this.active = d;
    remoto.send('engine:display', this.id, d.id);
    this.#send({ t: 'displays', displays: this.#publicDisplays(), active: d.id });
  }

  #onTrackEnded() {
    // il monitor catturato è stato scollegato: si torna al principale
    if (this.closed) return;
    const fallback = this.displays.find((d) => d.primary) || this.displays[0];
    if (fallback) this.#switchDisplay(fallback.id).catch((err) => console.warn('cambio schermo:', err.message));
  }

  async displaysChanged(list) {
    this.displays = list;
    if (this.mode !== 'desktop') return;
    if (!list.some((d) => d.id === this.active?.id)) {
      const fallback = list.find((d) => d.primary) || list[0];
      if (fallback) {
        this.active = null;
        await this.#switchDisplay(fallback.id).catch(() => {});
      }
    } else {
      this.active = list.find((d) => d.id === this.active.id);
      this.#send({ t: 'displays', displays: this.#publicDisplays(), active: this.active.id });
    }
  }

  #publicDisplays() {
    return this.displays.map((d) => ({ id: d.id, label: d.label, primary: d.primary, width: d.width, height: d.height }));
  }

  // ---------- microfono di chi si collega ----------

  #micActivity(active) {
    this.micActive = active;
    remoto.send('engine:mic', this.id, { active, routed: Boolean(this.micRoutedTo), device: this.micRoutedTo || '', reason: this.micReason || '' });
  }

  #stopMic() {
    if (this.micAudio) {
      this.micAudio.pause();
      this.micAudio.srcObject = null;
    }
    this.micRoutedTo = '';
  }

  /** Riproduce il microfono ricevuto sul dispositivo scelto (di norma un cavo audio virtuale). */
  async routeMic() {
    if (!this.micTrack || this.closed) return;
    const report = (ok, extra) => {
      this.micReason = ok ? '' : extra.reason;
      this.#send({ t: 'mic-status', ok, ...extra });
      remoto.send('engine:mic', this.id, { active: Boolean(this.micActive), routed: ok, device: ok ? extra.device : '', reason: this.micReason });
    };
    if (!this.perms.microphone) {
      this.#stopMic();
      return report(false, { reason: 'denied' });
    }
    const prefs = (await remoto.invoke('engine:audio-prefs').catch(() => null)) || { micSink: 'auto' };
    if (prefs.micSink === 'none') {
      this.#stopMic();
      return report(false, { reason: 'disabled' });
    }
    const outputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    let device = null;
    if (prefs.micSink === 'default') device = { deviceId: '', label: 'Altoparlanti predefiniti' };
    else if (prefs.micSink && prefs.micSink !== 'auto') device = outputs.find((d) => d.deviceId === prefs.micSink) || outputs.find((d) => d.label && d.label === prefs.micSinkLabel) || null;
    if (!device) device = outputs.find((d) => d.deviceId !== 'default' && d.deviceId !== 'communications' && VIRTUAL_CABLE.test(d.label)) || null;
    if (!device) {
      this.#stopMic();
      return report(false, { reason: 'no-virtual-device' });
    }
    if (!this.micAudio) {
      this.micAudio = new Audio();
      this.micAudio.autoplay = true;
    }
    this.micAudio.srcObject = new MediaStream([this.micTrack]);
    try {
      await this.micAudio.setSinkId(device.deviceId);
      await this.micAudio.play().catch(() => {});
    } catch (err) {
      this.#stopMic();
      return report(false, { reason: 'sink-error', error: err.message });
    }
    this.micRoutedTo = device.label || 'dispositivo audio';
    return report(true, { device: this.micRoutedTo });
  }

  // ---------- segnalazione ----------

  #signal(data) {
    if (!this.closed) remoto.send('engine:signal', this.id, data);
  }

  async #offer(iceRestart = false) {
    const offer = await this.pc.createOffer({ iceRestart });
    await this.pc.setLocalDescription(offer);
    this.#signal({ k: 'sdp', sdp: this.pc.localDescription.toJSON() });
  }

  async onSignal(data) {
    if (this.closed || !this.pc) return;
    try {
      if (data.k === 'sdp' && data.sdp?.type === 'answer') {
        await this.pc.setRemoteDescription(data.sdp);
        for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
        await this.#applyQuality(this.prefs.quality);
      } else if (data.k === 'ice' && data.c) {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(data.c).catch(() => {});
        else this.pendingIce.push(data.c);
      }
    } catch (err) {
      console.error('segnalazione:', err);
    }
  }

  async #onConnectionState() {
    const st = this.pc.connectionState;
    if (st === 'connected') this.#reportConnected();
    else if (st === 'failed') {
      if (this.reported && !this.restartTried) {
        this.restartTried = true;
        this.#offer(true).catch(() => remoto.send('engine:state', this.id, 'failed', { reason: 'webrtc-failed' }));
      } else remoto.send('engine:state', this.id, 'failed', { reason: 'webrtc-failed' });
    }
  }

  async #reportConnected() {
    if (this.reported) return;
    this.reported = true;
    const connType = await connectionType(this.pc);
    remoto.send('engine:state', this.id, 'connected', { connType });
    // la coppia di candidati scelta può cambiare nei primi secondi: si aggiorna il dato
    setTimeout(async () => {
      if (this.closed) return;
      const later = await connectionType(this.pc);
      if (later && later !== connType) remoto.send('engine:state', this.id, 'info', { connType: later });
    }, 4000);
  }

  // ---------- canali dati ----------

  #send(msg) {
    if (this.ctrl?.readyState === 'open') this.ctrl.send(JSON.stringify(msg));
  }

  async #sendHello() {
    const macs = await remoto.invoke('engine:macs').catch(() => []);
    this.#send({
      t: 'hello',
      name: this.hostName,
      os: this.platform,
      admin: this.admin,
      caps: this.caps,
      macs,
      perms: this.perms,
      mode: this.mode,
      displays: this.mode === 'desktop' ? this.#publicDisplays() : [],
      active: this.active?.id || null,
      audio: Boolean(this.audioSender),
      quality: this.prefs.quality,
    });
  }

  #onMove(raw) {
    if (!this.perms.control || typeof raw !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === 'mm') remoto.send('engine:input', this.id, { t: 'mm', x: msg.x, y: msg.y });
  }

  async #onCtrl(raw) {
    if (typeof raw !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (INPUT_TYPES.has(msg.t)) {
      if (this.perms.control) remoto.send('engine:input', this.id, msg);
      return;
    }
    switch (msg.t) {
      case 'display':
        this.#switchDisplay(msg.id).catch((err) => this.#send({ t: 'notice', kind: 'error', text: `Impossibile cambiare schermo: ${err.message}` }));
        break;
      case 'quality':
        await this.#applyQuality(String(msg.preset));
        this.#send({ t: 'quality', preset: this.prefs.quality });
        break;
      case 'audio':
        if (this.audioSender?.track) this.audioSender.track.enabled = Boolean(msg.on) && this.perms.audio;
        break;
      case 'chat':
        if (typeof msg.text === 'string' && msg.text.trim()) remoto.send('engine:chat-in', this.id, msg.text);
        break;
      case 'wb':
        if (this.perms.whiteboard) remoto.send('engine:wb', this.id, msg);
        break;
      case 'privacy': {
        const res = await remoto.invoke('engine:privacy', this.id, Boolean(msg.on));
        this.privacy = Boolean(res.active);
        this.#send({ t: 'privacy', ...res });
        break;
      }
      case 'block': {
        const res = await remoto.invoke('engine:block-input', this.id, Boolean(msg.on));
        this.blocked = Boolean(res.active);
        this.#send({ t: 'block', ...res });
        break;
      }
      case 'sys': {
        const res = await remoto.invoke('engine:system', this.id, String(msg.op));
        this.#send({ t: 'sys-res', op: msg.op, ...res });
        break;
      }
      case 'fs':
        await this.#onFs(msg);
        break;
      case 'ping':
        this.#send({ t: 'pong', ts: msg.ts });
        break;
      default:
        break;
    }
  }

  async #onFs(msg) {
    const reply = (ok, payload) => this.#send({ t: 'fs-res', id: msg.id, ok, ...(ok ? { result: payload } : { error: payload }) });
    if (!this.perms.files) return reply(false, 'Il trasferimento file non è consentito');
    try {
      if (msg.op === 'download') {
        const paths = Array.isArray(msg.args?.paths) ? msg.args.paths.map(String) : [];
        reply(true, { started: true });
        this.transfers.send(Number(msg.args?.x), paths, { mode: 'download' });
        return undefined;
      }
      const result = await remoto.invoke('engine:fs', this.id, String(msg.op), msg.args || {});
      return reply(true, result);
    } catch (err) {
      return reply(false, String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  }

  // ---------- comandi dal main ----------

  setPerms(perms) {
    const micChanged = Boolean(this.perms.microphone) !== Boolean(perms.microphone);
    this.perms = perms;
    if (this.audioSender?.track && !perms.audio) this.audioSender.track.enabled = false;
    this.#send({ t: 'perms', perms });
    if (micChanged) this.routeMic().catch(() => {});
  }

  setCaps(caps) {
    this.caps = caps || { fullControl: false, sas: false };
    this.#send({ t: 'caps', caps: this.caps });
  }

  setSecure(on) {
    this.secure = Boolean(on);
    if (!this.secure) this.#restoreDesktopTrack().catch((err) => console.warn('ripristino schermo:', err.message));
  }

  async #restoreDesktopTrack() {
    if (!this.secureActive) return;
    this.secureActive = false;
    try {
      if (this.videoSender && this.videoTrack) await this.videoSender.replaceTrack(this.videoTrack);
    } catch (err) {
      console.warn('ripristino schermo:', err.message);
    }
    this.secureStream?.getVideoTracks().forEach((t) => t.stop());
    this.secureStream = null;
    this.secureTrack = null;
    this.#send({ t: 'secure', on: false });
  }

  /** Disegna un fotogramma del desktop protetto su una tela e, la prima volta, sostituisce la traccia video inviata. */
  async pushSecureFrame(frame) {
    if (!this.secure || this.mode !== 'desktop' || !this.videoSender || this.closed || this.securePending || !frame?.jpeg) return;
    this.securePending = true;
    try {
      const bmp = await createImageBitmap(new Blob([frame.jpeg], { type: 'image/jpeg' }));
      if (!this.secureCanvas) this.secureCanvas = document.createElement('canvas');
      if (this.secureCanvas.width !== frame.w || this.secureCanvas.height !== frame.h) {
        this.secureCanvas.width = frame.w;
        this.secureCanvas.height = frame.h;
      }
      this.secureCanvas.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close?.();
      if (!this.secureActive) {
        this.secureStream = this.secureCanvas.captureStream(SECURE_FPS);
        this.secureTrack = this.secureStream.getVideoTracks()[0];
        this.secureTrack.contentHint = 'text';
        await this.videoSender.replaceTrack(this.secureTrack);
        this.secureActive = true;
        this.#send({ t: 'secure', on: true });
      } else {
        this.secureTrack?.requestFrame?.();
      }
    } catch (err) {
      console.warn('fotogramma protetto:', err.message);
    } finally {
      this.securePending = false;
    }
  }

  sendClipboard(payload) {
    if (this.perms.clipboard && this.file?.readyState === 'open') sendClipboard(this.file, payload);
  }

  sendChat(text) {
    this.#send({ t: 'chat', text, ts: Date.now() });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.#send({ t: 'bye' });
    } catch {
      /* canale già chiuso */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.videoTrack?.stop();
    this.secureStream?.getTracks().forEach((t) => t.stop());
    this.#stopMic();
    this.pc?.close();
  }
}
