import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateId, isValidId, normalizeId, formatId, parseTarget, targetKey, targetLabel } from '../../src/shared/ids.js';
import { normalizeServerUrl, sanitizeName, isValidSid, newSid, safeParse, reasonText } from '../../src/shared/protocol.js';
import { defaultPermissions, sanitizePermissions, permissionsForMode, PERMISSION_KEYS } from '../../src/shared/permissions.js';
import { containRect, toNormalized, toScreenPoint, toAbsoluteInput, fromAbsoluteInput, wheelUnits, NORM_MAX } from '../../src/shared/geometry.js';
import { TokenBucket, SlidingWindowCounter, Lockout } from '../../src/shared/ratelimit.js';
import { encodeChunk, decodeChunk, sanitizeFileName, sanitizeRelativePath, uniqueName } from '../../src/shared/transfer.js';
import { formatBytes, formatDuration, initials, formatBitrate } from '../../src/shared/format.js';
import { orderCodecs } from '../../src/shared/quality.js';

test('generateId produce 9 cifre senza zero iniziale', () => {
  for (let i = 0; i < 500; i++) {
    const id = generateId();
    assert.ok(isValidId(id), id);
  }
  assert.equal(generateId(() => 0), '100000000');
});

test('normalizeId e formatId', () => {
  assert.equal(normalizeId('123 456 789'), '123456789');
  assert.equal(normalizeId('123-456-789'), '123456789');
  assert.equal(normalizeId('023456789'), null);
  assert.equal(normalizeId('12345678'), null);
  assert.equal(formatId('123456789'), '123 456 789');
});

test('parseTarget distingue ID, IPv4, hostname, IPv6', () => {
  assert.deepEqual(parseTarget(' 123 456 789 ', 47801), { kind: 'id', id: '123456789' });
  assert.deepEqual(parseTarget('192.168.1.10', 47801), { kind: 'address', host: '192.168.1.10', port: 47801 });
  assert.deepEqual(parseTarget('pc-ufficio:5000', 47801), { kind: 'address', host: 'pc-ufficio', port: 5000 });
  assert.deepEqual(parseTarget('[fe80::1]:6000', 47801), { kind: 'address', host: 'fe80::1', port: 6000 });
  assert.deepEqual(parseTarget('fe80::1', 47801), { kind: 'address', host: 'fe80::1', port: 47801 });
  assert.equal(parseTarget('12345', 47801), null);
  assert.equal(parseTarget('host:99999', 47801), null);
  assert.equal(parseTarget('bad host', 47801), null);
  assert.equal(parseTarget('', 47801), null);
  assert.equal(targetKey(parseTarget('PC:5000', 1)), 'addr:pc:5000');
  assert.equal(targetLabel({ kind: 'address', host: 'fe80::1', port: 7 }), '[fe80::1]:7');
});

test('normalizeServerUrl completa schema, porta e percorso', () => {
  assert.equal(normalizeServerUrl('example.com'), 'ws://example.com:47800/ws');
  assert.equal(normalizeServerUrl('10.0.0.5:9000'), 'ws://10.0.0.5:9000/ws');
  assert.equal(normalizeServerUrl('https://remoto.example.com'), 'wss://remoto.example.com/ws');
  assert.equal(normalizeServerUrl('wss://remoto.example.com/custom'), 'wss://remoto.example.com/custom');
  assert.equal(normalizeServerUrl(''), '');
});

test('sanitizeName toglie controlli e limita la lunghezza', () => {
  assert.equal(sanitizeName('  Mario\u0007 \u202e '), 'Mario');
  assert.equal(sanitizeName(''), 'Postazione');
  assert.equal(sanitizeName('x'.repeat(100)).length, 48);
});

test('sid e parse sicuro', () => {
  assert.ok(isValidSid(newSid()));
  assert.ok(!isValidSid('../etc'));
  assert.equal(safeParse('[1,2]'), null);
  assert.equal(safeParse('{bad'), null);
  assert.deepEqual(safeParse('{"a":1}'), { a: 1 });
  assert.match(reasonText('declined'), /rifiutata/);
  assert.match(reasonText('sconosciuto'), /Errore/);
});

test('permessi: default, sanificazione, modalità file', () => {
  const d = defaultPermissions();
  assert.deepEqual(Object.keys(d), PERMISSION_KEYS);
  const p = sanitizePermissions({ control: false, files: 'si', evil: true });
  assert.equal(p.control, false);
  assert.equal(p.files, d.files);
  assert.equal('evil' in p, false);
  const f = permissionsForMode(d, 'files');
  assert.equal(f.control, false);
  assert.equal(f.files, true);
});

