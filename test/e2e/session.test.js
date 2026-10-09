// Test end-to-end: due istanze reali di Remoto (profili separati) e un server ID in memoria.
// Coprono connessione per ID con conferma (richiesta visibile in primo piano), video, chat, file,
// input, appunti, permessi, lavagna, privacy, monitor, qualità, riconnessione, LAN, solo file.
//
// Nota: il test sposta per un istante il cursore del mouse (e lo rimette dov'era) e, con
// REMOTO_E2E_VISUAL=1, mostra per un attimo la schermata nera della modalità privacy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { createRendezvousServer } from '../../src/server/core.js';
import { launchRemoto, windowWith, closeRemoto } from './launch.js';

const visual = process.env.REMOTO_E2E_VISUAL === '1';

let server;
let host;
let viewer;
let hostId;
let sess;
let tmp;

async function until(fn, ms = 20_000, label = 'condizione') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout in attesa di: ${label}`);
    await new Promise((r) => setTimeout(r, 120));
  }
}

const H = (fn, arg) => host.app.evaluate(fn, arg);
const V = (fn, arg) => viewer.app.evaluate(fn, arg);
const S = (fn, arg) => sess.evaluate(fn, arg);
const sessionState = () => S(() => window.__remotoSession?.state.ui.state);
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

async function openSession(input, mode = 'desktop') {
  const before = new Set(viewer.app.windows());
  const home = await windowWith(viewer.app, 'home/index.html');
  await home.fill('.connect-input input', input);
  await home.click(mode === 'files' ? 'button[data-tip="Solo trasferimento file"]' : 'button:has-text("Connetti")');
  const page = await until(() => viewer.app.windows().find((w) => !before.has(w) && w.url().includes('session/session.html')), 15_000, 'finestra di sessione');
  await page.waitForFunction(() => window.__remotoSession);
  return page;
}

async function closeSessionWindow(page) {
  await page.evaluate(() => remoto.send('viewer:disconnect')).catch(() => {});
  await until(() => H(() => globalThis.__remoto.host.list().length === 0), 15_000, 'sessione chiusa sull’host');
  await page.evaluate(() => remoto.send('viewer:close')).catch(() => {});
  await until(() => page.isClosed(), 10_000, 'finestra chiusa');
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remoto-e2e-files-'));
  server = createRendezvousServer({ port: 0, host: '127.0.0.1' });
  const { port } = await server.start();
  const url = `ws://127.0.0.1:${port}/ws`;
  host = await launchRemoto({ name: 'PC Ufficio', serverUrl: url });
  // microfono finto di Chromium sul viewer: il test non dipende dalle cuffie del PC
  viewer = await launchRemoto({ name: 'Portatile', serverUrl: url, env: { REMOTO_MEDIA_DIR: path.join(tmp, 'media'), REMOTO_FAKE_MEDIA: '1' } });
  await until(() => H(() => globalThis.__remoto?.link.state === 'online'), 30_000, 'host online');
  await until(() => V(() => globalThis.__remoto?.link.state === 'online'), 30_000, 'viewer online');
  hostId = await H(() => globalThis.__remoto.identity().id);
});

/** La finestra di richiesta è davvero visibile, in primo piano, e al centro dello schermo. */
async function assertPromptOnScreen() {
  await until(() => H(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes('prompt') && w.isVisible())), 5000, 'richiesta visibile');
  const info = await H(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('prompt') && x.isVisible());
    const b = w.getBounds();
    const d = screen.getDisplayMatching(b).workArea;
    const c = screen.dipToScreenPoint({ x: b.x + Math.round(b.width / 2), y: b.y + 60 });
    const top = globalThis.__remoto.hostSide.input.api.topWindowAt(c.x, c.y);
    return { topmost: String(top) === String(w.getNativeWindowHandle().readBigUInt64LE(0)), dx: Math.abs(b.x + b.width / 2 - (d.x + d.width / 2)), dy: Math.abs(b.y + b.height / 2 - (d.y + d.height / 2)) };
  });
  assert.equal(info.topmost, true, 'la richiesta deve stare sopra le altre finestre');
  assert.ok(info.dx < 60 && info.dy < 60, 'la richiesta deve stare al centro dello schermo');
}

