import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { createRendezvousServer } from '../../src/server/core.js';
import { turnCredentials } from '../../src/server/turn.js';
import { wsClient, SECRET_A, SECRET_B } from '../helpers/ws-client.js';

let server;
let url;
let dataDir;

async function startServer(extra = {}) {
  server = createRendezvousServer({ port: 0, host: '127.0.0.1', dataDir, ...extra });
  const { port } = await server.start();
  url = `ws://127.0.0.1:${port}/ws`;
  return port;
}

async function hello(id, secret = SECRET_A, name = 'pc') {
  const c = wsClient(url);
  await c.opened;
  c.send({ t: 'hello', v: 1, id, secret, name });
  return c;
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remoto-srv-'));
});

afterEach(async () => {
  await server?.stop();
  server = null;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('hello registra un ID nuovo e restituisce STUN e TURN', async () => {
  await startServer({ turnUrls: ['turn:turn.example.com:3478'], turnSecret: 'segreto', stunUrls: ['stun:s.example.com:3478'] });
  const c = await hello('111222333');
  const w = await c.next('welcome');
  assert.equal(w.id, '111222333');
  assert.deepEqual(w.iceServers[0], { urls: ['stun:s.example.com:3478'] });
  const turn = w.iceServers[1];
  assert.deepEqual(turn.urls, ['turn:turn.example.com:3478']);
  assert.match(turn.username, /^\d+:111222333$/);
  const expected = crypto.createHmac('sha1', 'segreto').update(turn.username).digest('base64');
  assert.equal(turn.credential, expected);
  assert.ok(server.isOnline('111222333'));
  c.close();
});

test('lo stesso ID con un segreto diverso viene rifiutato', async () => {
  await startServer();
  const a = await hello('111222333', SECRET_A);
  await a.next('welcome');
  const b = await hello('111222333', SECRET_B);
  const err = await b.next('error');
  assert.equal(err.code, 'id-taken');
  assert.equal((await b.closed).code, 4000);
  a.close();
});

test('lo stesso ID con lo stesso segreto sostituisce la connessione precedente', async () => {
  await startServer();
  const a = await hello('111222333');
  await a.next('welcome');
  const a2 = await hello('111222333');
  await a2.next('welcome');
  const err = await a.next('error');
  assert.equal(err.code, 'replaced');
  assert.equal((await a.closed).code, 4001);
  assert.ok(server.isOnline('111222333'));
  a2.close();
});

test('relay inoltra con il mittente autenticato dal server', async () => {
  await startServer();
  const a = await hello('111222333', SECRET_A);
  const b = await hello('444555666', SECRET_B);
  await a.next('welcome');
  await b.next('welcome');
  a.send({ t: 'relay', to: '444555666', sid: 'sessione01', data: { k: 'req', name: 'A', from: '999999999' } });
  const r = await b.next('relay');
  assert.equal(r.from, '111222333');
  assert.equal(r.sid, 'sessione01');
  assert.equal(r.data.k, 'req');
  a.close();
  b.close();
});

test('relay verso un ID offline restituisce relay-fail', async () => {
  await startServer();
  const a = await hello('111222333');
  await a.next('welcome');
  a.send({ t: 'relay', to: '777888999', sid: 'sessione01', data: { k: 'req' } });
  const f = await a.next('relay-fail');
  assert.equal(f.code, 'offline');
  a.send({ t: 'relay', to: 'xx', sid: 'sessione01', data: {} });
  assert.equal((await a.next('relay-fail')).code, 'invalid');
  a.close();
});

test('query restituisce lo stato online', async () => {
  await startServer();
  const a = await hello('111222333');
  const b = await hello('444555666', SECRET_B);
  await a.next('welcome');
  await b.next('welcome');
  a.send({ t: 'query', rid: 7, ids: ['444555666', '777888999', 'non-valido'] });
  const q = await a.next('query-result');
  assert.equal(q.rid, 7);
  assert.deepEqual(q.online, { 444555666: true, 777888999: false });
  b.close();
  await b.closed;
  await new Promise((r) => setTimeout(r, 50));
  a.send({ t: 'query', rid: 8, ids: ['444555666'] });
  assert.deepEqual((await a.next('query-result')).online, { 444555666: false });
  a.close();
});

test('senza hello la connessione viene chiusa; hello non valido o di altra versione dà errore', async () => {
  await startServer();
  const c = wsClient(url);
  await c.opened;
  c.send({ t: 'query', ids: [] });
  assert.equal((await c.closed).code, 4003);

  const d = await hello('012345678');
  assert.equal((await d.next('error')).code, 'bad-hello');

  const e = wsClient(url);
  await e.opened;
  e.send({ t: 'hello', v: 99, id: '111222333', secret: SECRET_A });
  assert.equal((await e.next('error')).code, 'version');
});

test('limite sulle richieste di connessione per mittente', async () => {
  await startServer({ requestsPerMinute: 3 });
  const a = await hello('111222333');
  const b = await hello('444555666', SECRET_B);
  await a.next('welcome');
  await b.next('welcome');
  for (let i = 0; i < 3; i++) a.send({ t: 'relay', to: '444555666', sid: `sessione0${i}`, data: { k: 'req' } });
  for (let i = 0; i < 3; i++) await b.next('relay');
  a.send({ t: 'relay', to: '444555666', sid: 'sessione09', data: { k: 'req' } });
  assert.equal((await a.next('relay-fail')).code, 'rate-limited');
  // gli altri messaggi (sdp, ice) non sono limitati da questo contatore
  a.send({ t: 'relay', to: '444555666', sid: 'sessione09', data: { k: 'ice' } });
  assert.equal((await b.next('relay')).data.k, 'ice');
  a.close();
  b.close();
});

test('il registro sopravvive al riavvio del server', async () => {
  await startServer();
  const a = await hello('111222333', SECRET_A);
  await a.next('welcome');
  a.close();
  await server.stop();
  assert.ok(fs.existsSync(path.join(dataDir, 'registry.json')));
  await startServer();
  const b = await hello('111222333', SECRET_B);
  assert.equal((await b.next('error')).code, 'id-taken');
  const c = await hello('111222333', SECRET_A);
  assert.equal((await c.next('welcome')).id, '111222333');
  c.close();
});

test('/health e pagina di stato', async () => {
  const port = await startServer();
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.protocol, 1);
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(html, /Server ID di Remoto attivo/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/nulla`)).status, 404);
});

test('le connessioni WebSocket sono accettate su qualsiasi percorso', async () => {
  const port = await startServer();
  const c = wsClient(`ws://127.0.0.1:${port}/`);
  await c.opened;
  c.send({ t: 'hello', v: 1, id: '111222333', secret: SECRET_A });
  assert.equal((await c.next('welcome')).id, '111222333');
  c.close();
});

test('turnCredentials segue il formato di coturn', () => {
  const { username, credential } = turnCredentials({ secret: 's', id: '111222333', ttlSec: 60, now: 1_000_000 });
  assert.equal(username, '1060:111222333');
  assert.equal(credential, crypto.createHmac('sha1', 's').update('1060:111222333').digest('base64'));
});

test('un nuovo ID viene scritto su disco subito, senza attendere il salvataggio differito', async () => {
  await startServer();
  const a = await hello('999888777');
  await a.next('welcome');
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'registry.json'), 'utf8'));
  assert.ok(saved.ids['999888777']);
  a.close();
});