test('containRect gestisce le bande nere', () => {
  assert.deepEqual(containRect(1920, 1080, 960, 1000), { x: 0, y: 230, width: 960, height: 540 });
  assert.deepEqual(containRect(1000, 1000, 400, 200), { x: 100, y: 0, width: 200, height: 200 });
  assert.deepEqual(containRect(0, 0, 50, 60), { x: 0, y: 0, width: 50, height: 60 });
});

test('toNormalized rifiuta i punti fuori dal video salvo clamp', () => {
  const r = { x: 10, y: 20, width: 100, height: 50 };
  assert.deepEqual(toNormalized(10, 20, r), { x: 0, y: 0 });
  assert.deepEqual(toNormalized(110, 70, r), { x: NORM_MAX, y: NORM_MAX });
  assert.equal(toNormalized(5, 30, r), null);
  assert.deepEqual(toNormalized(5, 30, r, true), { x: 0, y: Math.round(0.2 * NORM_MAX) });
});

test('toScreenPoint copre gli estremi del monitor', () => {
  const mon = { x: 2560, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(toScreenPoint(0, 0, mon), { x: 2560, y: 0 });
  assert.deepEqual(toScreenPoint(NORM_MAX, NORM_MAX, mon), { x: 2560 + 1919, y: 1079 });
});

test('toAbsoluteInput ricade sempre sullo stesso pixel (come calcola Windows)', () => {
  const virts = [
    { x: 0, y: 0, width: 4480, height: 1440 },
    { x: -1920, y: -200, width: 5760, height: 1640 },
    { x: 0, y: 0, width: 1366, height: 768 },
  ];
  for (const v of virts) {
    for (let i = 0; i < 2000; i++) {
      const x = v.x + Math.floor(Math.random() * v.width);
      const y = v.y + Math.floor(Math.random() * v.height);
      const a = toAbsoluteInput(x, y, v);
      assert.deepEqual(fromAbsoluteInput(a.dx, a.dy, v), { x, y });
    }
  }
});

test('wheelUnits converte pixel, righe e pagine', () => {
  assert.equal(wheelUnits(100, 0), -120);
  assert.equal(wheelUnits(-3, 1), 120);
  assert.equal(wheelUnits(1, 2), -120);
});

test('TokenBucket si ricarica nel tempo', () => {
  let t = 0;
  const b = new TokenBucket({ capacity: 2, refillPerSec: 1, now: () => t });
  assert.ok(b.take());
  assert.ok(b.take());
  assert.ok(!b.take());
  t += 1000;
  assert.ok(b.take());
  assert.ok(!b.take());
});

test('SlidingWindowCounter rispetta finestra e limite', () => {
  let t = 0;
  const c = new SlidingWindowCounter({ windowMs: 1000, limit: 2, now: () => t });
  assert.ok(c.hit('a'));
  assert.ok(c.hit('a'));
  assert.ok(!c.hit('a'));
  assert.ok(c.hit('b'));
  t = 1001;
  assert.ok(c.hit('a'));
  assert.equal(c.count('a'), 1);
});

test('Lockout blocca dopo N errori e poi si sblocca', () => {
  let t = 0;
  const l = new Lockout({ maxFailures: 3, windowMs: 10_000, lockMs: 5_000, now: () => t });
  assert.equal(l.fail('x'), 2);
  assert.equal(l.fail('x'), 1);
  assert.equal(l.remaining('x'), 0);
  assert.equal(l.fail('x'), 0);
  assert.equal(l.remaining('x'), 5000);
  t = 5001;
  assert.equal(l.remaining('x'), 0);
  l.fail('y');
  l.success('y');
  assert.equal(l.fail('y'), 2);
});

test('chunk binari: codifica e decodifica', () => {
  const data = new Uint8Array([1, 2, 3, 250]);
  const enc = encodeChunk(0xdeadbeef, 7, data);
  const dec = decodeChunk(enc.buffer);
  assert.equal(dec.xid, 0xdeadbeef);
  assert.equal(dec.index, 7);
  assert.deepEqual(Array.from(dec.data), [1, 2, 3, 250]);
  assert.equal(decodeChunk(new Uint8Array(3)), null);
});

test('sanitizeRelativePath blocca le uscite dalla cartella', () => {
  assert.equal(sanitizeRelativePath('a/b/c.txt'), 'a/b/c.txt');
  assert.equal(sanitizeRelativePath('a\\b\\c.txt'), 'a/b/c.txt');
  assert.equal(sanitizeRelativePath('./a//b'), 'a/b');
  assert.equal(sanitizeRelativePath('../x'), null);
  assert.equal(sanitizeRelativePath('a/../../x'), null);
  assert.equal(sanitizeRelativePath('C:\\Windows\\x'), null);
  assert.equal(sanitizeRelativePath('/etc/passwd'), null);
  assert.equal(sanitizeRelativePath(''), null);
  assert.equal(sanitizeRelativePath('a/con.txt'), 'a/_con.txt');
});

test('sanitizeFileName e uniqueName', () => {
  assert.equal(sanitizeFileName('a<b>:c?.txt'), 'a_b__c_.txt');
  assert.equal(sanitizeFileName('nome. '), 'nome');
  assert.equal(sanitizeFileName('..'), 'file');
  const taken = new Set(['rep.pdf', 'rep (1).pdf']);
  assert.equal(uniqueName('rep.pdf', (n) => taken.has(n)), 'rep (2).pdf');
  assert.equal(uniqueName('nuovo.txt', (n) => taken.has(n)), 'nuovo.txt');
  assert.equal(uniqueName('.bashrc', (n) => n === '.bashrc'), '.bashrc (1)');
});

test('formattazione in italiano', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1,5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5 MB');
  assert.equal(formatDuration(65_000), '01:05');
  assert.equal(formatDuration(3_725_000), '1:02:05');
  assert.equal(formatBitrate(3_200_000), '3,2 Mbit/s');
  assert.equal(initials('Mario Rossi'), 'MR');
  assert.equal(initials('pc-ufficio'), 'PU');
  assert.equal(initials(''), '?');
});

