// Sessioni in uscita (questa postazione controlla un'altra).
// La finestra della sessione riceve lo stato tramite l'evento 'state' e la segnalazione WebRTC
// tramite 'signal'; il main la identifica con windowId, non con il sid.
// Non c'è autenticazione con password: l'host accetta o rifiuta ogni richiesta a mano.
import { EventEmitter } from 'node:events';
import { RelayTransport } from '../net/transports.js';
import { firstConnection } from '../net/connect.js';
import { isValidId } from '../../shared/ids.js';
import { PROTOCOL_VERSION, TIMEOUTS, newSid, sanitizeName } from '../../shared/protocol.js';

const BEFORE_RTC = new Set(['connecting', 'requesting', 'waiting', 'accepted']);

// In LAN si prova prima il TCP diretto; l'UDP parte poco dopo (o subito, se il TCP fallisce prima):
// serve quando il firewall dell'altro PC blocca le connessioni in entrata.
const UDP_AFTER_MS = 300;
const LAN_TIMEOUT_MS = 6000;

export class ViewerManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {() => {id:string,name:string}} o.getIdentity
   * @param {object} o.link        ServerLink (online, relay(), iceServers)
   * @param {object|null} o.discovery  { find(id) → {address, addresses, port, uport} | null }
   * @param {Function} o.connectDirect  TCP diretto in LAN
   * @param {Function|null} o.connectUdp  segnalazione UDP in LAN (lan-udp.js)
   * @param {number} o.udpPort  porta UDP da usare per un indirizzo scritto a mano
   */
  constructor({ getIdentity, link, discovery = null, connectDirect, connectUdp = null, udpPort = 0, getExtraIce = () => [], getAddresses = () => [], now = Date.now, timeouts = TIMEOUTS }) {
    super();
    this.getIdentity = getIdentity;
    this.getAddresses = getAddresses;
    this.link = link;
    this.discovery = discovery;
    this.connectDirect = connectDirect;
    this.connectUdp = connectUdp;
    this.udpPort = udpPort;
    this.getExtraIce = getExtraIce;
    this.now = now;
    this.timeouts = timeouts;
    this.sessions = new Map();
  }

  connect({ target, mode = 'desktop', windowId = null, prefs = {} }) {
    const s = {
      sid: newSid(),
      target,
      mode: mode === 'files' ? 'files' : 'desktop',
      windowId,
      prefs,
      state: 'connecting',
      route: null,
      transport: null,
      hostId: target.kind === 'id' ? target.id : null,
      hostName: '',
      perms: null,
      createdAt: this.now(),
      connectedAt: 0,
      timers: {},
      ui: {},
    };
    this.sessions.set(s.sid, s);
    this.#update(s, { state: 'connecting' });
    this.#open(s).catch((err) => this.#end(s, 'failed', err?.code || 'unreachable', { notify: false, detail: err?.detail || '' }));
    return s;
  }

  async #open(s) {
    const me = this.getIdentity();
    const { target } = s;
    if (target.kind === 'id' && target.id === me.id) throw Object.assign(new Error('self'), { code: 'self' });

    let transport = null;
    let lan = null; // strade in rete locale: indirizzi (anche più d'uno), porta TCP e porta UDP
    if (target.kind === 'address') {
      lan = { hosts: [target.host], port: target.port, uport: this.udpPort, seen: false };
    } else {
      const peer = this.discovery?.find(target.id);
      if (peer) lan = { hosts: peer.addresses?.length ? peer.addresses : [peer.address], port: peer.port, uport: peer.uport || 0, seen: true };
      else if (!this.link.online) throw Object.assign(new Error('no-server'), { code: 'no-server' });
    }

    let lastErr = null;
    if (lan) {
      try {
        const res = await firstConnection(this.#lanAttempts(s, lan, me), { accept: (r) => target.kind !== 'id' || r.peer.id === target.id });
        transport = res.transport;
        s.route = 'direct';
        s.via = res.via;
        s.hostId = res.peer.id;
        s.hostName = res.peer.name;
      } catch (err) {
        lastErr = err;
        // si vede in rete locale (i suoi annunci arrivano) ma nessuna strada risponde: è il suo firewall
        if (lan.seen && err.code === 'unreachable') lastErr.code = 'lan-blocked';
      }
    }
    // in LAN non risponde: se c'è il server si passa da lì
    if (!transport && lan && (target.kind !== 'id' || !this.link.online)) throw lastErr;
    if (!transport) {
      transport = new RelayTransport(this.link, target.id, s.sid);
      s.route = 'relay';
    }
    if (s.state === 'closed' || s.state === 'failed') {
      transport.close('cancelled');
      return;
    }
    s.transport = transport;
    transport.on('message', (d) => this.#onMessage(s, d));
    transport.on('close', (why) => {
      if (BEFORE_RTC.has(s.state)) this.#end(s, 'failed', 'connection-lost', { notify: false, detail: why });
    });
    // gli indirizzi di rete locale dicono all'host se siamo nella sua stessa LAN (banda da LAN da subito)
    if (!transport.send({ k: 'req', v: PROTOCOL_VERSION, name: me.name, mode: s.mode, prefs: s.prefs, addrs: this.getAddresses().slice(0, 8) })) {
      throw Object.assign(new Error('send failed'), { code: 'unreachable' });
    }
    s.timers.request = setTimeout(() => {
      if (BEFORE_RTC.has(s.state) && s.state !== 'accepted') this.#end(s, 'failed', 'timeout');
    }, this.timeouts.pendingMs + 5000);
    s.timers.request.unref?.();
    s.state = 'requesting';
    this.#update(s, { state: 'requesting', route: s.route, hostName: s.hostName, hostId: s.hostId });
  }

  /** TCP verso ogni indirizzo in parallelo, poi UDP verso tutti insieme. */
  #lanAttempts(s, lan, me) {
    const attempts = [];
    if (lan.port > 0 && this.connectDirect) {
      for (const host of lan.hosts) {
        attempts.push({ label: `tcp ${host}:${lan.port}`, start: () => this.connectDirect({ host, port: lan.port, identity: me, sid: s.sid, timeoutMs: LAN_TIMEOUT_MS }) });
      }
    }
    if (lan.uport > 0 && this.connectUdp) {
      attempts.push({
        label: `udp ${lan.hosts.join(' ')}:${lan.uport}`,
        delayMs: attempts.length ? UDP_AFTER_MS : 0,
        start: (signal) =>
          this.connectUdp({
            targets: lan.hosts.map((host) => ({ host, port: lan.uport })),
            identity: me,
            sid: s.sid,
            expectId: s.target.kind === 'id' ? s.target.id : null,
            timeoutMs: LAN_TIMEOUT_MS,
            signal,
          }),
      });
    }
    return attempts;
  }

  #onMessage(s, d) {
    if (!d || typeof d.k !== 'string') return;
    switch (d.k) {
      case 'pending':
        if (s.state !== 'requesting') return;
        s.hostName = sanitizeName(d.name, s.hostName || 'Postazione');
        if (!s.hostId && isValidId(d.id)) s.hostId = d.id;
        s.state = 'waiting';
        this.#update(s, { state: 'waiting', hostName: s.hostName, hostId: s.hostId });
        break;
      case 'accept':
        if (!BEFORE_RTC.has(s.state) || s.state === 'accepted') return;
        clearTimeout(s.timers.request);
        s.state = 'accepted';
        s.perms = d.perms || {};
        s.hostName = sanitizeName(d.name, s.hostName || 'Postazione');
        if (!s.hostId && isValidId(d.id)) s.hostId = d.id;
        s.timers.negotiation = setTimeout(() => {
          if (s.state === 'accepted') this.#end(s, 'failed', 'webrtc-failed');
        }, this.timeouts.negotiationMs + 5000);
        s.timers.negotiation.unref?.();
        this.#update(s, {
          state: 'accepted',
          perms: s.perms,
          hostName: s.hostName,
          hostId: s.hostId,
          mode: s.mode,
          iceServers: s.route === 'relay' ? [...(this.link.iceServers || []), ...this.getExtraIce()] : this.getExtraIce(),
        });
        this.emit('accepted', s);
        break;
      case 'reject':
        this.#end(s, 'failed', typeof d.reason === 'string' ? d.reason : 'declined', { notify: false });
        break;
      case 'sdp':
      case 'ice':
        if (s.state === 'accepted' || s.state === 'connected') this.emit('signal', s, d);
        break;
      case 'bye':
        this.#end(s, 'closed', typeof d.reason === 'string' ? d.reason : 'host-closed', { notify: false });
        break;
      default:
        break;
    }
  }

  #update(s, patch) {
    s.ui = { ...s.ui, ...patch };
    this.emit('state', s, patch);
  }

  #end(s, state, reason, { notify = true, detail = '' } = {}) {
    if (s.state === 'closed' || s.state === 'failed') return;
    for (const t of Object.values(s.timers)) clearTimeout(t);
    if (notify && s.transport && !s.transport.closed) s.transport.send({ k: 'bye', reason });
    s.transport?.close(reason);
    s.state = state;
    s.endedAt = this.now();
    this.sessions.delete(s.sid);
    this.#update(s, { state, reason, detail });
    this.emit('closed', s, reason, detail);
  }

  // ---- API per il glue ----

  find(sid) {
    return this.sessions.get(sid) || null;
  }

  findByWindow(windowId) {
    for (const s of this.sessions.values()) if (s.windowId === windowId) return s;
    return null;
  }

  handleRelay(from, sid, data) {
    const s = this.sessions.get(sid);
    if (!s || s.route !== 'relay' || !s.transport || from !== s.target.id) return false;
    s.transport.deliver(data);
    return true;
  }

  handleRelayFail(to, sid, code) {
    const s = this.sessions.get(sid);
    if (!s || s.route !== 'relay') return false;
    if (s.state !== 'connected') this.#end(s, 'failed', code === 'offline' ? 'offline' : code || 'unreachable', { notify: false });
    return true;
  }

  signal(sid, data) {
    const s = this.sessions.get(sid);
    if (s && (s.state === 'accepted' || s.state === 'connected')) s.transport?.send(data);
  }

  rtcConnected(sid, info = {}) {
    const s = this.sessions.get(sid);
    if (!s) return;
    if (s.state === 'accepted') {
      clearTimeout(s.timers.negotiation);
      s.state = 'connected';
      s.connectedAt = this.now();
      this.emit('connected', s);
    }
    this.#update(s, { state: 'connected', connType: info.connType || s.ui.connType || '' });
  }

  rtcFailed(sid, reason = 'webrtc-failed') {
    const s = this.sessions.get(sid);
    if (s) this.#end(s, 'failed', reason);
  }

  close(sid, reason = 'viewer-closed') {
    const s = this.sessions.get(sid);
    if (s) this.#end(s, 'closed', reason);
  }

  closeAll(reason = 'viewer-closed') {
    for (const s of [...this.sessions.values()]) this.#end(s, 'closed', reason);
  }
}
