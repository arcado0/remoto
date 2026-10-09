import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HostManager } from '../../src/main/sessions/host-manager.js';
import { ViewerManager } from '../../src/main/sessions/viewer-manager.js';
import { defaultPermissions } from '../../src/shared/permissions.js';
import { transportPair, fakeEngine, fakePrompts, fakeServer, until, tick } from '../helpers/fakes.js';

const HOST = { id: '222222222', name: 'PC Remoto' };
const VIEWER = { id: '111111111', name: 'Portatile' };

function settings(overrides = {}) {
  return { allowIncoming: true, permissions: defaultPermissions(), acl: [], maxSessions: 3, ...overrides };
}

function makeHost(st, extra = {}) {
  const engine = fakeEngine();
  const prompts = fakePrompts();
  const host = new HostManager({ getSettings: () => st, getIdentity: () => HOST, engine, prompts, ...extra });
  return { host, engine, prompts };
}

/** Viewer che si collega in "diretta" a un HostManager tramite una coppia di trasporti finti. */
function makeViewer(host, { link = { online: false, iceServers: [] }, address = '10.0.0.9' } = {}) {
  const pairs = [];
  const viewer = new ViewerManager({
    getIdentity: () => VIEWER,
    link,
    discovery: null,
    connectDirect: async ({ sid }) => {
      const [v, h] = transportPair({ sid, aPeer: VIEWER.id, bPeer: HOST.id });
      h.address = address;
      pairs.push([v, h]);
      host.addTransport(h);
      return { transport: v, peer: { id: HOST.id, name: HOST.name } };
    },
  });
  const states = [];
  viewer.on('state', (s, patch) => states.push(patch));
  return { viewer, states, pairs };
}

const target = { kind: 'address', host: '10.0.0.9', port: 47801 };

test('richiesta accettata da chi è davanti al PC: accept, engine, segnalazione, sessione attiva', async () => {
  const { host, engine, prompts } = makeHost(settings());
  const { viewer, states } = makeViewer(host);
  const s = viewer.connect({ target, mode: 'desktop' });
  await until(() => prompts.opened.length === 1);
  const req = prompts.opened[0].request;
  assert.equal(req.viewerName, 'Portatile');
  assert.equal(req.verified, false);
  await until(() => states.some((p) => p.state === 'waiting'));
  assert.equal('password' in states.find((p) => p.state === 'waiting'), false);

  prompts.opened[0].answer({ accepted: true, perms: { ...defaultPermissions(), files: false } });
  await until(() => states.some((p) => p.state === 'accepted'));
  const acc = states.find((p) => p.state === 'accepted');
  assert.equal(acc.perms.files, false);
  assert.equal(acc.hostName, 'PC Remoto');
  assert.deepEqual(acc.iceServers, []);
  const start = engine.last('start');
  assert.ok(start);
  assert.equal(start[1].perms.files, false);

  const signals = [];
  viewer.on('signal', (_s, d) => signals.push(d));
  host.engineSignal(start[1].id, { k: 'sdp', sdp: { type: 'offer', sdp: 'x' } });
  await until(() => signals.length === 1);
  viewer.signal(s.sid, { k: 'sdp', sdp: { type: 'answer', sdp: 'y' } });
  await until(() => engine.last('signal'));
  assert.equal(engine.last('signal')[2].sdp.type, 'answer');

  host.engineConnected(start[1].id, { connType: 'lan' });
  assert.equal(host.list()[0].state, 'active');
  viewer.rtcConnected(s.sid, { connType: 'lan' });
  assert.equal(viewer.find(s.sid).state, 'connected');

  viewer.close(s.sid);
  await until(() => engine.last('stop'));
  assert.equal(host.list().length, 0);
});

test('richiesta rifiutata dall’utente remoto', async () => {
  const { host, prompts } = makeHost(settings());
  const { viewer, states } = makeViewer(host);
  viewer.connect({ target });
  await until(() => prompts.opened.length === 1);
  prompts.opened[0].answer({ accepted: false });
  await until(() => states.some((p) => p.state === 'failed'));
  assert.equal(states.at(-1).reason, 'declined');
});

test('nessun accesso senza conferma: un messaggio "auth" viene ignorato', async () => {
  const { host, engine, prompts } = makeHost(settings());
  const { viewer, states, pairs } = makeViewer(host);
  viewer.connect({ target });
  await until(() => prompts.opened.length === 1);
  // un client modificato prova a entrare con una "prova" di password
  pairs[0][0].send({ k: 'auth', proof: 'AAAA' });
  pairs[0][0].send({ k: 'accept' });
  await tick(30);
  assert.equal(engine.last('start'), undefined);
  assert.equal(host.list()[0].state, 'pending');
  assert.ok(!states.some((p) => p.state === 'accepted'));
});