test('orderCodecs mette prima il preferito', () => {
  const caps = [{ mimeType: 'video/VP8' }, { mimeType: 'video/rtx' }, { mimeType: 'video/H264' }, { mimeType: 'video/VP9' }];
  assert.deepEqual(orderCodecs(caps, 'vp9').map((c) => c.mimeType), ['video/VP9', 'video/VP8', 'video/rtx', 'video/H264']);
  assert.deepEqual(orderCodecs(caps, 'auto').map((c) => c.mimeType)[0], 'video/H264');
  assert.deepEqual(orderCodecs(caps, 'av1'), caps);
});

import { classifyPair, isPrivateAddress } from '../../src/shared/netinfo.js';

test('classifyPair: LAN anche con candidati prflx su indirizzi privati, relay, P2P', () => {
  assert.equal(classifyPair({ candidateType: 'host', address: '192.168.1.5' }, { candidateType: 'host', address: '192.168.1.9' }), 'lan');
  assert.equal(classifyPair({ candidateType: 'host', address: '192.168.1.5' }, { candidateType: 'prflx', address: '192.168.1.9' }), 'lan');
  assert.equal(classifyPair({ candidateType: 'host', address: '172.22.128.1' }, { candidateType: 'prflx', address: '' }), 'lan');
  assert.equal(classifyPair({ candidateType: 'host', address: '81.2.3.4' }, { candidateType: 'prflx', address: '' }), 'p2p');
  assert.equal(classifyPair({ candidateType: 'srflx', address: '93.1.2.3' }, { candidateType: 'srflx', address: '151.4.5.6' }), 'p2p');
  assert.equal(classifyPair({ candidateType: 'relay', address: '10.0.0.1' }, { candidateType: 'host', address: '10.0.0.2' }), 'relay');
  assert.equal(classifyPair(undefined, {}), '');
  assert.ok(isPrivateAddress('172.20.1.1'));
  assert.ok(!isPrivateAddress('172.32.1.1'));
  assert.ok(isPrivateAddress('fe80::1'));
  assert.ok(isPrivateAddress('fd12:3456::1'));
  assert.ok(!isPrivateAddress('8.8.8.8'));
});

import { sanitizeIceServers } from '../../src/shared/protocol.js';

test('sanitizeIceServers tiene solo voci WebRTC valide', () => {
  assert.deepEqual(sanitizeIceServers([{ urls: 'turn:t.example:3478', username: 'u', credential: 'p' }, { urls: ['javascript:x', 'stun:s.example'] }, { urls: 'http://x' }, null, 'stun:a']), [
    { urls: ['turn:t.example:3478'], username: 'u', credential: 'p' },
    { urls: ['stun:s.example'] },
  ]);
  assert.deepEqual(sanitizeIceServers('non un array'), []);
});

import { recvonlyAudioMid } from '../../src/shared/sdp.js';

test('recvonlyAudioMid trova il canale del microfono nell’offerta dell’host', () => {
  const sdp = [
    'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1 2 3',
    'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=mid:0', 'a=sendonly',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:1', 'a=sendonly',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:2', 'a=recvonly',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=mid:3',
  ].join('\r\n');
  assert.equal(recvonlyAudioMid(sdp), '2');
  assert.equal(recvonlyAudioMid(sdp.replace('a=recvonly', 'a=sendrecv')), null);
  assert.equal(recvonlyAudioMid(''), null);
});
