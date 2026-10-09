// Segnalazione UDP in LAN: canale affidabile, attraversamento di un firewall che blocca le connessioni
// in entrata (simulato come quello di Windows), gara tra più strade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';

import { UdpHub } from '../../src/main/net/lan-udp.js';
import { firstConnection } from '../../src/main/net/connect.js';
import { safeParse } from '../../src/shared/protocol.js';
import { until } from '../helpers/fakes.js';

const silent = { info() {}, warn() {}, error() {} };
const A = { id: '111111111', name: 'Portatile' };
const B = { id: '222222222', name: 'PC Remoto' };
const fast = { helloMs: 30, rtoMs: 40, giveUpMs: 2000, keepaliveMs: 200, idleMs: 1500, lingerMs: 400, tickMs: 10 };

/** Un hub su un vero socket UDP di loopback. */
async function realHub(identity, timing = fast) {
  const socket = dgram.createSocket('udp4');
  await new Promise((r) => socket.bind(0, '127.0.0.1', r));
  const hub = new UdpHub({ send: (buf, port, address) => socket.send(buf, port, address), getIdentity: () => identity, logger: silent, timing });
  socket.on('message', (buf, rinfo) => hub.handle(safeParse(buf.toString()), rinfo));
  return { hub, socket, port: socket.address().port, close: () => socket.close() };
}

test('UDP: saluto, messaggi nei due sensi in ordine, chiusura avvisata', async () => {
  const a = await realHub(A);
  const b = await realHub(B);
  const incoming = new Promise((r) => b.hub.once('incoming', (t, meta) => r({ t, meta })));
  const { transport, peer } = await a.hub.connect({ targets: [{ host: '127.0.0.1', port: b.port }], identity: A, sid: 'sessione-udp-0001', expectId: B.id });
  assert.deepEqual(peer, { id: B.id, name: B.name });
  const { t: hostSide, meta } = await incoming;
  assert.equal(meta.peerId, A.id);
  assert.equal(hostSide.kind, 'direct');
  assert.equal(hostSide.via, 'udp');

  const got = [];
  hostSide.on('message', (d) => got.push(d));
  for (let i = 0; i < 20; i++) transport.send({ k: 'ice', i });
  await until(() => got.length === 20, 3000);
  assert.deepEqual(got.map((d) => d.i), [...Array(20).keys()]);

  const back = new Promise((r) => transport.once('message', r));
  hostSide.send({ k: 'pending', big: 'x'.repeat(8000) }); // come un SDP: più grande di un pacchetto Ethernet
  assert.equal((await back).big.length, 8000);

  const closed = new Promise((r) => hostSide.once('close', r));
  transport.close('viewer-closed');
  assert.match(await closed, /^udp-closed:/);
  a.close();
  b.close();
});

test('UDP: postazione che non risponde o di versione diversa', async () => {
  const a = await realHub(A);
  const silentPeer = dgram.createSocket('udp4');
  await new Promise((r) => silentPeer.bind(0, '127.0.0.1', r));
  await assert.rejects(
    a.hub.connect({ targets: [{ host: '127.0.0.1', port: silentPeer.address().port }], identity: A, sid: 'sessione-udp-0002', timeoutMs: 300 }),
    (err) => err.code === 'unreachable',
  );
  silentPeer.on('message', (buf, rinfo) => {
    const m = JSON.parse(buf.toString());
    silentPeer.send(Buffer.from(JSON.stringify({ app: 'remoto', u: 'no', sid: m.sid, code: 'version' })), rinfo.port, rinfo.address);
  });
  await assert.rejects(
    a.hub.connect({ targets: [{ host: '127.0.0.1', port: silentPeer.address().port }], identity: A, sid: 'sessione-udp-0003', timeoutMs: 1000 }),
    (err) => err.code === 'version',
  );
  silentPeer.close();
  a.close();
});

/**
 * Rete simulata con il firewall di Windows sul PC controllato (B): un datagramma in arrivo passa solo
 * se B ha già inviato a quel mittente (traffico di ritorno) oppure entro 3 s da un broadcast di B
 * partito dalla stessa porta (risposta unicast a un broadcast). Più una perdita casuale di pacchetti.
 */
function simulatedLan({ loss = 0, firewallOnB = true, bBroadcasts = true } = {}) {
  const hubs = new Map(); // indirizzo → { hub, port }
  const flowsB = new Set(); // destinazioni a cui B ha inviato
  let lastBroadcastB = -Infinity;
  let dropped = 0;
  let rnd = 12345;
  const random = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
  const PORT = 47802;
  const deliver = (from, buf, port, to) => {
    if (random() < loss) return dropped++;
    if (to === '10.0.0.2' && firewallOnB) {
      const solicited = flowsB.has(`${from}:${PORT}`) || (bBroadcasts && Date.now() - lastBroadcastB < 3000);
      if (!solicited) return dropped++;
    }
    const dest = hubs.get(to);
    if (dest && port === PORT) setImmediate(() => dest.hub.handle(JSON.parse(buf.toString()), { address: from, port: PORT }));
    return undefined;
  };
  const add = (address, identity) => {
    const hub = new UdpHub({
      send: (buf, port, to) => {
        if (address === '10.0.0.2') flowsB.add(`${to}:${port}`);
        deliver(address, buf, port, to);
      },
      getIdentity: () => identity,
      logger: silent,
      timing: fast,
    });
    hubs.set(address, { hub });
    return hub;
  };
  const a = add('10.0.0.1', A);
  const b = add('10.0.0.2', B);
  // B annuncia la sua presenza come fa Discovery (ogni 2,5 s)
  const announce = () => {
    if (bBroadcasts) lastBroadcastB = Date.now();
  };
  announce();
  const timer = setInterval(announce, 2500);
  return { a, b, stop: () => clearInterval(timer), dropped: () => dropped };
}