after(async () => {
  await closeRemoto(viewer);
  await closeRemoto(host);
  await server?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('connessione per ID con conferma in primo piano, video e statistiche', async () => {
  sess = await openSession(hostId);
  const prompt = await windowWith(host.app, 'prompt/prompt.html');
  assert.match(await prompt.textContent('body'), /Portatile/);
  await assertPromptOnScreen();
  await until(async () => (await sessionState()) === 'waiting', 10_000, 'viewer in attesa');
  assert.equal(await S(() => document.querySelectorAll('input[type=password]').length), 0, 'nessun campo password');
  await prompt.click('button:has-text("Accetta")');
  await until(async () => (await sessionState()) === 'connected', 30_000, 'sessione connessa');
  await until(() => S(() => document.getElementById('screen').videoWidth > 0), 20_000, 'video');
  await until(() => S(() => (window.__remotoSession.state.stats?.fps || 0) > 0), 15_000, 'fotogrammi');
  const stats = await S(() => window.__remotoSession.state.stats);
  assert.equal(stats.conn, 'lan');
  // ritardo di riproduzione zero (field trial di main.js): senza, il buffer anti-jitter tratteneva 35-60 ms
  const jitterMs = await S(async () => {
    const read = async () => {
      let v = null;
      (await window.__remotoSession.state.peer.pc.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') v = r;
      });
      return v;
    };
    const a = await read();
    await new Promise((r) => setTimeout(r, 1500));
    const b = await read();
    return ((b.jitterBufferDelay - a.jitterBufferDelay) / Math.max(1, b.jitterBufferEmittedCount - a.jitterBufferEmittedCount)) * 1000;
  });
  assert.ok(jitterMs < 20, `buffer del video ricevuto troppo alto: ${jitterMs.toFixed(1)} ms`);
  const hs = await H(() => globalThis.__remoto.host.list());
  assert.equal(hs.length, 1);
  assert.equal(hs[0].state, 'active');
  assert.equal(hs[0].verified, true);
  if (hs[0].connType !== 'lan') console.log('DEBUG connType host:', JSON.stringify(hs[0]));
  assert.equal(hs[0].connType, 'lan');
  // nessuna traccia di accesso non presidiato nelle configurazioni
  for (const p of [host.profile, viewer.profile]) {
    const cfg = fs.readFileSync(path.join(p, 'config.json'), 'utf8');
    assert.ok(!/unattended|savedAuth|accessMode/.test(cfg));
  }
});

test('chat in entrambe le direzioni', async () => {
  await sess.click('button[aria-label="Chat"]');
  await sess.fill('.chat-form textarea', 'Ciao, sono il supporto');
  await sess.press('.chat-form textarea', 'Enter');
  const panel = await windowWith(host.app, 'panel/panel.html');
  await until(async () => (await panel.textContent('body')).includes('Ciao, sono il supporto'), 10_000, 'messaggio sul pannello host');
  await H(() => {
    const s = globalThis.__remoto.host.list()[0];
    globalThis.__remoto.hostSide.sendChat(s.id, 'Grazie, vedo il messaggio');
  });
  await until(async () => (await sess.textContent('.chat-list')).includes('Grazie, vedo il messaggio'), 10_000, 'risposta nella chat del viewer');
  await sess.click('button[aria-label="Chiudi chat"]');
});

test('trasferimento file: upload di file e cartelle, download, elenco remoto', async () => {
  const local = path.join(tmp, 'locale');
  const remote = path.join(tmp, 'remoto');
  fs.mkdirSync(path.join(local, 'Progetto', 'sotto'), { recursive: true });
  fs.mkdirSync(remote);
  fs.writeFileSync(path.join(local, 'grande.bin'), crypto.randomBytes(3 * 1024 * 1024 + 123));
  fs.writeFileSync(path.join(local, 'Progetto', 'sotto', 'nota.txt'), 'contenuto della nota');
  fs.writeFileSync(path.join(remote, 'dal-remoto.bin'), crypto.randomBytes(2 * 1024 * 1024 + 7));

  await S((args) => window.__remotoSession.upload(args.paths, args.dest), { paths: [path.join(local, 'grande.bin'), path.join(local, 'Progetto')], dest: remote });
  await until(() => fs.existsSync(path.join(remote, 'grande.bin')) && fs.existsSync(path.join(remote, 'Progetto', 'sotto', 'nota.txt')), 30_000, 'upload completato');
  await until(() => sha(path.join(remote, 'grande.bin')) === sha(path.join(local, 'grande.bin')), 10_000, 'hash upload');
  assert.equal(fs.readFileSync(path.join(remote, 'Progetto', 'sotto', 'nota.txt'), 'utf8'), 'contenuto della nota');

  await S((args) => window.__remotoSession.download(args.paths, args.dest), { paths: [path.join(remote, 'dal-remoto.bin')], dest: local });
  await until(() => fs.existsSync(path.join(local, 'dal-remoto.bin')), 30_000, 'download completato');
  await until(() => sha(path.join(local, 'dal-remoto.bin')) === sha(path.join(remote, 'dal-remoto.bin')), 10_000, 'hash download');

  const listing = await S((p) => window.__remotoSession.rpc('list', { path: p }), remote);
  assert.deepEqual(listing.entries.map((e) => e.name), ['Progetto', 'dal-remoto.bin', 'grande.bin']);
  assert.equal(fs.readdirSync(remote).some((n) => n.endsWith('.remoto-part')), false);
});

test('input: il mouse arriva al pixel giusto, i tasti arrivano all’host', async () => {
  const saved = await H(() => globalThis.__remoto.hostSide.input.cursor());
  try {
    await S(() => window.__remotoSession.state.peer.sendMove({ t: 'mm', x: 32768, y: 16384 }));
    const expected = await H(() => {
      const d = globalThis.__remoto.hostSide.displayCache.find((x) => x.primary).phys;
      return { x: d.x + Math.round((32768 / 65535) * (d.width - 1)), y: d.y + Math.round((16384 / 65535) * (d.height - 1)) };
    });
    await until(async () => {
      const c = await H(() => globalThis.__remoto.hostSide.input.cursor());
      return Math.abs(c.x - expected.x) <= 1 && Math.abs(c.y - expected.y) <= 1;
    }, 5000, 'cursore spostato');
  } finally {
    await H((_e, p) => globalThis.__remoto.hostSide.input.move({ x: p.x, y: p.y, width: 1, height: 1 }, 0, 0), saved);
  }

  // tastiera: si intercetta l'iniezione per non digitare davvero sul PC
  await H(() => {
    const inj = globalThis.__remoto.hostSide.input;
    globalThis.__realKey = inj.key;
    globalThis.__realText = inj.text;
    globalThis.__keys = [];
    globalThis.__typed = [];
    inj.key = (_sid, code, down) => {
      globalThis.__keys.push([code, down]);
      return 1;
    };
    inj.text = (s) => {
      globalThis.__typed.push(s);
      return 1;
    };
  });
  try {
    await sess.focus('#screen-wrap');
    await sess.keyboard.press('KeyA');
    await sess.keyboard.press('Shift+KeyB');
    await until(() => H(() => globalThis.__keys.length >= 6), 5000, 'tasti ricevuti');
    assert.deepEqual(await H(() => globalThis.__keys.splice(0)), [
      ['KeyA', true],
      ['KeyA', false],
      ['ShiftLeft', true],
      ['KeyB', true],
      ['KeyB', false],
      ['ShiftLeft', false],
    ]);
    // combinazioni della barra "Tasti speciali" e digitazione di testo
    await S(() => window.__remotoSession.state.peer.sendCtrl({ t: 'combo', name: 'win-r' }));
    await S(() => window.__remotoSession.state.peer.sendCtrl({ t: 'text', s: 'Buongiorno, è tutto ok!' }));
    await until(() => H(() => globalThis.__keys.length >= 4 && globalThis.__typed.length === 1), 5000, 'combinazione e testo');
    assert.deepEqual(await H(() => globalThis.__keys), [
      ['MetaLeft', true],
      ['KeyR', true],
      ['KeyR', false],
      ['MetaLeft', false],
    ]);
    assert.deepEqual(await H(() => globalThis.__typed), ['Buongiorno, è tutto ok!']);
  } finally {
    await H(() => {
      globalThis.__remoto.hostSide.input.key = globalThis.__realKey;
      globalThis.__remoto.hostSide.input.text = globalThis.__realText;
    });
  }
});

test('audio di sistema, azioni protette dai permessi, screenshot e registrazione', async () => {
  assert.equal(await S(() => window.__remotoSession.state.hello.audio), true, 'audio di sistema catturato');
  await S(() => {
    window.__ctrlLog = [];
    window.__remotoSession.state.peer.addEventListener('ctrl', (e) => window.__ctrlLog.push(e.detail));
    window.__remotoSession.state.peer.sendCtrl({ t: 'sys', op: 'lock' });
  });
  const res = await until(() => S(() => window.__ctrlLog.find((m) => m.t === 'sys-res')), 5000, 'risposta azione di sistema');
  assert.equal(res.ok, false);
  assert.match(res.error, /Permesso non concesso/);

  if (!(await H(() => globalThis.__remoto.status().admin))) {
    const id = await H(() => globalThis.__remoto.host.list()[0].id);
    await H((_e, sid) => globalThis.__remoto.host.setPermissions(sid, { blockInput: true }), id);
    await until(() => S(() => window.__remotoSession.state.perms.blockInput === true), 5000, 'permesso blocco input');
    await S(() => window.__remotoSession.state.peer.sendCtrl({ t: 'block', on: true }));
    const b = await until(() => S(() => window.__ctrlLog.find((m) => m.t === 'block')), 5000, 'risposta blocco input');
    assert.equal(b.ok, false);
    assert.match(b.error, /amministratore/);
    await H((_e, sid) => globalThis.__remoto.host.setPermissions(sid, { blockInput: false }), id);
  }

  const media = path.join(tmp, 'media');
  await S(() => window.__remotoSession.screenshot());
  await until(() => fs.existsSync(media) && fs.readdirSync(media).some((n) => n.endsWith('.png')), 10_000, 'screenshot salvato');
  const png = fs.readdirSync(media).find((n) => n.endsWith('.png'));
  assert.deepEqual([...fs.readFileSync(path.join(media, png)).subarray(1, 4)].map((c) => String.fromCharCode(c)).join(''), 'PNG');

  await S(() => window.__remotoSession.toggleRecording());
  await new Promise((r) => setTimeout(r, 2500));
  await S(() => window.__remotoSession.stopRecording());
  const webm = await until(() => fs.readdirSync(media).find((n) => n.endsWith('.webm')), 10_000, 'registrazione salvata');
  assert.ok(fs.statSync(path.join(media, webm)).size > 20_000, 'la registrazione contiene dati');
});

test('microfono del client nelle app del PC remoto (cuffie del portatile in Teams)', async () => {
  const inputs = await S(() => window.__remotoSession.audioDevices('audioinput'));
  assert.ok(inputs.length > 0, 'almeno un microfono sul client');
  await S((d) => window.__remotoSession.selectMic(d.deviceId, d.label), inputs[0]);
  assert.ok(await S(() => Boolean(window.__remotoSession.state.mic.track)));
  const engine = await windowWith(host.app, 'engine/engine.html');
  const micBytes = () =>
    engine.evaluate(async () => {
      const [p] = [...window.__peers.values()];
      const st = await p.pc.getStats();
      let bytes = 0;
      st.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') bytes += r.bytesReceived || 0;
      });
      return bytes;
    });
  await until(async () => (await micBytes()) > 4000, 15_000, 'audio del microfono ricevuto dal PC remoto');
  const status = await until(() => S(() => window.__remotoSession.state.mic.status), 10_000, 'stato del microfono');
  assert.ok(status.ok || status.reason === 'no-virtual-device', JSON.stringify(status));
  const panel = await windowWith(host.app, 'panel/panel.html');
  await until(async () => /Microfono ricevuto|Parla nelle app/.test(await panel.textContent('body')), 10_000, 'microfono nel pannello del PC remoto');

  // permesso revocato dal PC remoto: il microfono del client si spegne
  const id = await H(() => globalThis.__remoto.host.list()[0].id);
  await H((_e, sid) => globalThis.__remoto.host.setPermissions(sid, { microphone: false }), id);
  await until(() => S(() => !window.__remotoSession.state.mic.track), 10_000, 'microfono spento');
  await H((_e, sid) => globalThis.__remoto.host.setPermissions(sid, { microphone: true }), id);
  await until(() => S(() => window.__remotoSession.state.perms.microphone === true), 10_000, 'permesso microfono ripristinato');
  await S(() => window.__remotoSession.selectMic(''));
});