test('regole di accesso: disabilitato, ACL, numero massimo di sessioni', async () => {
  const cases = [
    [settings({ allowIncoming: false }), 'disabled'],
    [settings({ acl: ['999999999'] }), 'acl'],
    [settings({ maxSessions: 0 }), 'busy'],
  ];
  for (const [st, reason] of cases) {
    const { host } = makeHost(st);
    const { viewer, states } = makeViewer(host);
    viewer.connect({ target });
    await until(() => states.some((p) => p.state === 'failed'));
    assert.equal(states.at(-1).reason, reason);
  }
});

test('richieste a raffica: limite per mittente e per finestre aperte', async () => {
  const { host, prompts } = makeHost(settings(), { requestsPerMinute: 2, maxPending: 5 });
  const results = [];
  for (let i = 0; i < 3; i++) {
    const { viewer, states } = makeViewer(host);
    viewer.connect({ target });
    results.push(states);
  }
  await until(() => results[2].some((p) => p.state === 'failed'));
  assert.equal(results[2].at(-1).reason, 'rate-limited');
  assert.equal(prompts.opened.length, 2);

  // un altro mittente (indirizzo diverso) non è penalizzato, ma le finestre aperte hanno un tetto
  const { host: h2, prompts: p2 } = makeHost(settings(), { requestsPerMinute: 10, maxPending: 1 });
  const a = makeViewer(h2, { address: '10.0.0.1' });
  const b = makeViewer(h2, { address: '10.0.0.2' });
  a.viewer.connect({ target });
  await until(() => p2.opened.length === 1);
  b.viewer.connect({ target });
  await until(() => b.states.some((p) => p.state === 'failed'));
  assert.equal(b.states.at(-1).reason, 'rate-limited');
});

test('timeout: richiesta senza risposta e negoziazione WebRTC che non parte', async () => {
  const timeouts = { pendingMs: 60, promptMs: 60, negotiationMs: 60, directHelloMs: 60 };
  const { host, prompts, engine } = makeHost(settings(), { timeouts });
  const { viewer, states } = makeViewer(host);
  viewer.connect({ target });
  await until(() => states.some((p) => p.state === 'failed'));
  assert.equal(states.at(-1).reason, 'timeout');
  assert.equal(prompts.opened[0].closed, true);

  const v2 = makeViewer(host);
  v2.viewer.connect({ target });
  await until(() => prompts.opened.length === 2);
  prompts.opened[1].answer({ accepted: true, perms: defaultPermissions() });
  await until(() => engine.last('stop'), 1000);
  assert.equal(host.list().length, 0);
});

test('permessi modificati al volo; in modalità file niente controllo', async () => {
  const { host, engine, prompts } = makeHost(settings());
  const { viewer, states } = makeViewer(host);
  viewer.connect({ target, mode: 'files' });
  await until(() => prompts.opened.length === 1);
  assert.equal(prompts.opened[0].request.mode, 'files');
  assert.equal(prompts.opened[0].request.perms.control, false);
  prompts.opened[0].answer({ accepted: true, perms: defaultPermissions() });
  await until(() => states.some((p) => p.state === 'accepted'));
  const id = engine.last('start')[1].id;
  assert.equal(engine.last('start')[1].perms.control, false);
  const updated = host.setPermissions(id, { files: false, control: true });
  assert.equal(updated.files, false);
  assert.equal(updated.control, false);
  assert.deepEqual(engine.last('perms')[2], updated);
});

test('verso sé stessi e senza server né LAN la connessione fallisce subito', async () => {
  const { host } = makeHost(settings());
  const { viewer, states } = makeViewer(host);
  viewer.connect({ target: { kind: 'id', id: VIEWER.id } });
  await until(() => states.some((p) => p.state === 'failed'));
  assert.equal(states.at(-1).reason, 'self');
  states.length = 0;
  viewer.connect({ target: { kind: 'id', id: '333333333' } });
  await until(() => states.some((p) => p.state === 'failed'));
  assert.equal(states.at(-1).reason, 'no-server');
});

test('via server: mittente autenticato, offline, segnalazione instradata per sid', async () => {
  const srv = fakeServer();
  const hostLink = srv.link(HOST.id);
  const viewerLink = srv.link(VIEWER.id);
  const { host, prompts, engine } = makeHost(settings());
  hostLink.on('relay', ({ from, sid, data }) => host.handleRelay(hostLink, from, sid, data));
  const viewer = new ViewerManager({ getIdentity: () => VIEWER, link: viewerLink, connectDirect: null });
  viewerLink.on('relay', ({ from, sid, data }) => viewer.handleRelay(from, sid, data));
  viewerLink.on('relay-fail', ({ to, sid, code }) => viewer.handleRelayFail(to, sid, code));
  const states = [];
  viewer.on('state', (_s, p) => states.push(p));

  viewer.connect({ target: { kind: 'id', id: HOST.id } });
  await until(() => prompts.opened.length === 1);
  assert.equal(prompts.opened[0].request.verified, true);
  assert.equal(prompts.opened[0].request.viewerId, VIEWER.id);
  prompts.opened[0].answer({ accepted: true, perms: defaultPermissions() });
  await until(() => states.some((p) => p.state === 'accepted'));
  assert.deepEqual(states.find((p) => p.state === 'accepted').iceServers, [{ urls: ['stun:stun.test:3478'] }]);
  assert.ok(engine.last('start'));

  // un estraneo che conosce il sid non può iniettare messaggi nella sessione
  const intruder = srv.link('999999999');
  intruder.relay(HOST.id, [...host.sessions.values()][0].sid, { k: 'bye' });
  await tick(20);
  assert.equal(host.list().length, 1);

  states.length = 0;
  viewer.connect({ target: { kind: 'id', id: '444444444' } });
  await until(() => states.some((p) => p.state === 'failed'));
  assert.equal(states.at(-1).reason, 'offline');
});