test('firewall di Windows che blocca B: la segnalazione UDP passa grazie ai suoi broadcast', async () => {
  const net = simulatedLan({ firewallOnB: true });
  const incoming = new Promise((r) => net.b.once('incoming', (t) => r(t)));
  const { transport } = await net.a.connect({ targets: [{ host: '10.0.0.2', port: 47802 }], identity: A, sid: 'sessione-fw-00001', timeoutMs: 3000 });
  const hostSide = await incoming;
  const got = new Promise((r) => hostSide.once('message', r));
  transport.send({ k: 'req', name: A.name });
  assert.deepEqual(await got, { k: 'req', name: A.name });
  // da qui in poi B ha già risposto: il traffico passa anche quando la finestra del broadcast scade
  const reply = new Promise((r) => transport.once('message', r));
  hostSide.send({ k: 'pending' });
  assert.deepEqual(await reply, { k: 'pending' });
  transport.close('fine');
  net.stop();
});

test('senza broadcast di B il firewall ferma tutto (la finestra dei 3 s è ciò che fa passare)', async () => {
  const net = simulatedLan({ firewallOnB: true, bBroadcasts: false });
  await assert.rejects(net.a.connect({ targets: [{ host: '10.0.0.2', port: 47802 }], identity: A, sid: 'sessione-fw-00002', timeoutMs: 400 }), (err) => err.code === 'unreachable');
  assert.ok(net.dropped() > 0);
  net.stop();
});

test('rete con il 30% di pacchetti persi: tutti i messaggi arrivano, in ordine', async () => {
  const net = simulatedLan({ loss: 0.3, firewallOnB: true });
  const incoming = new Promise((r) => net.b.once('incoming', (t) => r(t)));
  const { transport } = await net.a.connect({ targets: [{ host: '10.0.0.2', port: 47802 }], identity: A, sid: 'sessione-loss-0001', timeoutMs: 4000 });
  const hostSide = await incoming;
  const got = [];
  const back = [];
  hostSide.on('message', (d) => got.push(d.i));
  transport.on('message', (d) => back.push(d.i));
  for (let i = 0; i < 40; i++) {
    transport.send({ k: 'ice', i });
    hostSide.send({ k: 'ice', i });
  }
  await until(() => got.length === 40 && back.length === 40, 8000);
  assert.deepEqual(got, [...Array(40).keys()]);
  assert.deepEqual(back, [...Array(40).keys()]);
  assert.ok(net.dropped() > 10, 'la simulazione deve aver perso pacchetti');
  // il "reject" inviato appena prima di chiudere arriva comunque (la chiusura aspetta le conferme)
  const last = new Promise((r) => transport.once('message', r));
  hostSide.send({ k: 'reject', reason: 'declined' });
  hostSide.close('declined');
  assert.deepEqual(await last, { k: 'reject', reason: 'declined' });
  net.stop();
});

test('firstConnection: vince la prima strada, le altre si chiudono; il ritardo si salta se le altre falliscono', async () => {
  const closed = [];
  const fake = (label, ms, ok = true) => ({
    label,
    start: () =>
      new Promise((resolve, reject) =>
        setTimeout(() => (ok ? resolve({ transport: { close: (why) => closed.push([label, why]) }, peer: { id: B.id } }) : reject(Object.assign(new Error('no'), { code: 'unreachable' }))), ms),
      ),
  });
  const r1 = await firstConnection([fake('lento', 80), fake('veloce', 10)]);
  assert.equal(r1.via, 'veloce');
  await until(() => closed.length === 1);
  assert.deepEqual(closed[0], ['lento', 'superseded']);

  // il TCP fallisce subito: l'UDP (ritardato di 1 s) parte senza aspettare
  const t0 = Date.now();
  const r2 = await firstConnection([fake('tcp', 5, false), { ...fake('udp', 5), delayMs: 1000 }]);
  assert.equal(r2.via, 'udp');
  assert.ok(Date.now() - t0 < 500);

  await assert.rejects(firstConnection([fake('a', 5, false), fake('b', 5, false)]), (err) => err.code === 'unreachable' && /a: no/.test(err.detail));
  await assert.rejects(firstConnection([fake('x', 5)], { accept: () => false }), (err) => err.code === 'unreachable');
});