test('appunti sincronizzati nei due sensi', async () => {
  await H(() => {
    globalThis.__clip = null;
    globalThis.__remoto.clipboard.apply = (p) => {
      globalThis.__clip = p;
      return true;
    };
  });
  await V(() => {
    globalThis.__clip = null;
    globalThis.__remoto.clipboard.apply = (p) => {
      globalThis.__clip = p;
      return true;
    };
  });
  await V(() => globalThis.__remoto.clipboard.emit('change', { kind: 'text', data: 'copiato sul portatile' }));
  await until(() => H(() => globalThis.__clip?.data === 'copiato sul portatile'), 10_000, 'appunti sull’host');
  const big = 'x'.repeat(500_000);
  await H((_e, data) => globalThis.__remoto.clipboard.emit('change', { kind: 'text', data }), big);
  await until(() => V(() => globalThis.__clip?.data?.length === 500_000), 10_000, 'appunti grandi sul viewer');
});

test('permessi cambiati dal PC remoto durante la sessione', async () => {
  const id = await H(() => globalThis.__remoto.host.list()[0].id);
  await H((_e, sid) => globalThis.__remoto.host.setPermissions(sid, { files: false }), id);
  await until(() => S(() => window.__remotoSession.state.perms.files === false), 10_000, 'permesso file revocato');
  const err = await S(() => window.__remotoSession.rpc('roots').then(() => null, (e) => e.message));
  assert.match(err, /non è consentito/);
  await H((_e, sid) => globalThis.__remoto.host.setPermissions(sid, { files: true }), id);
  await until(() => S(() => window.__remotoSession.state.perms.files === true), 10_000, 'permesso file ripristinato');
});