test('postazione trovata in LAN con più indirizzi: si provano tutti insieme', async () => {
  const { host, prompts } = makeHost(settings());
  const tried = [];
  const viewer = new ViewerManager({
    getIdentity: () => VIEWER,
    link: { online: false, iceServers: [] },
    discovery: { find: (id) => (id === HOST.id ? { addresses: ['172.22.128.1', '192.168.1.14'], address: '172.22.128.1', port: 47801 } : null) },
    connectDirect: async ({ host: addr, sid }) => {
      tried.push(addr);
      if (addr !== '192.168.1.14') throw Object.assign(new Error('irraggiungibile'), { code: 'unreachable' });
      const [v, h] = transportPair({ sid, aPeer: VIEWER.id, bPeer: HOST.id });
      host.addTransport(h);
      return { transport: v, peer: { id: HOST.id, name: HOST.name } };
    },
  });
  viewer.connect({ target: { kind: 'id', id: HOST.id } });
  await until(() => prompts.opened.length === 1);
  assert.deepEqual(tried, ['172.22.128.1', '192.168.1.14']);
});

test('firewall dell’altro PC che blocca il TCP: la richiesta passa dalla segnalazione UDP', async () => {
  const { host, prompts } = makeHost(settings());
  const udpCalls = [];
  const viewer = new ViewerManager({
    getIdentity: () => VIEWER,
    link: { online: false, iceServers: [] },
    discovery: { find: (id) => (id === HOST.id ? { addresses: ['192.168.1.14'], address: '192.168.1.14', port: 47801, uport: 47802 } : null) },
    connectDirect: async () => {
      throw Object.assign(new Error('Tempo scaduto'), { code: 'unreachable' });
    },
    connectUdp: async ({ targets, sid, expectId }) => {
      udpCalls.push({ targets, expectId });
      const [v, h] = transportPair({ sid, aPeer: VIEWER.id, bPeer: HOST.id });
      host.addTransport(h);
      return { transport: v, peer: { id: HOST.id, name: HOST.name } };
    },
  });
  const s = viewer.connect({ target: { kind: 'id', id: HOST.id } });
  await until(() => prompts.opened.length === 1);
  assert.deepEqual(udpCalls, [{ targets: [{ host: '192.168.1.14', port: 47802 }], expectId: HOST.id }]);
  assert.equal(s.route, 'direct');
  assert.match(s.via, /^udp /);
});

test('visibile in LAN ma nessuna strada risponde: motivo "lan-blocked" con il dettaglio dei tentativi', async () => {
  const states = [];
  const viewer = new ViewerManager({
    getIdentity: () => VIEWER,
    link: { online: false, iceServers: [] },
    discovery: { find: () => ({ addresses: ['192.168.1.14'], address: '192.168.1.14', port: 47801, uport: 47802 }) },
    connectDirect: async () => {
      throw Object.assign(new Error('Tempo scaduto'), { code: 'unreachable' });
    },
    connectUdp: async () => {
      throw Object.assign(new Error('Nessuna risposta (UDP)'), { code: 'unreachable' });
    },
  });
  viewer.on('state', (_s, patch) => states.push(patch));
  viewer.connect({ target: { kind: 'id', id: HOST.id } });
  await until(() => states.some((p) => p.state === 'failed'));
  const end = states.find((p) => p.state === 'failed');
  assert.equal(end.reason, 'lan-blocked');
  assert.match(end.detail, /tcp 192\.168\.1\.14:47801: Tempo scaduto/);
  assert.match(end.detail, /udp 192\.168\.1\.14:47802: Nessuna risposta/);
});

test('connessione troncata (rete, firewall, antivirus): "connessione interrotta" con il codice, sui due lati', async () => {
  const { host, prompts } = makeHost(settings());
  const log = [];
  host.on('log', (e) => log.push(e));
  const { viewer, states, pairs } = makeViewer(host);
  viewer.connect({ target });
  await until(() => prompts.opened.length === 1);
  pairs[0][1].close('socket-closed:1006');
  await until(() => states.some((p) => p.state === 'failed'));
  const end = states.find((p) => p.state === 'failed');
  assert.equal(end.reason, 'connection-lost');
  assert.equal(end.detail, 'socket-closed:1006');
  const entry = log.find((e) => e.event === 'rejected');
  assert.equal(entry.reason, 'connection-lost');
  assert.equal(entry.detail, 'socket-closed:1006');
  assert.equal(prompts.opened[0].closed, true);
});
