// Sessioni in arrivo (questa postazione viene controllata).
// Ogni connessione va accettata da chi è davanti al PC: non esiste accesso non presidiato.
// Stati: new → pending (finestra di conferma) → connecting (WebRTC) → active → closed.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { SlidingWindowCounter } from '../../shared/ratelimit.js';
import { PROTOCOL_VERSION, TIMEOUTS, sanitizeName } from '../../shared/protocol.js';
import { sanitizePermissions, permissionsForMode } from '../../shared/permissions.js';
import { RelayTransport } from '../net/transports.js';
import { CODECS, QUALITY_PRESETS } from '../../shared/quality.js';

/** Preferenze inviate dal viewer nella richiesta: solo valori noti. */
export function sanitizePrefs(p) {
  const prefs = p && typeof p === 'object' ? p : {};
  return {
    codec: CODECS.some((c) => c.key === prefs.codec) ? prefs.codec : 'auto',
    quality: Object.hasOwn(QUALITY_PRESETS, prefs.quality) ? prefs.quality : 'balanced',
    audio: prefs.audio !== false,
  };
}

export class HostManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {() => object} o.getSettings  { allowIncoming, permissions, acl, maxSessions }
   * @param {() => {id:string, name:string}} o.getIdentity
   * @param {object} o.engine   { start(info), signal(id, data), stop(id), setPermissions(id, perms) }
   * @param {object} o.prompts  { open(request) → { result: Promise<{accepted, perms, reason}>, close() } }
   */
  constructor({ getSettings, getIdentity, engine, prompts, now = Date.now, timeouts = TIMEOUTS, requestsPerMinute = 6, maxPending = 3 }) {
    super();
    this.getSettings = getSettings;
    this.getIdentity = getIdentity;
    this.engine = engine;
    this.prompts = prompts;
    this.now = now;
    this.timeouts = timeouts;
    this.maxPending = maxPending;
    this.sessions = new Map(); // chiave trasporto → sessione
    this.byId = new Map(); // id interno → sessione
    // contro le richieste a raffica: chi insiste non riempie lo schermo di finestre
    this.requestLimiter = new SlidingWindowCounter({ windowMs: 60_000, limit: requestsPerMinute, now });
  }

  /** Messaggio inoltrato dal server: nuova richiesta oppure parte di una sessione esistente. */
  handleRelay(link, from, sid, data) {
    const key = `relay:${from}:${sid}`;
    const s = this.sessions.get(key);
    if (s) {
      s.transport.deliver(data);
      return true;
    }
    if (data?.k !== 'req') return false;
    const t = new RelayTransport(link, from, sid);
    this.addTransport(t, key);
    t.deliver(data);
    return true;
  }

  /** Il server non riesce a consegnare al viewer (offline): la sessione non può proseguire. */
  handleRelayFail(to, sid) {
    const s = this.sessions.get(`relay:${to}:${sid}`);
    if (s && s.state !== 'active') this.#close(s, 'viewer-closed', { notify: false });
  }

  addTransport(transport, key = `direct:${crypto.randomUUID()}`) {
    const s = {
      key,
      id: crypto.randomBytes(8).toString('hex'),
      sid: transport.sid,
      transport,
      kind: transport.kind,
      viewerId: transport.peerId,
      verified: transport.verified,
      address: transport.address,
      viewerName: 'Sconosciuto',
      mode: 'desktop',
      state: 'new',
      perms: null,
      createdAt: this.now(),
      acceptedAt: 0,
      connectedAt: 0,
      connType: '',
      timers: {},
    };
    this.sessions.set(key, s);
    this.byId.set(s.id, s);
    transport.on('message', (data) => this.#onMessage(s, data));
    transport.on('close', (why) => this.#onTransportClosed(s, why));
    s.timers.pending = setTimeout(() => {
      if (s.state === 'new' || s.state === 'pending') this.#close(s, 'timeout');
    }, this.timeouts.pendingMs);
    s.timers.pending.unref?.();
    return s;
  }

  #send(s, data) {
    return s.transport.send(data);
  }

  #sourceKey(s) {
    return s.verified && s.viewerId ? `id:${s.viewerId}` : `ip:${s.address || '?'}`;
  }

  #onMessage(s, data) {
    if (!data || typeof data.k !== 'string') return;
    switch (data.k) {
      case 'req':
        if (s.state === 'new') this.#onRequest(s, data);
        break;
      case 'sdp':
      case 'ice':
        if (s.state === 'connecting' || s.state === 'active') this.engine.signal(s.id, data);
        break;
      case 'bye':
        this.#close(s, 'viewer-closed', { notify: false });
        break;
      default:
        // qualunque altro messaggio (ad esempio un tentativo di autenticazione) viene ignorato:
        // l'unico modo di entrare è che qualcuno accetti la richiesta su questo PC
        break;
    }
  }

  #pendingCount() {
    let n = 0;
    for (const s of this.sessions.values()) if (s.state === 'pending') n++;
    return n;
  }

  #onRequest(s, data) {
    const st = this.getSettings();
    const me = this.getIdentity();
    s.viewerName = sanitizeName(data.name, 'Sconosciuto');
    s.mode = data.mode === 'files' ? 'files' : 'desktop';
    // indirizzi IPv4 dichiarati da chi si collega: servono solo a capire se è nella stessa LAN
    s.viewerAddrs = Array.isArray(data.addrs) ? data.addrs.filter((a) => typeof a === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(a)).slice(0, 8) : [];
    s.prefs = sanitizePrefs(data.prefs);
    if (data.v !== undefined && data.v !== PROTOCOL_VERSION) return this.#close(s, 'version');
    if (!st.allowIncoming) return this.#close(s, 'disabled');
    if (st.acl?.length && !(s.viewerId && st.acl.includes(s.viewerId))) return this.#close(s, 'acl');
    if (this.activeCount() >= st.maxSessions) return this.#close(s, 'busy');
    if (this.#pendingCount() >= this.maxPending || !this.requestLimiter.hit(this.#sourceKey(s))) return this.#close(s, 'rate-limited');

    s.state = 'pending';
    this.#send(s, { k: 'pending', id: me.id, name: me.name, prompt: true });
    s.prompt = this.prompts.open({
      id: s.id,
      viewerId: s.viewerId,
      viewerName: s.viewerName,
      verified: s.verified,
      address: s.address,
      kind: s.kind,
      mode: s.mode,
      perms: permissionsForMode(sanitizePermissions(st.permissions), s.mode),
    });
    s.prompt.result.then(
      (r) => {
        if (s.state !== 'pending') return;
        if (r?.accepted) this.#accept(s, r.perms);
        else this.#close(s, r?.reason || 'declined');
      },
      () => {
        if (s.state === 'pending') this.#close(s, 'error');
      },
    );
    this.emit('log', { ts: this.now(), event: 'request', ...this.#who(s) });
    this.#changed();
  }

  #accept(s, perms) {
    const st = this.getSettings();
    const me = this.getIdentity();
    clearTimeout(s.timers.pending);
    s.prompt?.close();
    s.prompt = null;
    s.state = 'connecting';
    s.acceptedAt = this.now();
    s.perms = permissionsForMode(sanitizePermissions(perms, st.permissions), s.mode);
    this.#send(s, { k: 'accept', id: me.id, name: me.name, mode: s.mode, perms: s.perms });
    this.engine.start({ id: s.id, mode: s.mode, perms: s.perms, prefs: s.prefs, viewerId: s.viewerId, viewerName: s.viewerName, kind: s.kind, viewerAddrs: s.viewerAddrs || [] });
    s.timers.negotiation = setTimeout(() => {
      if (s.state === 'connecting') this.#close(s, 'webrtc-failed');
    }, this.timeouts.negotiationMs);
    s.timers.negotiation.unref?.();
    this.emit('log', { ts: this.now(), event: 'accepted', ...this.#who(s) });
    this.#changed();
  }

  #onTransportClosed(s, why = '') {
    // una sessione già attiva prosegue in P2P anche senza il canale di segnalazione
    if (s.state === 'active') {
      s.transportLost = true;
      return;
    }
    // senza un "bye" dell'altra app la connessione è stata interrotta da qualcos'altro
    this.#close(s, 'connection-lost', { notify: false, detail: why });
  }

  #close(s, reason, { notify = true, detail = '' } = {}) {
    if (s.state === 'closed') return;
    const prev = s.state;
    s.state = 'closed';
    s.endedAt = this.now();
    for (const t of Object.values(s.timers)) clearTimeout(t);
    s.prompt?.close();
    s.prompt = null;
    if (notify && !s.transport.closed) this.#send(s, prev === 'new' || prev === 'pending' ? { k: 'reject', reason } : { k: 'bye', reason });
    s.transport.close(reason);
    if (prev === 'connecting' || prev === 'active') this.engine.stop(s.id);
    this.sessions.delete(s.key);
    this.byId.delete(s.id);
    const durationMs = s.connectedAt ? s.endedAt - s.connectedAt : 0;
    this.emit('log', { ts: this.now(), event: prev === 'active' || prev === 'connecting' ? 'ended' : 'rejected', reason, detail: detail || undefined, durationMs, ...this.#who(s) });
    s.endReason = reason;
    s.endDetail = detail;
    s.wasPending = prev === 'pending';
    this.emit('ended', s, reason);
    this.#changed();
  }

  #who(s) {
    return { viewerId: s.viewerId, viewerName: s.viewerName, verified: s.verified, address: s.address, kind: s.kind, mode: s.mode };
  }

  #changed() {
    this.emit('change', this.list());
  }

  // ---- chiamate dal glue (engine e UI) ----

  engineSignal(id, data) {
    const s = this.byId.get(id);
    if (s && (s.state === 'connecting' || s.state === 'active')) this.#send(s, data);
  }

  engineConnected(id, info = {}) {
    const s = this.byId.get(id);
    if (!s || s.state === 'closed') return;
    if (info.connType) s.connType = info.connType;
    if (s.state === 'connecting') {
      clearTimeout(s.timers.negotiation);
      s.state = 'active';
      s.connectedAt = this.now();
      this.emit('active', s);
    }
    this.#changed();
  }

  engineFailed(id, reason = 'webrtc-failed') {
    const s = this.byId.get(id);
    if (s) this.#close(s, reason);
  }

  setPermissions(id, perms) {
    const s = this.byId.get(id);
    if (!s || !s.perms) return null;
    s.perms = permissionsForMode(sanitizePermissions(perms, s.perms), s.mode);
    this.engine.setPermissions(s.id, s.perms);
    this.#changed();
    return s.perms;
  }

  disconnect(id, reason = 'host-closed') {
    const s = this.byId.get(id);
    if (s) this.#close(s, reason);
  }

  closeAll(reason = 'host-closed') {
    for (const s of [...this.sessions.values()]) this.#close(s, reason);
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  activeCount() {
    let n = 0;
    for (const s of this.sessions.values()) if (s.state === 'connecting' || s.state === 'active') n++;
    return n;
  }

  list() {
    return [...this.sessions.values()]
      .filter((s) => s.state !== 'new')
      .map((s) => ({
        id: s.id,
        viewerId: s.viewerId,
        viewerName: s.viewerName,
        verified: s.verified,
        address: s.address,
        kind: s.kind,
        mode: s.mode,
        state: s.state,
        perms: s.perms,
        connType: s.connType,
        acceptedAt: s.acceptedAt,
        connectedAt: s.connectedAt,
      }));
  }
}