test('lavagna: i tratti arrivano sul PC remoto e spariscono a fine uso', async () => {
  await S(() => {
    const p = window.__remotoSession.state.peer;
    p.sendCtrl({ t: 'wb', op: 'begin', id: 'e2e1', color: '#ff3b5c', tool: 'pen', w: 4, p: [0.01, 0.01] });
    p.sendCtrl({ t: 'wb', op: 'pts', id: 'e2e1', pts: [[0.02, 0.02], [0.03, 0.015]] });
    p.sendCtrl({ t: 'wb', op: 'end', id: 'e2e1' });
  });
  await until(() => H(() => globalThis.__remoto.hostSide.whiteboard.byDisplay.size === 1), 10_000, 'lavagna aperta sull’host');
  const protectedWin = await H(() => [...globalThis.__remoto.hostSide.whiteboard.byDisplay.values()][0].win.isContentProtected());
  assert.equal(protectedWin, true);
  await H(() => {
    const s = globalThis.__remoto.host.list()[0];
    globalThis.__remoto.hostSide.whiteboard.release(s.id);
  });
  assert.equal(await H(() => globalThis.__remoto.hostSide.whiteboard.byDisplay.size), 0);
});

test('modalità privacy: senza permesso viene rifiutata, con permesso oscura ed è esclusa dalla cattura', async () => {
  await S(() => window.__remotoSession.state.peer.sendCtrl({ t: 'privacy', on: true }));
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(await H(() => globalThis.__remoto.hostSide.privacy.active), false, 'senza permesso nessun oscuramento');
  if (!visual) return;
  const id = await H(() => globalThis.__remoto.host.list()[0].id);
  await H((_e, sid) => globalThis.__remoto.host.setPermissions(sid, { privacy: true }), id);
  await until(() => S(() => window.__remotoSession.state.perms.privacy === true), 10_000, 'permesso privacy');
  // quota di pixel quasi neri nel video ricevuto (griglia 24x24): solo colori, nessuna immagine salvata
  const blackRatio = () =>
    S(() => {
      const v = document.getElementById('screen');
      const c = document.createElement('canvas');
      c.width = 24;
      c.height = 24;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, 0, 24, 24);
      const d = ctx.getImageData(0, 0, 24, 24).data;
      let black = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 12) black++;
      return black / (24 * 24);
    });
  const before = await blackRatio();
  await S(() => window.__remotoSession.state.peer.sendCtrl({ t: 'privacy', on: true }));
  try {
    await until(() => H(() => globalThis.__remoto.hostSide.privacy.active), 10_000, 'privacy attiva');
    const info = await H(() => globalThis.__remoto.hostSide.privacy.wins.map((w) => w.isContentProtected()));
    assert.ok(info.length >= 1 && info.every(Boolean));
    await new Promise((r) => setTimeout(r, 900));
    const during = await blackRatio();
    console.log(`privacy: pixel neri nel video prima ${(before * 100).toFixed(0)}%, durante ${(during * 100).toFixed(0)}%`);
    assert.ok(during < 0.95 || before > 0.95, 'chi controlla deve continuare a vedere il desktop');
  } finally {
    await S(() => window.__remotoSession.state.peer.sendCtrl({ t: 'privacy', on: false }));
    await until(() => H(() => !globalThis.__remoto.hostSide.privacy.active), 10_000, 'privacy disattivata');
    await H((_e, sid) => globalThis.__remoto.host.setPermissions(sid, { privacy: false }), id);
  }
});

