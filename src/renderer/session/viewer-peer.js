// RTCPeerConnection lato viewer: riceve l'offerta dall'host, risponde, apre i canali dati.
import { recvonlyAudioMid } from '../../shared/sdp.js';

export class ViewerPeer extends EventTarget {
  constructor({ iceServers = [] }) {
    super();
    this.channels = {};
    this.pendingIce = [];
    this.closed = false;
    this.stream = null;
    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
    this.pc = pc;
    pc.ontrack = (e) => {
      if (!this.stream) this.stream = e.streams[0] || new MediaStream();
      if (!this.stream.getTracks().includes(e.track)) this.stream.addTrack(e.track);
      this.#emit('track', { track: e.track, stream: this.stream });
    };
    pc.ondatachannel = (e) => {
      const ch = e.channel;
      ch.binaryType = 'arraybuffer';
      this.channels[ch.label] = ch;
      if (ch.label === 'ctrl') {
        ch.onmessage = (m) => {
          if (typeof m.data !== 'string') return;
          try {
            this.#emit('ctrl', JSON.parse(m.data));
          } catch {
            /* messaggio non valido */
          }
        };
      }
      const announce = () => this.#emit('channel', { label: ch.label, channel: ch });
      if (ch.readyState === 'open') announce();
      else ch.addEventListener('open', announce, { once: true });
      ch.addEventListener('close', () => this.#emit('channel-close', { label: ch.label }));
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) remoto.send('viewer:signal', { k: 'ice', c: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => this.#emit('state', { state: pc.connectionState });
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async handleSignal(data) {
    if (this.closed) return;
    try {
      if (data.k === 'sdp' && data.sdp?.type === 'offer') {
        await this.pc.setRemoteDescription(data.sdp);
        this.#bindMic(data.sdp.sdp);
        for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        remoto.send('viewer:signal', { k: 'sdp', sdp: this.pc.localDescription.toJSON() });
      } else if (data.k === 'ice' && data.c) {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(data.c).catch(() => {});
        else this.pendingIce.push(data.c);
      }
    } catch (err) {
      remoto.send('app:log', 'error', `segnalazione viewer: ${err.message}`);
    }
  }

  /** Il canale "recvonly" dell'host diventa il nostro canale di invio del microfono. */
  #bindMic(sdp) {
    if (this.micSender) return;
    const mid = recvonlyAudioMid(sdp);
    if (mid === null) return;
    const t = this.pc.getTransceivers().find((x) => x.mid === mid);
    if (!t) return;
    t.direction = 'sendonly';
    this.micSender = t.sender;
    if (this.pendingMic) this.micSender.replaceTrack(this.pendingMic).catch(() => {});
  }

  get micAvailable() {
    return Boolean(this.micSender);
  }

  /** Collega (o scollega, con null) il microfono locale: nessuna rinegoziazione. */
  async setMicTrack(track) {
    this.pendingMic = track;
    if (this.micSender) await this.micSender.replaceTrack(track);
  }

  get ctrlOpen() {
    return this.channels.ctrl?.readyState === 'open';
  }

  sendCtrl(msg) {
    const ch = this.channels.ctrl;
    if (ch?.readyState === 'open') {
      ch.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  sendMove(msg) {
    const ch = this.channels.move;
    if (ch?.readyState === 'open' && ch.bufferedAmount < 64 * 1024) ch.send(JSON.stringify(msg));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.pc.close();
    } catch {
      /* già chiusa */
    }
  }
}
