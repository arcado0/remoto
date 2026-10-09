// Connessione persistente al server ID: registrazione, inoltro della segnalazione, presenza.
// Si riconnette da sola con backoff esponenziale.
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, safeParse } from '../../shared/protocol.js';

export class ServerLink extends EventEmitter {
  /**
   * @param {object} o
   * @param {() => {id:string, secret:string, name:string}} o.getIdentity
   * @param {() => void} o.onIdTaken  chiamata quando il server rifiuta l'ID (va rigenerato)
   */
  constructor({ getIdentity, onIdTaken = () => {}, logger = console, version = '1.0.0', WebSocketImpl = WebSocket, pingMs = 20_000, minBackoffMs = 1000, maxBackoffMs = 30_000 }) {
    super();
    this.getIdentity = getIdentity;
    this.onIdTaken = onIdTaken;
    this.log = logger;
    this.version = version;
    this.WebSocketImpl = WebSocketImpl;
    this.pingMs = pingMs;
    this.minBackoffMs = minBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.url = '';
    this.ws = null;
    this.state = 'disabled';
    this.detail = '';
    this.iceServers = [];
    this.serverInfo = null;
    this.backoff = minBackoffMs;
    this.retryTimer = null;
    this.pingTimer = null;
    this.pongTimer = null;
    this.queries = new Map();
    this.rid = 0;
    this.running = false;
  }

  #setState(state, detail = '') {
    if (this.state === state && this.detail === detail) return;
    this.state = state;
    this.detail = detail;
    this.emit('state', { state, detail });
  }

  get online() {
    return this.state === 'online';
  }

  setUrl(url) {
    if (url === this.url) return;
    this.url = url || '';
    if (this.running) this.#restart();
  }

  start() {
    this.running = true;
    this.#restart();
  }

  stop() {
    this.running = false;
    this.#teardown();
    this.#setState('disabled');
  }

  /** Forza una riconnessione immediata (es. dopo un cambio di ID o di nome). */
  reconnect() {
    if (this.running) this.#restart();
  }

  #restart() {
    this.#teardown();
    this.backoff = this.minBackoffMs;
    if (!this.url) {
      this.#setState('disabled', 'Nessun server configurato');
      return;
    }
    this.#connect();
  }

  #teardown() {
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    this.retryTimer = this.pingTimer = this.pongTimer = null;
    for (const q of this.queries.values()) q.resolve({});
    this.queries.clear();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.removeAllListeners();
      ws.on('error', () => {});
      try {
        ws.terminate();
      } catch {
        /* ignorato */
      }
    }
  }

  #scheduleRetry(delay = this.backoff) {
    if (!this.running || !this.url) return;
    clearTimeout(this.retryTimer);
    const jitter = Math.round(delay * 0.2 * Math.random());
    this.retryTimer = setTimeout(() => this.#connect(), delay + jitter);
    this.backoff = Math.min(this.maxBackoffMs, this.backoff * 2);
  }

  #connect() {
    this.#teardown();
    this.#setState('connecting');
    let ws;
    try {
      ws = new this.WebSocketImpl(this.url, { handshakeTimeout: 10_000 });
    } catch (err) {
      this.#setState('error', `Indirizzo del server non valido: ${err.message}`);
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      const me = this.getIdentity();
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, id: me.id, secret: me.secret, name: me.name, ver: this.version }));
    });
    ws.on('message', (raw) => this.#onMessage(raw));
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      clearTimeout(this.pongTimer);
      if (this.state !== 'error') this.#setState('offline', reason?.toString() || `chiusa (${code})`);
      this.#scheduleRetry();
    });
    ws.on('error', (err) => {
      if (this.ws !== ws) return;
      this.log.warn?.(`server ID: ${err.message}`);
      this.#setState('offline', err.code === 'ECONNREFUSED' ? 'Server non raggiungibile' : err.message);
    });
  }

  #onMessage(raw) {
    const msg = safeParse(raw.toString());
    if (!msg) return;
    switch (msg.t) {
      case 'welcome':
        this.backoff = this.minBackoffMs;
        this.iceServers = Array.isArray(msg.iceServers) ? msg.iceServers : [];
        this.serverInfo = msg.server || null;
        this.#setState('online');
        this.#startPing();
        this.emit('welcome', msg);
        break;
      case 'error':
        this.#onError(msg);
        break;
      case 'relay':
        this.emit('relay', { from: msg.from, sid: msg.sid, data: msg.data });
        break;
      case 'relay-fail':
        this.emit('relay-fail', { to: msg.to, sid: msg.sid, code: msg.code });
        break;
      case 'query-result': {
        const q = this.queries.get(msg.rid);
        if (q) {
          clearTimeout(q.timer);
          this.queries.delete(msg.rid);
          q.resolve(msg.online || {});
        }
        break;
      }
      case 'pong':
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
        break;
      default:
        break;
    }
  }

  #onError(msg) {
    this.log.warn?.(`server ID: errore ${msg.code} ${msg.message || ''}`);
    if (msg.code === 'id-taken') {
      // l'ID appartiene a un'altra postazione: se ne genera uno nuovo e si riprova subito
      this.onIdTaken();
      this.#setState('connecting', 'ID già in uso: ne viene generato uno nuovo');
      this.backoff = this.minBackoffMs;
      return;
    }
    if (msg.code === 'replaced') {
      this.#setState('error', 'Questo ID è stato aperto su un’altra sessione di Remoto');
      this.backoff = 60_000;
      return;
    }
    if (msg.code === 'version') {
      this.#setState('error', 'Versione del server non compatibile');
      this.backoff = this.maxBackoffMs;
      return;
    }
    if (msg.code === 'rate-limited') this.backoff = this.maxBackoffMs;
    this.#setState('error', msg.message || msg.code);
  }

  #startPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== 1) return;
      this.ws.send(JSON.stringify({ t: 'ping' }));
      clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        // connessione "mezza aperta": la si butta e si riparte
        this.log.warn?.('server ID: nessun pong, riconnessione');
        const ws = this.ws;
        if (ws) ws.terminate();
      }, Math.min(10_000, this.pingMs));
    }, this.pingMs);
  }

  relay(to, sid, data) {
    if (!this.online || !this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify({ t: 'relay', to, sid, data }));
    return true;
  }

  /** Stato online di una lista di ID: { id: true|false }. Risolve {} se offline. */
  query(ids, timeoutMs = 5000) {
    if (!this.online || !ids.length) return Promise.resolve({});
    const rid = ++this.rid;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.queries.delete(rid);
        resolve({});
      }, timeoutMs);
      this.queries.set(rid, { resolve, timer });
      this.ws.send(JSON.stringify({ t: 'query', rid, ids }));
    });
  }
}
