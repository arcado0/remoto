// Server ID di Remoto: registra le postazioni, inoltra la segnalazione, risponde sulla presenza.
// Non vede mai schermo, input o file: quelli viaggiano P2P cifrati tra le postazioni.
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { WebSocketServer } from 'ws';

import { IdRegistry } from './registry.js';
import { buildIceServers } from './turn.js';
import { renderStatusPage } from './status-page.js';
import { isValidId } from '../shared/ids.js';
import { TokenBucket, SlidingWindowCounter } from '../shared/ratelimit.js';
import {
  PROTOCOL_VERSION, LIMITS, DEFAULT_PORTS, DEFAULT_STUN,
  safeParse, sanitizeName, isValidSid, isValidSecret, isPlainObject,
} from '../shared/protocol.js';

export const SERVER_VERSION = '1.0.0';

const silent = { info() {}, warn() {}, error() {} };

export function createRendezvousServer(options = {}) {
  const opts = {
    port: DEFAULT_PORTS.server,
    host: '0.0.0.0',
    dataDir: null,
    stunUrls: [...DEFAULT_STUN],
    turnUrls: [],
    turnSecret: '',
    turnTtl: 24 * 3600,
    tls: null,
    trustProxy: false,
    maxClients: 20000,
    pingIntervalMs: 30_000,
    helloTimeoutMs: 10_000,
    requestsPerMinute: 30,
    newIdsPerHour: 100,
    logger: silent,
    name: 'Remoto ID server',
    now: Date.now,
    ...options,
  };
  const log = opts.logger;
  const registry = new IdRegistry({ file: opts.dataDir ? path.join(opts.dataDir, 'registry.json') : null, now: opts.now });
  const online = new Map(); // id -> client
  const clients = new Set();
  const helloLimiter = new SlidingWindowCounter({ windowMs: 60_000, limit: 120, now: opts.now });
  const newIdLimiter = new SlidingWindowCounter({ windowMs: 3_600_000, limit: opts.newIdsPerHour, now: opts.now });
  const requestLimiter = new SlidingWindowCounter({ windowMs: 60_000, limit: opts.requestsPerMinute, now: opts.now });
  const stats = { startedAt: opts.now(), connections: 0, relayed: 0 };

  let httpServer = null;
  let wss = null;
  let pingTimer = null;
  let pruneTimer = null;
  let boundPort = null;

  function send(client, msg) {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify(msg));
  }

  function fail(client, code, message) {
    send(client, { t: 'error', code, message });
    client.ws.close(4000, code);
  }

  function clientIp(req) {
    if (opts.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'sconosciuto';
  }

  function handleHello(client, msg) {
    if (msg.v !== PROTOCOL_VERSION) return fail(client, 'version', `Protocollo ${msg.v} non supportato (serve ${PROTOCOL_VERSION})`);
    if (!isValidId(msg.id) || !isValidSecret(msg.secret)) return fail(client, 'bad-hello', 'ID o segreto non validi');
    if (!helloLimiter.hit(client.ip)) return fail(client, 'rate-limited', 'Troppe connessioni da questo indirizzo');

    const status = registry.check(msg.id, msg.secret);
    if (status === 'mismatch') return fail(client, 'id-taken', 'ID già registrato da un’altra postazione');
    if (status === 'new') {
      if (!newIdLimiter.hit(client.ip)) return fail(client, 'rate-limited', 'Troppi nuovi ID da questo indirizzo');
      registry.register(msg.id, msg.secret);
      log.info(`nuovo ID registrato ${msg.id} da ${client.ip}`);
    } else {
      registry.touch(msg.id);
    }

    const previous = online.get(msg.id);
    if (previous && previous !== client) {
      send(previous, { t: 'error', code: 'replaced', message: 'Lo stesso ID si è connesso da un’altra sessione' });
      previous.ws.close(4001, 'replaced');
      previous.id = null;
    }
    clearTimeout(client.helloTimer);
    client.id = msg.id;
    client.name = sanitizeName(msg.name);
    online.set(client.id, client);
    send(client, {
      t: 'welcome',
      id: client.id,
      iceServers: buildIceServers({ stunUrls: opts.stunUrls, turnUrls: opts.turnUrls, turnSecret: opts.turnSecret, id: client.id, ttlSec: opts.turnTtl, now: opts.now() }),
      server: { name: opts.name, version: SERVER_VERSION },
    });
    log.info(`online ${client.id} (${client.name}) da ${client.ip}`);
  }

  function handleRelay(client, msg) {
    const { to, sid, data } = msg;
    if (!isValidId(to) || !isValidSid(sid) || !isPlainObject(data)) {
      return send(client, { t: 'relay-fail', to, sid, code: 'invalid' });
    }
    if (data.k === 'req' && !requestLimiter.hit(client.id)) {
      return send(client, { t: 'relay-fail', to, sid, code: 'rate-limited' });
    }
    const target = online.get(to);
    if (!target) return send(client, { t: 'relay-fail', to, sid, code: 'offline' });
    stats.relayed++;
    send(target, { t: 'relay', from: client.id, sid, data });
  }

  function handleQuery(client, msg) {
    const ids = Array.isArray(msg.ids) ? msg.ids.slice(0, LIMITS.maxQueryIds) : [];
    const result = {};
    for (const id of ids) if (isValidId(id)) result[id] = online.has(id);
    send(client, { t: 'query-result', rid: msg.rid, online: result });
  }

  function onConnection(ws, req) {
    if (clients.size >= opts.maxClients) {
      ws.close(1013, 'server-full');
      return;
    }
    const client = {
      ws,
      ip: clientIp(req),
      id: null,
      name: '',
      alive: true,
      bucket: new TokenBucket({ capacity: 400, refillPerSec: 100, now: opts.now }),
      helloTimer: null,
    };
    clients.add(client);
    stats.connections++;
    client.helloTimer = setTimeout(() => {
      if (!client.id) ws.close(4002, 'hello-timeout');
    }, opts.helloTimeoutMs);

    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return ws.close(1003, 'binary-not-supported');
      if (!client.bucket.take()) return send(client, { t: 'error', code: 'rate-limited', message: 'Troppi messaggi' });
      const msg = safeParse(raw.toString());
      if (!msg) return;
      if (!client.id) {
        if (msg.t === 'hello') handleHello(client, msg);
        else ws.close(4003, 'hello-required');
        return;
      }
      switch (msg.t) {
        case 'relay':
          return handleRelay(client, msg);
        case 'query':
          return handleQuery(client, msg);
        case 'ping':
          return send(client, { t: 'pong' });
        default:
          return undefined;
      }
    });
    ws.on('close', () => {
      clearTimeout(client.helloTimer);
      clients.delete(client);
      if (client.id && online.get(client.id) === client) {
        online.delete(client.id);
        log.info(`offline ${client.id}`);
      }
    });
    ws.on('error', (err) => log.warn(`socket ${client.ip}: ${err.message}`));
  }

  function onHttp(req, res) {
    const url = (req.url || '/').split('?')[0];
    if (url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, name: opts.name, version: SERVER_VERSION, protocol: PROTOCOL_VERSION, online: online.size, registered: registry.size, uptimeSec: Math.round((opts.now() - stats.startedAt) / 1000) }));
      return;
    }
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
      res.end(renderStatusPage({ name: opts.name, version: SERVER_VERSION, online: online.size, registered: registry.size, relayed: stats.relayed, startedAt: stats.startedAt, turn: opts.turnUrls.length > 0 && !!opts.turnSecret }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Non trovato');
  }

  async function start() {
    httpServer = opts.tls ? https.createServer({ cert: opts.tls.cert, key: opts.tls.key }, onHttp) : http.createServer(onHttp);
    wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxServerMessage });
    httpServer.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req));
    });
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(opts.port, opts.host, () => {
        httpServer.off('error', reject);
        resolve();
      });
    });
    boundPort = httpServer.address().port;
    pingTimer = setInterval(() => {
      for (const c of clients) {
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        try {
          c.ws.ping();
        } catch {
          /* socket già chiuso */
        }
      }
    }, opts.pingIntervalMs);
    pruneTimer = setInterval(() => {
      helloLimiter.prune();
      newIdLimiter.prune();
      requestLimiter.prune();
    }, 60_000);
    pingTimer.unref?.();
    pruneTimer.unref?.();
    log.info(`${opts.name} in ascolto su ${opts.tls ? 'wss' : 'ws'}://${opts.host}:${boundPort}`);
    return { port: boundPort };
  }

  async function stop() {
    clearInterval(pingTimer);
    clearInterval(pruneTimer);
    for (const c of clients) {
      clearTimeout(c.helloTimer);
      c.ws.terminate();
    }
    clients.clear();
    online.clear();
    if (wss) await new Promise((r) => wss.close(() => r()));
    if (httpServer) {
      httpServer.closeAllConnections?.();
      await new Promise((r) => httpServer.close(() => r()));
    }
    registry.flush();
    httpServer = null;
    wss = null;
  }

  return {
    start,
    stop,
    registry,
    get port() {
      return boundPort;
    },
    get onlineCount() {
      return online.size;
    },
    isOnline: (id) => online.has(id),
  };
}
