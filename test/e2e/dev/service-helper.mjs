// Collaudo dell'helper del servizio in modalità di prova (utente normale, nessun privilegio in più).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ServiceClient } from '../../../src/main/native/service-client.js';
import { win32, virtualScreen } from '../../../src/main/native/win32.js';
import { toAbsoluteInput } from '../../../src/shared/geometry.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = win32();
import koffi from 'koffi';
// come Remoto (Electron) e l'helper: coordinate in pixel fisici
koffi.load('user32.dll').func('void * __stdcall SetProcessDpiAwarenessContext(intptr_t v)')(-4);
const sid = api.sessionId();
const exe = path.resolve('build/service/RemotoService.exe');
const helper = spawn(exe, ['helper', String(sid)], { stdio: 'ignore', windowsHide: true });
const silent = { info: (m) => console.log('  [client]', m), warn: (m) => console.log('  [client]', m) };
const client = new ServiceClient({ pipePath: `\\\\.\\pipe\\remoto-input-${sid}`, logger: silent, retryMs: 300 });
try {
  client.start();
  for (let i = 0; i < 40 && !client.connected; i++) await wait(100);
  console.log('collegato:', client.connected, JSON.stringify(client.info), 'desktop:', client.desktop);

  const saved = api.getCursorPos();
  const virt = virtualScreen(api);
  const target = { x: virt.x + 37, y: virt.y + 41 };
  const a = toAbsoluteInput(target.x, target.y, virt);
  client.input([['m', a.dx, a.dy, 0, 0x0001 | 0x8000 | 0x4000]]);
  await wait(150);
  const moved = api.getCursorPos();
  const back = toAbsoluteInput(saved.x, saved.y, virt);
  client.input([['m', back.dx, back.dy, 0, 0x0001 | 0x8000 | 0x4000]]);
  await wait(100);
  console.log('mouse tramite servizio:', JSON.stringify({ target, moved, restored: api.getCursorPos(), saved }));

  const f = await client.capture(640);
  const distinct = new Set();
  for (let i = 0; i < f.data.length; i += 4 * 97) distinct.add(f.data.readUInt32LE(i));
  console.log('cattura:', JSON.stringify({ w: f.w, h: f.h, bytes: f.data.length, attesi: f.w * f.h * 4, colori: distinct.size, desktop: f.desktop, alfa: f.data[3] }));

  const sas = await client.sas().then(() => 'ok', (e) => `errore: ${e.message}`);
  console.log('Ctrl+Alt+Canc senza servizio:', sas);
} finally {
  client.stop();
  helper.kill();
}
