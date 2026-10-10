// Collaudo: con le casse dell'host silenziate (mute di Windows), l'audio di sistema arriva ancora a chi
// controlla? Il tono parte da un altro processo (PowerShell) con le casse già silenziate: non si sente.
//   node test/e2e/dev/audio-mute-check.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRendezvousServer } from '../../../src/server/core.js';
import { launchRemoto, windowWith, closeRemoto } from '../launch.js';

const until = async (fn, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
};

/** WAV con un tono a 440 Hz. */
function toneWav(file, seconds = 4) {
  const rate = 48000;
  const n = rate * seconds;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), 44 + i * 2);
  fs.writeFileSync(file, b);
}

const audioPower = (sess) =>
  sess.evaluate(async () => {
    let a = null;
    (await window.__remotoSession.state.peer.pc.getStats()).forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio' && (r.packetsReceived || 0) > 0 && r.totalSamplesDuration > 0) a = r;
    });
    return a ? { e: a.totalAudioEnergy, d: a.totalSamplesDuration } : null;
  });

async function measure(sess, ms) {
  const a = await audioPower(sess);
  await new Promise((r) => setTimeout(r, ms));
  const b = await audioPower(sess);
  return a && b ? (b.e - a.e) / Math.max(1e-6, b.d - a.d) : NaN;
}

const wav = path.join(os.tmpdir(), 'remoto-tono.wav');
toneWav(wav);
const server = createRendezvousServer({ port: 0, host: '127.0.0.1' });
const { port } = await server.start();
const url = `ws://127.0.0.1:${port}/ws`;
const host = await launchRemoto({ name: 'Host audio', serverUrl: url });
const viewer = await launchRemoto({ name: 'Viewer audio', serverUrl: url });
let restore = null;
try {
  await until(() => host.app.evaluate(() => globalThis.__remoto?.link.state === 'online'), 30_000);
  await until(() => viewer.app.evaluate(() => globalThis.__remoto?.link.state === 'online'), 30_000);
  const hostId = await host.app.evaluate(() => globalThis.__remoto.identity().id);
  const before = new Set(viewer.app.windows());
  const home = await windowWith(viewer.app, 'home/index.html');
  await home.fill('.connect-input input', hostId);
  await home.click('button:has-text("Connetti")');
  const sess = await until(() => viewer.app.windows().find((w) => !before.has(w) && w.url().includes('session/session.html')));
  await sess.waitForFunction(() => window.__remotoSession);
  const prompt = await windowWith(host.app, 'prompt/prompt.html');
  await prompt.click('button:has-text("Accetta")');
  await until(() => sess.evaluate(() => window.__remotoSession.state.ui.state === 'connected'), 30_000);
  await until(() => sess.evaluate(() => window.__remotoSession.state.hello?.audio === true), 10_000);
  await new Promise((r) => setTimeout(r, 1500));

  const def = await host.app.evaluate(() => globalThis.__remoto.hostSide.audio.devices.listDevices('render').find((x) => x.isDefault));
  console.log(`casse predefinite: ${def.name} (silenziate: ${def.muted})`);
  const setMuted = (muted) => host.app.evaluate((_e, a) => globalThis.__remoto.hostSide.audio.devices.setMuted(a.id, a.muted), { id: def.id, muted });
  restore = () => setMuted(def.muted);

  // spettro dell'audio ricevuto: il tono a 440 Hz si riconosce anche sopra altri suoni in riproduzione
  await sess.evaluate(() => {
    const v = document.getElementById('screen');
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(new MediaStream(v.srcObject.getAudioTracks()));
    const an = ctx.createAnalyser();
    an.fftSize = 8192;
    src.connect(an);
    window.__tone = () => {
      const bins = new Float32Array(an.frequencyBinCount);
      an.getFloatFrequencyData(bins);
      const hz = ctx.sampleRate / an.fftSize;
      const at = (f) => bins[Math.round(f / hz)];
      const around = [300, 350, 380, 500, 530, 600].map(at);
      return { peak: at(440), around: Math.max(...around) };
    };
  });
  const tone = () => sess.evaluate(() => window.__tone());
  const quietTone = await tone();
  const quiet = await measure(sess, 1500);
  await setMuted(true);
  const ps = spawn('powershell.exe', ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${wav}').PlaySync()`], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 700));
  const muted = await measure(sess, 1200);
  const mutedTone = await tone();
  await new Promise((r) => ps.on('exit', r));
  await restore();
  restore = null;
  console.log(`potenza audio ricevuta: prima ${quiet.toExponential(2)} · con casse silenziate ${muted.toExponential(2)}`);
  console.log(`440 Hz prima: ${quietTone.peak.toFixed(1)} dB (vicine ${quietTone.around.toFixed(1)}) · con casse silenziate e tono: ${mutedTone.peak.toFixed(1)} dB (vicine ${mutedTone.around.toFixed(1)})`);
  const heard = mutedTone.peak - mutedTone.around > 15 && mutedTone.peak - quietTone.peak > 15;
  console.log(heard ? 'RISULTATO: il tono arriva anche con le casse silenziate' : 'RISULTATO: con le casse silenziate il tono NON arriva');
} catch (err) {
  console.error('ERRORE', err.stack || err.message);
} finally {
  if (restore) await restore().catch(() => {});
  await closeRemoto(viewer);
  await closeRemoto(host);
  await server.stop();
  fs.rmSync(wav, { force: true });
}