test('cambio monitor e qualità', async () => {
  const displays = await S(() => window.__remotoSession.state.displays);
  if (displays.length > 1) {
    const other = displays.find((d) => !d.primary);
    await S((id) => window.__remotoSession.state.peer.sendCtrl({ t: 'display', id }), other.id);
    await until(() => S((id) => window.__remotoSession.state.active === id, other.id), 10_000, 'monitor cambiato');
    await until(() => S((w) => document.getElementById('screen').videoWidth === w, other.width), 10_000, 'risoluzione del secondo monitor');
    const primary = displays.find((d) => d.primary);
    await S((id) => window.__remotoSession.state.peer.sendCtrl({ t: 'display', id }), primary.id);
    await until(() => S((id) => window.__remotoSession.state.active === id, primary.id), 10_000, 'ritorno al principale');
  }
  await S(() => window.__remotoSession.state.peer.sendCtrl({ t: 'quality', preset: 'speed' }));
  await until(() => S(() => window.__remotoSession.state.quality === 'speed'), 10_000, 'qualità velocità');
  await S(() => window.__remotoSession.state.peer.sendCtrl({ t: 'quality', preset: 'balanced' }));
});

test('riconnessione: va riaccettata, anche dalla finestra principale del PC remoto', async () => {
  await S(() => remoto.send('viewer:disconnect'));
  await until(async () => (await sessionState()) === 'closed', 10_000, 'sessione chiusa');
  await until(() => H(() => globalThis.__remoto.host.list().length === 0), 10_000, 'host libero');
  await sess.click('button:has-text("Riconnetti")');
  await until(async () => (await sessionState()) === 'waiting', 15_000, 'di nuovo in attesa di conferma');
  const hostHome = await windowWith(host.app, 'home/index.html');
  await hostHome.waitForSelector('.request-card button:has-text("Accetta")', { timeout: 10_000 });
  await hostHome.click('.request-card button:has-text("Accetta")');
  await until(async () => (await sessionState()) === 'connected', 30_000, 'riconnessa');
  await until(() => H(({ BrowserWindow }) => !BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes('prompt'))), 5000, 'richiesta chiusa');
  await closeSessionWindow(sess);
});

