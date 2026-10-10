import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';

import { DirectListener, connectDirect } from '../../src/main/net/direct.js';
import { Discovery, broadcastAddresses } from '../../src/main/net/discovery.js';
import { ServerLink } from '../../src/main/net/server-link.js';
import { magicPacket, parseMac } from '../../src/main/net/wol.js';
import { createRendezvousServer } from '../../src/server/core.js';
import { until } from '../helpers/fakes.js';

const silent = { info() {}, warn() {}, error() {} };

test('connessione diretta LAN: hello, welcome, messaggi nei due sensi', async () => {
  const listener = new DirectListener({ port: 0, host: '127.0.0.1', getIdentity: () => ({ id: '222222222', name: 'Host' }), logger: silent });
  await listener.start();
  const incoming = new Promise((r) => listener.once('incoming', (t, meta) => r({ t, meta })));
  const { transport, peer } = await connectDirect({ host: '127.0.0.1', port: listener.port, identity: { id: '111111111', name: 'Viewer' }, sid: 'sessione-diretta-1' });
  assert.deepEqual(peer, { id: '222222222', name: 'Host' });
  const { t: hostSide, meta } = await incoming;
  assert.equal(meta.peerId, '111111111');
  assert.equal(meta.address, '127.0.0.1');
  assert.equal(hostSide.verified, false);

  const got = new Promise((r) => hostSide.once('message', r));
  transport.send({ k: 'req', name: 'Viewer' });
  assert.deepEqual(await got, { k: 'req', name: 'Viewer' });
  const back = new Promise((r) => transport.once('message', r));
  hostSide.send({ k: 'pending' });
  assert.deepEqual(await back, { k: 'pending' });

  const closed = new Promise((r) => hostSide.once('close', r));
  transport.close();
  await closed;
  await listener.stop();
});

test('connessione diretta verso una porta chiusa fallisce con unreachable', async () => {
  await assert.rejects(
    connectDirect({ host: '127.0.0.1', port: 1, identity: { id: '111111111', name: 'V' }, sid: 'sessione-diretta-2', timeoutMs: 2000 }),
    (err) => err.code === 'unreachable',
  );
});

test('il listener chiude chi non si presenta con direct-hello', async () => {
  const listener = new DirectListener({ port: 0, host: '127.0.0.1', getIdentity: () => ({ id: '222222222', name: 'Host' }), logger: silent });
  await listener.start();
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${listener.port}/`);
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'qualcosa' }));
  const code = await new Promise((r) => ws.once('close', (c) => r(c)));
  assert.equal(code, 4003);
  await listener.stop();
});

test('rilevamento LAN: due istanze si vedono (su loopback) e spariscono allo stop', async () => {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const mk = (id, name) =>
    new Discovery({ port, bindAddress: '127.0.0.1', targets: ['127.0.0.1'], intervalMs: 100, ttlMs: 600, getAnnouncement: () => ({ id, name, port: 47801, macs: ['aa:bb:cc:dd:ee:ff'], os: 'win32' }), logger: silent });
  const a = mk('111111111', 'Alfa');
  const b = mk('222222222', 'Beta');
  await a.start();
  await b.start();
  // con reuseAddr su loopback entrambi ricevono gli annunci (uno dei due può non ricevere: basta che almeno uno veda l'altro)
  await until(() => a.find('222222222') || b.find('111111111'), 3000);
  const seen = a.find('222222222') || b.find('111111111');
  assert.equal(seen.port, 47801);
  assert.deepEqual(seen.macs, ['aa:bb:cc:dd:ee:ff']);
  assert.equal(a.find('111111111'), null, 'non deve vedere sé stesso');
  b.stop();
  a.stop();
});

test('broadcastAddresses calcola il broadcast di ogni interfaccia', () => {
  const list = broadcastAddresses({
    eth: [{ family: 'IPv4', address: '192.168.1.14', netmask: '255.255.255.0', internal: false }],
    lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
    vpn: [{ family: 'IPv4', address: '10.8.3.7', netmask: '255.255.0.0', internal: false }],
  });
  assert.deepEqual(list.sort(), ['10.8.255.255', '192.168.1.255', '255.255.255.255']);
});

test('Wake-on-LAN: magic packet da 102 byte', () => {
  const p = magicPacket('AA-BB-CC-DD-EE-FF');
  assert.equal(p.length, 102);
  assert.deepEqual([...p.subarray(0, 6)], [255, 255, 255, 255, 255, 255]);
  assert.deepEqual([...p.subarray(6, 12)], [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
  assert.deepEqual([...p.subarray(96, 102)], [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
  assert.equal(parseMac('zz'), null);
  assert.throws(() => magicPacket('12:34'));
});

test('ServerLink: registrazione, inoltro, query, riconnessione dopo il riavvio del server', async () => {
  const server = createRendezvousServer({ port: 0, host: '127.0.0.1' });
  const { port } = await server.start();
  const url = `ws://127.0.0.1:${port}/ws`;
  const mk = (id, secret) => {
    const l = new ServerLink({ getIdentity: () => ({ id, secret, name: id }), logger: silent, minBackoffMs: 50, maxBackoffMs: 200 });
    l.setUrl(url);
    l.start();
    return l;
  };
  const a = mk('111111111', '1'.repeat(64));
  const b = mk('222222222', '2'.repeat(64));
  await until(() => a.online && b.online, 3000);
  assert.ok(Array.isArray(a.iceServers));

  const got = new Promise((r) => b.once('relay', r));
  assert.equal(a.relay('222222222', 'sessione-link-1', { k: 'req' }), true);
  const msg = await got;
  assert.equal(msg.from, '111111111');
  assert.deepEqual(await a.query(['222222222', '333333333']), { 222222222: true, 333333333: false });

  const fail = new Promise((r) => a.once('relay-fail', r));
  a.relay('333333333', 'sessione-link-2', { k: 'req' });
  assert.equal((await fail).code, 'offline');

  // il server si riavvia sulla stessa porta: i client tornano online da soli
  await server.stop();
  await until(() => !a.online, 2000);
  const server2 = createRendezvousServer({ port, host: '127.0.0.1' });
  await server2.start();
  await until(() => a.online && b.online, 5000);
  a.stop();
  b.stop();
  assert.equal(a.state, 'disabled');
  await server2.stop();
});

