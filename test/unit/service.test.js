// Client del servizio "controllo completo": framing dei messaggi, round-trip su pipe reale,
// e instradamento dell'injector verso il servizio quando è collegato.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { encodeFrame, decodeFrames, ServiceClient } from '../../src/main/native/service-client.js';
import { InputInjector } from '../../src/main/native/input.js';

const JSON_FRAME = 1;
const BINARY_FRAME = 2;

test('encodeFrame/decodeFrames: round-trip e buffer parziali', () => {
  const a = encodeFrame(JSON_FRAME, JSON.stringify({ op: 'hello', id: 1 }));
  const b = encodeFrame(BINARY_FRAME, Buffer.from([1, 2, 3, 4]));
  const whole = Buffer.concat([a, b]);
  const { frames, rest } = decodeFrames(whole);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].type, JSON_FRAME);
  assert.deepEqual(JSON.parse(frames[0].data.toString()), { op: 'hello', id: 1 });
  assert.equal(frames[1].type, BINARY_FRAME);
  assert.deepEqual([...frames[1].data], [1, 2, 3, 4]);
  assert.equal(rest.length, 0);

  // un messaggio spezzato a metà non deve essere consumato
  const half = whole.subarray(0, a.length + 3);
  const part = decodeFrames(half);
  assert.equal(part.frames.length, 1);
  assert.ok(part.rest.length > 0);
});

test('decodeFrames rifiuta lunghezze assurde', () => {
  const bad = Buffer.alloc(5);
  bad.writeInt32LE(1 << 30, 0); // oltre il limite
  bad[4] = JSON_FRAME;
  assert.throws(() => decodeFrames(bad), /non valido/);
});

// Finto servizio su named pipe: risponde a hello/capture/sas e registra gli input.
function fakeService(pipePath) {
  const received = { inputs: [], ops: [] };
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    const send = (type, payload) => socket.write(encodeFrame(type, payload));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { frames, rest } = decodeFrames(buffer);
      buffer = rest;
      for (const f of frames) {
        const msg = JSON.parse(f.data.toString());
        received.ops.push(msg.op);
        if (msg.op === 'hello') send(JSON_FRAME, JSON.stringify({ id: msg.id, ok: true, v: 1, session: 7, system: false, desktop: 'Default' }));
        else if (msg.op === 'input') received.inputs.push(...msg.events);
        else if (msg.op === 'sas') send(JSON_FRAME, JSON.stringify({ id: msg.id, ok: true }));
        else if (msg.op === 'capture') {
          send(JSON_FRAME, JSON.stringify({ id: msg.id, ok: true, w: 2, h: 2, desktop: 'Default' }));
          send(BINARY_FRAME, Buffer.from([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160]));
        }
      }
    });
    socket.on('error', () => {});
  });
  server.pushDesktop = (name) => {
    for (const s of sockets) s.write(encodeFrame(JSON_FRAME, JSON.stringify({ ev: 'desktop', name })));
  };
  return { server, received, listen: () => new Promise((r) => server.listen(pipePath, r)) };
}

test('ServiceClient: handshake, input, cattura, sas e desktop protetto', { skip: process.platform !== 'win32' ? 'solo Windows (named pipe)' : false }, async () => {
  const pipePath = `\\\\.\\pipe\\remoto-test-${process.pid}`;
  const fake = fakeService(pipePath);
  await fake.listen();
  const client = new ServiceClient({ pipePath, logger: { info() {}, warn() {} }, retryMs: 200 });
  try {
    client.start();
    for (let i = 0; i < 50 && !client.connected; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(client.connected, true);
    assert.equal(client.info.session, 7);
    assert.equal(client.secure, false);

    client.input([['m', 10, 20, 0, 0x8001], ['k', 65, 0, 0]]);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(fake.received.inputs[0], ['m', 10, 20, 0, 0x8001]);

    const frame = await client.capture(2);
    assert.equal(frame.w, 2);
    assert.equal(frame.h, 2);
    assert.equal(frame.data.length, 16);

    const sas = await client.sas();
    assert.equal(sas.ok, true);

    // il servizio annuncia il passaggio a un desktop protetto
    const ev = once(client, 'desktop');
    fake.server.pushDesktop('Winlogon');
    await ev;
    assert.equal(client.secure, true);
  } finally {
    client.stop();
    await new Promise((r) => fake.server.close(r));
  }
});

// api finta per l'injector (niente Win32 reale): registra gli eventi SendInput locali.
function fakeApi() {
  return {
    sent: [],
    sendInput(inputs) {
      this.sent.push(...inputs);
      return inputs.length;
    },
    getSystemMetrics(i) {
      return { 76: 0, 77: 0, 78: 1920, 79: 1080, 23: 0 }[i] ?? 0;
    },
    getCursorPos: () => ({ x: 0, y: 0 }),
  };
}

test('InputInjector: con servizio collegato instrada lì; senza, usa SendInput locale', () => {
  const api = fakeApi();
  const inj = new InputInjector({ api });
  const rect = { x: 0, y: 0, width: 1920, height: 1080 };

  // nessun servizio → SendInput locale
  inj.move(rect, 0.5, 0.5);
  assert.equal(api.sent.length, 1);

  // servizio collegato → gli eventi vanno al servizio come tuple, niente SendInput locale
  const sink = { connected: true, events: [], input(ev) { this.events.push(...ev); } };
  inj.setSink(sink);
  api.sent.length = 0;
  inj.move(rect, 0.5, 0.5);
  inj.key('s1', 'KeyA', true);
  assert.equal(api.sent.length, 0, 'niente SendInput locale quando c’è il servizio');
  assert.equal(sink.events[0][0], 'm');
  assert.ok(sink.events.some((e) => e[0] === 'k'));
  assert.equal(inj.available, true);

  // servizio scollegato → torna a SendInput locale
  sink.connected = false;
  inj.move(rect, 0.2, 0.2);
  assert.equal(api.sent.length, 1);
});