test('connessione diretta per indirizzo IP con conferma manuale', async () => {
  const port = await H(() => globalThis.__remoto.direct.port);
  const page = await openSession(`127.0.0.1:${port}`);
  const prompt = await windowWith(host.app, 'prompt/prompt.html');
  assert.match(await prompt.textContent('body'), /rete locale/);
  await prompt.click('button:has-text("Accetta")');
  await until(() => page.evaluate(() => window.__remotoSession.state.ui.state === 'connected'), 30_000, 'connessa in LAN');
  assert.equal(await page.evaluate(() => window.__remotoSession.state.ui.route), 'direct');
  const hs = await H(() => globalThis.__remoto.host.list()[0]);
  assert.equal(hs.kind, 'direct');
  assert.equal(hs.verified, false);
  await closeSessionWindow(page);
});

test('modalità solo trasferimento file', async () => {
  const page = await openSession(hostId, 'files');
  const prompt = await windowWith(host.app, 'prompt/prompt.html');
  assert.match(await prompt.textContent('body'), /trasferire file/);
  await prompt.click('button:has-text("Accetta")');
  await until(() => page.evaluate(() => window.__remotoSession.state.ui.state === 'connected'), 30_000, 'connessa');
  await page.waitForSelector('.fm-pane .fm-row:not(.head)', { timeout: 15_000 });
  assert.equal(await page.locator('.fm-pane').count(), 2);
  assert.equal(await page.evaluate(() => document.getElementById('screen').srcObject), null);
  await closeSessionWindow(page);
});

