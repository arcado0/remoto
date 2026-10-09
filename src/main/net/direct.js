// Connessioni dirette in LAN: ogni postazione ascolta su una porta TCP (WebSocket) e chi si
// collega per IP o per ID trovato in rete locale parla direttamente con lei, senza server.
import { EventEmitter } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { DirectTransport } from './transports.js';
import { isValidId } from '../../shared/ids.js';
import { PROTOCOL_VERSION, LIMITS, TIMEOUTS, safeParse, sanitizeName, isValidSid } from '../../shared/protocol.js';
import { SlidingWindowCounter } from '../../shared/ratelimit.js';

export class DirectListener extends EventEmitter {
  constructor({ port, host = '0.0.0.0', getIdentity, logger = console, maxPending = 16, perIpPerMinute = 30 }) {
    super();
    this.port = port;
    this.host = host;
    this.getIdentity = getIdentity;
    this.log = logger;
    this.maxPending = maxPending;
    this.limiter = new SlidingWindowCounter({ windowMs: 60_000, limit: perIpPerMinute });
    this.wss = null;
    this.pending = 0;
    this.error = null;
  }

  get listening() {
    return Boolean(this.wss);
  }

  async start() {
    if (this.wss) return;
    const wss = new WebSocketServer({ port: this.port, host: this.host, maxPayload: LIMITS.maxDirectMessage });
    await new Promise((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    }).catch((err) => {
      this.error = err.code === 'EADDRINUSE' ? `Porta ${this.port} già in uso` : err.message;
      wss.close();
      throw err;
    });
    this.error = null;
    this.wss = wss;
    this.port = wss.address().port;
    wss.on('connection', (ws, req) => this.#onConnection(ws, req));
    wss.on('error', (err) => this.log.warn?.(`listener LAN: ${err.message}`));
  }

  async stop() {
    const wss = this.wss;
    this.wss = null;
    if (!wss) return;
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => wss.close(() => r()));
  }

  #onConnection(ws, req) {
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (!this.limiter.hit(ip) || this.pending >= this.maxPending) {
      ws.close(1013, 'rate-limited');
      return;
    }
    this.pending++;
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        this.pending--;
      }
    };
    const timer = setTimeout(() => {
      done();
      ws.close(4002, 'hello-timeout');
    }, TIMEOUTS.directHelloMs);
    ws.once('close', () => {
      clearTimeout(timer);
      done();
    });
    ws.once('message', (raw, isBinary) => {
      clearTimeout(timer);
      done();
      const msg = isBinary ? null : safeParse(raw.toString());
      if (!msg || msg.t !== 'direct-hello' || !isValidSid(msg.sid)) {
        ws.close(4003, 'hello-required');
        return;
      }
      if (msg.v !== PROTOCOL_VERSION) {
        ws.send(JSON.stringify({ t: 'error', code: 'version' }));
        ws.close(4000, 'version');
        return;
      }
      const me = this.getIdentity();
      ws.send(JSON.stringify({ t: 'direct-welcome', v: PROTOCOL_VERSION, id: me.id, name: me.name }));
      const peerId = isValidId(msg.id) ? msg.id : null;
      const transport = new DirectTransport(ws, { sid: msg.sid, peerId, address: ip });
      this.emit('incoming', transport, { peerId, peerName: sanitizeName(msg.name), address: ip });
    });
  }
}

/** Si collega a una postazione in LAN; risolve con il trasporto e i dati del peer. */
export function connectDirect({ host, port, identity, sid, timeoutMs = 8000, WebSocketImpl = WebSocket }) {
  return new Promise((resolve, reject) => {
    const h = host.includes(':') ? `[${host}]` : host;
    let ws;
    try {
      ws = new WebSocketImpl(`ws://${h}:${port}/`, { handshakeTimeout: timeoutMs, maxPayload: LIMITS.maxDirectMessage });
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      ws.terminate();
      reject(Object.assign(new Error('Tempo scaduto'), { code: 'unreachable' }));
    }, timeoutMs);
    const fail = (err) => {
      clearTimeout(timer);
      reject(Object.assign(err instanceof Error ? err : new Error(String(err)), { code: err?.code === 'version' ? 'version' : 'unreachable' }));
    };
    ws.once('error', fail);
    ws.once('open', () => {
      ws.send(JSON.stringify({ t: 'direct-hello', v: PROTOCOL_VERSION, id: identity.id, name: identity.name, sid }));
    });
    ws.once('message', (raw) => {
      clearTimeout(timer);
      const msg = safeParse(raw.toString());
      if (!msg || msg.t !== 'direct-welcome') {
        ws.terminate();
        fail(Object.assign(new Error('Risposta non valida'), { code: msg?.code === 'version' ? 'version' : 'unreachable' }));
        return;
      }
      ws.off('error', fail);
      const peerId = isValidId(msg.id) ? msg.id : null;
      const transport = new DirectTransport(ws, { sid, peerId, address: host });
      resolve({ transport, peer: { id: peerId, name: sanitizeName(msg.name) } });
    });
  });
}