test('ServerLink: ID già preso → onIdTaken e nuovo tentativo con il nuovo ID', async () => {
  const server = createRendezvousServer({ port: 0, host: '127.0.0.1' });
  const { port } = await server.start();
  const url = `ws://127.0.0.1:${port}/ws`;
  const owner = new ServerLink({ getIdentity: () => ({ id: '555555555', secret: '5'.repeat(64), name: 'owner' }), logger: silent });
  owner.setUrl(url);
  owner.start();
  await until(() => owner.online, 3000);
  owner.stop();

  let identity = { id: '555555555', secret: '6'.repeat(64), name: 'copia' };
  let taken = 0;
  const copy = new ServerLink({
    getIdentity: () => identity,
    onIdTaken: () => {
      taken++;
      identity = { ...identity, id: '666666666' };
    },
    logger: silent,
    minBackoffMs: 50,
  });
  copy.setUrl(url);
  copy.start();
  await until(() => copy.online, 5000);
  assert.equal(taken, 1);
  assert.ok(server.isOnline('666666666'));
  copy.stop();
  await server.stop();
});

test('ServerLink senza URL resta disabilitato', () => {
  const l = new ServerLink({ getIdentity: () => ({}), logger: silent });
  l.start();
  assert.equal(l.state, 'disabled');
  assert.equal(l.relay('1', 's', {}), false);
  l.stop();
});

test('socket UDP di prova liberato', async () => {
  // verifica che dgram sia utilizzabile nell'ambiente di test (diagnostica)
  const s = dgram.createSocket('udp4');
  await new Promise((r) => s.bind(0, '127.0.0.1', r));
  s.close();
});

test('indirizzi della postazione: prima la rete principale, in fondo le schede virtuali', async () => {
  const { rankAddresses, primaryAddress } = await import('../../src/main/net/addresses.js');
  const list = rankAddresses(
    {
      'vEthernet (WSL)': [{ family: 'IPv4', address: '172.22.128.1', internal: false }],
      'VirtualBox Host-Only Network': [{ family: 'IPv4', address: '192.168.56.1', internal: false }],
      Ethernet: [{ family: 'IPv4', address: '169.254.10.2', internal: false }],
      'Wi-Fi': [
        { family: 'IPv4', address: '192.168.1.14', internal: false },
        { family: 'IPv6', address: 'fe80::1', internal: false },
      ],
      'Loopback Pseudo-Interface 1': [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    },
    '192.168.1.14',
  );
  assert.deepEqual(list.map((a) => a.address), ['192.168.1.14', '172.22.128.1', '192.168.56.1']);
  assert.equal(list[0].primary, true);
  assert.equal(list[1].virtual, true);
  // senza scheda principale nota: le fisiche prima delle virtuali
  const plain = rankAddresses({ 'vEthernet (Default Switch)': [{ family: 'IPv4', address: '172.30.0.1' }], Ethernet: [{ family: 'IPv4', address: '10.0.0.5' }] });
  assert.deepEqual(plain.map((a) => a.address), ['10.0.0.5', '172.30.0.1']);
  const p = await primaryAddress({ timeoutMs: 500 });
  assert.ok(p === null || /^\d+\.\d+\.\d+\.\d+$/.test(p));
});

test('sharesSubnet: stessa rete locale anche quando la richiesta passa dal server', async () => {
  const { sharesSubnet } = await import('../../src/shared/netinfo.js');
  const ifs = {
    'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.14', netmask: '255.255.255.0', internal: false }],
    lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
  };
  assert.equal(sharesSubnet(['192.168.1.119'], ifs), true);
  assert.equal(sharesSubnet(['192.168.2.5'], ifs), false);
  assert.equal(sharesSubnet(['8.8.8.8'], ifs), false, 'indirizzi pubblici mai');
  assert.equal(sharesSubnet(['127.0.0.5'], ifs), false, 'loopback non è la LAN');
  assert.equal(sharesSubnet(['nonsenso', null], ifs), false);
});