test('richiesta rifiutata dalla finestra di richiesta e dalla finestra principale', async () => {
  const page = await openSession(hostId);
  const prompt = await windowWith(host.app, 'prompt/prompt.html');
  await prompt.click('button:has-text("Rifiuta")');
  await until(() => page.evaluate(() => window.__remotoSession.state.ui.reason === 'declined'), 10_000, 'rifiutata');
  await page.click('button:has-text("Riconnetti")');
  const hostHome = await windowWith(host.app, 'home/index.html');
  await hostHome.waitForSelector('.request-card button:has-text("Rifiuta")', { timeout: 10_000 });
  await hostHome.click('.request-card button:has-text("Rifiuta")');
  await until(() => page.evaluate(() => window.__remotoSession.state.ui.state === 'failed' && window.__remotoSession.state.ui.reason === 'declined'), 10_000, 'rifiutata dalla finestra principale');
  await page.evaluate(() => remoto.send('viewer:close'));
});

test('server ID integrato: una postazione fa da server per l’altra', async () => {
  const net = await import('node:net');
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  await H((_e, p) => globalThis.__remoto.updateConfig({ embeddedServer: { enabled: true, port: p } }), port);
  await until(() => H(() => globalThis.__remoto.status().embedded.running), 10_000, 'server integrato acceso');
  for (const call of [H, V]) await call((_e, p) => globalThis.__remoto.updateConfig({ network: { serverUrl: `127.0.0.1:${p}` } }), port);
  await until(() => H((_e, p) => globalThis.__remoto.link.state === 'online' && globalThis.__remoto.link.url.includes(String(p)), port), 15_000, 'host sul server integrato');
  await until(() => V((_e, p) => globalThis.__remoto.link.state === 'online' && globalThis.__remoto.link.url.includes(String(p)), port), 15_000, 'viewer sul server integrato');
  const page = await openSession(hostId);
  const prompt = await windowWith(host.app, 'prompt/prompt.html');
  assert.match(await prompt.textContent('body'), /verificato dal server/);
  await prompt.click('button:has-text("Accetta")');
  await until(() => page.evaluate(() => window.__remotoSession.state.ui.state === 'connected'), 30_000, 'connessa tramite server integrato');
  assert.equal(await page.evaluate(() => window.__remotoSession.state.ui.route), 'relay');
  await closeSessionWindow(page);
});
