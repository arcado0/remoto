// Sonda di latenza (sviluppo): due istanze reali sullo stesso PC e un server in memoria.
//   node test/e2e/dev/latency-probe.mjs [secondi] [carico]
// Misura dove si perde tempo in una sessione:
//   - tempi di avvio (richiesta, accettazione → connessa, primo fotogramma);
//   - host: cattura, codifica, pacer, banda stimata (statistiche WebRTC);
//   - viewer: jitter buffer, decodifica, fotogrammi persi;
//   - latenza "schermo → video": un riquadro sull'host cambia colore ogni 100 ms e il viewer
//     legge il colore dai fotogrammi ricevuti (stesso orologio di sistema);
//   - latenza dell'input (mouse e tastiera): l'iniezione è intercettata, il cursore NON si muove.
// "carico" apre anche una finestra grande con testo che scorre (simula scorrimento/video).
import { createRendezvousServer } from '../../../src/server/core.js';
import { launchRemoto, windowWith, closeRemoto } from '../launch.js';

const SECONDS = Number(process.argv.find((a) => /^\d+$/.test(a))) || 12;
const LOAD = process.argv.includes('carico');
// opzioni di Chromium in più per le due istanze (per gli esperimenti), separate da spazi
const splitArgs = (v) => String(v || '').split(' ').filter(Boolean);
const HOST_ARGS = splitArgs(process.env.PROBE_HOST_ARGS);
const VIEWER_ARGS = splitArgs(process.env.PROBE_VIEWER_ARGS);

async function until(fn, ms = 20_000, label = 'condizione') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout in attesa di: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');

async function hostStats(engine) {
  return engine.evaluate(async () => {
    const p = [...window.__peers.values()][0];
    const st = await p.pc.getStats();
    const o = {};
    st.forEach((r) => {
      if (r.type === 'outbound-rtp' && r.kind === 'video') o.out = r;
      if (r.type === 'media-source' && r.kind === 'video') o.src = r;
      if (r.type === 'transport' && r.selectedCandidatePairId) o.pair = st.get(r.selectedCandidatePairId);
    });
    if (o.out?.codecId) o.codec = st.get(o.out.codecId);
    return JSON.parse(JSON.stringify(o));
  });
}

async function viewerStats(sess) {
  return sess.evaluate(async () => {
    const st = await window.__remotoSession.state.peer.pc.getStats();
    const o = {};
    st.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') o.video = r;
      if (r.type === 'inbound-rtp' && r.kind === 'audio' && (r.packetsReceived || 0) > 0) o.audio = r;
    });
    return JSON.parse(JSON.stringify(o));
  });
}

const server = createRendezvousServer({ port: 0, host: '127.0.0.1' });
const { port } = await server.start();
const url = `ws://127.0.0.1:${port}/ws`;
let host;
let viewer;
let code = 0;
try {
  host = await launchRemoto({ name: 'Sonda host', serverUrl: url, args: HOST_ARGS });
  viewer = await launchRemoto({ name: 'Sonda viewer', serverUrl: url, args: VIEWER_ARGS });
  await until(() => host.app.evaluate(() => globalThis.__remoto?.link.state === 'online'), 30_000, 'host online');
  await until(() => viewer.app.evaluate(() => globalThis.__remoto?.link.state === 'online'), 30_000, 'viewer online');
  const hostId = await host.app.evaluate(() => globalThis.__remoto.identity().id);

  // ---------- avvio della sessione ----------
  // PROBE_DIRECT=1: connessione diretta per indirizzo (come in LAN, senza server); PROBE_NOLAN=1: senza le
  // indicazioni di banda per la LAN (per confronto)
  const direct = process.env.PROBE_DIRECT === '1';
  if (process.env.PROBE_NOLAN === '1') await (await windowWith(host.app, 'engine/engine.html')).evaluate(() => (window.__lanBitrates = false));
  const target = direct ? `127.0.0.1:${await host.app.evaluate(() => globalThis.__remoto.direct.port)}` : hostId;
  const before = new Set(viewer.app.windows());
  const home = await windowWith(viewer.app, 'home/index.html');
  await home.fill('.connect-input input', target);
  const t0 = Date.now();
  await home.click('button:has-text("Connetti")');
  const sess = await until(() => viewer.app.windows().find((w) => !before.has(w) && w.url().includes('session/session.html')), 15_000, 'finestra di sessione');
  await sess.waitForFunction(() => window.__remotoSession);
  const prompt = await windowWith(host.app, 'prompt/prompt.html');
  const tPrompt = Date.now();
  await prompt.click('button:has-text("Accetta")');
  const tAccept = Date.now();
  await until(() => sess.evaluate(() => window.__remotoSession.state.ui.state === 'connected'), 30_000, 'sessione connessa');
  const tConnected = Date.now();
  await until(() => sess.evaluate(() => document.getElementById('screen').videoWidth > 0), 20_000, 'primo fotogramma');
  const tVideo = Date.now();
  const engine = await windowWith(host.app, 'engine/engine.html');

  // ---------- riquadro colorato sull'host (e, con "carico", testo che scorre) ----------
  const patch = await host.app.evaluate(({ BrowserWindow, screen }, load) => {
    const d = screen.getPrimaryDisplay();
    const size = 96;
    const x = d.workArea.x + 24;
    const y = d.workArea.y + 24;
    const html = `<!doctype html><html><body style="margin:0;background:#000"><script>
      const C=['#000000','#ff0000','#00ff00','#0000ff','#ffff00','#ff00ff','#00ffff','#ffffff'];
      let last=-1;
      function tick(){const k=Math.floor(Date.now()/100)%8;if(k!==last){last=k;document.body.style.background=C[k];}requestAnimationFrame(tick);}
      tick();
    </script></body></html>`;
    const opts = { frame: false, alwaysOnTop: true, focusable: false, skipTaskbar: true, resizable: false, show: true, webPreferences: { backgroundThrottling: false } };
    const w = new BrowserWindow({ ...opts, x, y, width: size, height: size });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setIgnoreMouseEvents(true);
    w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    globalThis.__probeWins = [w];
    if (load) {
      const lines = Array.from({ length: 400 }, (_, i) => `<div>${i} Lorem ipsum dolor sit amet, consectetur adipiscing elit — riga di prova per lo scorrimento ${i * 7919}</div>`).join('');
      const html2 = `<!doctype html><html><body style="margin:0;overflow:hidden;font:15px Segoe UI;background:#fff;color:#123"><div id=t>${lines}</div><script>
        const t=document.getElementById('t');function f(ts){t.style.transform='translateY('+(-(ts/4)%6000)+'px)';requestAnimationFrame(f);}requestAnimationFrame(f);
      </script></body></html>`;
      const w2 = new BrowserWindow({ ...opts, x: x + size + 24, y, width: Math.min(1400, d.workArea.width - size - 96), height: Math.min(800, d.workArea.height - 96) });
      w2.setIgnoreMouseEvents(true);
      w2.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html2)}`);
      globalThis.__probeWins.push(w2);
    }
    const phys = screen.dipToScreenPoint({ x: x + size / 2, y: y + size / 2 });
    const dp = screen.dipToScreenRect(null, d.bounds);
    return { cx: phys.x - dp.x, cy: phys.y - dp.y, w: dp.width, h: dp.height, ax: phys.x, ay: phys.y };
  }, LOAD);
  console.log(`riquadro al pixel fisico ${patch.ax},${patch.ay}`);
  // PROBE_QUALITY=quality|balanced|speed: preset scelto dal viewer
  if (process.env.PROBE_QUALITY) {
    await sess.evaluate((preset) => window.__remotoSession.state.peer.sendCtrl({ t: 'quality', preset }), process.env.PROBE_QUALITY);
    await sleep(500);
  }
  // esperimenti sull'host: tipo di contenuto (PROBE_HINT) e fotogrammi al secondo (PROBE_FPS)
  const hint = process.env.PROBE_HINT || '';
  const fps = Number(process.env.PROBE_FPS) || 0;
  if (hint || fps) {
    await engine.evaluate(
      async ({ hint, fps }) => {
        const p = [...window.__peers.values()][0];
        if (fps) {
          const s = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: p.active.sourceId, maxWidth: p.active.width, maxHeight: p.active.height, maxFrameRate: fps } },
          });
          const t = s.getVideoTracks()[0];
          t.contentHint = hint || p.videoTrack.contentHint;
          await p.videoSender.replaceTrack(t);
          p.videoTrack.onended = null;
          p.videoTrack.stop();
          p.videoTrack = t;
        } else p.videoTrack.contentHint = hint;
        const params = p.videoSender.getParameters();
        if (fps) params.encodings[0].maxFramerate = fps;
        if (hint) params.degradationPreference = 'maintain-resolution';
        await p.videoSender.setParameters(params);
      },
      { hint, fps },
    );
  }
  await sleep(1500);

  await sess.evaluate(({ cx, cy, w, h }) => {
    const v = document.getElementById('screen');
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 4;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const C = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255], [255, 255, 255]];
    const out = (window.__probe = { samples: [], frames: 0, stop: false });
    let prev = -1;
    const step = (now, meta) => {
      out.frames++;
      const sx = Math.round((cx * v.videoWidth) / w) - 2;
      const sy = Math.round((cy * v.videoHeight) / h) - 2;
      ctx.drawImage(v, sx, sy, 4, 4, 0, 0, 4, 4);
      const px = ctx.getImageData(0, 0, 4, 4).data;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = 0; i < px.length; i += 4) {
        r += px[i];
        g += px[i + 1];
        b += px[i + 2];
      }
      r /= 16;
      g /= 16;
      b /= 16;
      let k = 0;
      let best = 1e9;
      C.forEach((cc, i) => {
        const dd = (cc[0] - r) ** 2 + (cc[1] - g) ** 2 + (cc[2] - b) ** 2;
        if (dd < best) {
          best = dd;
          k = i;
        }
      });
      const abs = (t) => (t != null ? performance.timeOrigin + t : null);
      if (k !== prev && best < 9000) {
        out.samples.push({ k, seen: abs(meta.expectedDisplayTime ?? now), recv: abs(meta.receiveTime), cap: abs(meta.captureTime), proc: meta.processingDuration ?? null });
        prev = k;
      }
      if (!out.stop) v.requestVideoFrameCallback(step);
    };
    v.requestVideoFrameCallback(step);
  }, patch);

  // stessa lettura del riquadro sulla traccia catturata, ma in locale sull'host (senza codifica né rete):
  // separa il ritardo della cattura di Chromium da quello di codifica, trasmissione e visualizzazione
  await engine.evaluate(({ cx, cy, w, h }) => {
    const p = [...window.__peers.values()][0];
    const v = document.createElement('video');
    v.muted = true;
    v.srcObject = new MediaStream([p.videoTrack]);
    document.body.append(v);
    v.play();
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 4;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const C = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255], [255, 255, 255]];
    const out = (window.__localProbe = { samples: [], stop: false });
    let prev = -1;
    const step = (now, meta) => {
      if (v.videoWidth) {
        ctx.drawImage(v, Math.round((cx * v.videoWidth) / w) - 2, Math.round((cy * v.videoHeight) / h) - 2, 4, 4, 0, 0, 4, 4);
        const px = ctx.getImageData(0, 0, 4, 4).data;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = 0; i < px.length; i += 4) {
          r += px[i];
          g += px[i + 1];
          b += px[i + 2];
        }
        let k = 0;
        let best = 1e9;
        C.forEach((cc, i) => {
          const dd = (cc[0] - r / 16) ** 2 + (cc[1] - g / 16) ** 2 + (cc[2] - b / 16) ** 2;
          if (dd < best) {
            best = dd;
            k = i;
          }
        });
        if (k !== prev && best < 9000) {
          out.samples.push({ k, seen: performance.timeOrigin + (meta.expectedDisplayTime ?? now), cap: meta.captureTime != null ? performance.timeOrigin + meta.captureTime : null });
          prev = k;
        }
      }
      if (!out.stop) v.requestVideoFrameCallback(step);
    };
    v.requestVideoFrameCallback(step);
  }, patch);

  // ---------- statistiche nel periodo di misura ----------
  const h0 = await hostStats(engine);
  const v0 = await viewerStats(sess);
  const perSecond = [];
  for (let i = 0; i < SECONDS; i++) {
    await sleep(1000);
    const hs = await hostStats(engine);
    const vs = await viewerStats(sess);
    perSecond.push({
      sentFps: hs.out?.framesPerSecond ?? 0,
      capFps: hs.src?.framesPerSecond ?? 0,
      recvFps: vs.video?.framesPerSecond ?? 0,
      res: `${hs.out?.frameWidth || 0}x${hs.out?.frameHeight || 0}`,
      limit: hs.out?.qualityLimitationReason,
      target: hs.out?.targetBitrate,
      avail: hs.pair?.availableOutgoingBitrate,
    });
  }
  const h1 = await hostStats(engine);
  const trackSettings = await engine.evaluate(() => {
    const t = [...window.__peers.values()][0].videoTrack.getSettings();
    return { w: t.width, h: t.height, fps: t.frameRate, hint: [...window.__peers.values()][0].videoTrack.contentHint };
  });
  const v1 = await viewerStats(sess);
  const samples = await sess.evaluate(() => {
    window.__probe.stop = true;
    return window.__probe;
  });
  const localSamples = await engine.evaluate(() => {
    window.__localProbe.stop = true;
    return window.__localProbe;
  });

  // ---------- input: mouse (canale non affidabile) e tastiera (canale ordinato) ----------
  await host.app.evaluate(() => {
    const inj = globalThis.__remoto.hostSide.input;
    globalThis.__probeIn = { mm: [], k: [] };
    inj.move = (_rect, x) => {
      globalThis.__probeIn.mm.push([x, Date.now()]);
      return 1;
    };
    inj.key = () => {
      globalThis.__probeIn.k.push(Date.now());
      return 1;
    };
  });
  const sent = await sess.evaluate(async () => {
    const peer = window.__remotoSession.state.peer;
    const mm = [];
    const k = [];
    for (let i = 1; i <= 60; i++) {
      peer.sendMove({ t: 'mm', x: i, y: 0 });
      mm.push([i, performance.timeOrigin + performance.now()]);
      peer.sendCtrl({ t: 'k', c: 'F24', d: i % 2 === 1 });
      k.push(performance.timeOrigin + performance.now());
      await new Promise((r) => setTimeout(r, 25));
    }
    return { mm, k };
  });
  await sleep(500);
  const arrived = await host.app.evaluate(() => globalThis.__probeIn);

  // ---------- resoconto ----------
  const d = (a, b, k) => (b?.[k] ?? 0) - (a?.[k] ?? 0);
  const o0 = h0.out || {};
  const o1 = h1.out || {};
  const enc = d(o0, o1, 'framesEncoded');
  const vv0 = v0.video || {};
  const vv1 = v1.video || {};
  const dec = d(vv0, vv1, 'framesDecoded');
  const emitted = d(vv0, vv1, 'jitterBufferEmittedCount');
  const aud0 = v0.audio || {};
  const aud1 = v1.audio || {};
  const audEmitted = d(aud0, aud1, 'jitterBufferEmittedCount');

  const lat = [];
  const net = [];
  const rx = [];
  for (const s of samples.samples.slice(1)) {
    const n = Math.floor(s.seen / 100);
    const T = (n - (((n - s.k) % 8) + 8) % 8) * 100;
    lat.push(s.seen - T);
    if (s.cap != null && s.recv != null) net.push(s.recv - s.cap);
    if (s.recv != null) rx.push(s.seen - s.recv);
  }
  const localLat = [];
  const localCap = [];
  for (const s of localSamples.samples.slice(1)) {
    const n = Math.floor(s.seen / 100);
    const T = (n - (((n - s.k) % 8) + 8) % 8) * 100;
    localLat.push(s.seen - T);
    if (s.cap != null) localCap.push(s.cap - T);
  }
  const mmLat = [];
  const byX = new Map(arrived.mm.map(([x, t]) => [x, t]));
  for (const [x, t] of sent.mm) if (byX.has(x)) mmLat.push(byX.get(x) - t);
  const kLat = arrived.k.map((t, i) => t - sent.k[i]).filter(Number.isFinite);

  console.log(`\n=== Sonda di latenza (${SECONDS} s${LOAD ? ', con carico' : ''}) ===`);
  console.log(`Avvio: richiesta visibile ${tPrompt - t0} ms · accettata→connessa ${tConnected - tAccept} ms · →primo fotogramma ${tVideo - tConnected} ms`);
  console.log(`Codec ${h1.codec?.mimeType} [${h1.codec?.sdpFmtpLine || ''}]`);
  console.log(`Encoder ${o1.encoderImplementation} (hw: ${o1.powerEfficientEncoder}) · decoder ${vv1.decoderImplementation} (hw: ${vv1.powerEfficientDecoder})`);
  console.log(`Risoluzione inviata ${o1.frameWidth}x${o1.frameHeight} · sorgente ${h1.src?.width}x${h1.src?.height}`);
  console.log(`QP medio ${fmt(d(o0, o1, 'qpSum') / enc)} (più basso = più nitido) · traccia ${JSON.stringify(trackSettings)}`);
  console.log(`Codifica media ${fmt((d(o0, o1, 'totalEncodeTime') / enc) * 1000)} ms/fotogramma · pacer ${fmt((d(o0, o1, 'totalPacketSendDelay') / d(o0, o1, 'packetsSent')) * 1000)} ms/pacchetto`);
  console.log(`Limitazione qualità: ${o1.qualityLimitationReason} ${JSON.stringify(o1.qualityLimitationDurations || {})}`);
  console.log(`Fotogrammi: codificati ${enc} (${fmt(enc / SECONDS)} fps) · decodificati ${dec} · persi ${d(vv0, vv1, 'framesDropped')} · freeze ${d(vv0, vv1, 'freezeCount')}`);
  console.log(`Viewer: jitter buffer ${fmt((d(vv0, vv1, 'jitterBufferDelay') / emitted) * 1000)} ms (obiettivo ${fmt((d(vv0, vv1, 'jitterBufferTargetDelay') / emitted) * 1000)} ms, minimo ${fmt((d(vv0, vv1, 'jitterBufferMinimumDelay') / emitted) * 1000)} ms) · decodifica ${fmt((d(vv0, vv1, 'totalDecodeTime') / dec) * 1000)} ms · elaborazione ${fmt((d(vv0, vv1, 'totalProcessingDelay') / dec) * 1000)} ms`);
  if (audEmitted) console.log(`Audio: jitter buffer ${fmt((d(aud0, aud1, 'jitterBufferDelay') / audEmitted) * 1000)} ms (obiettivo ${fmt((d(aud0, aud1, 'jitterBufferTargetDelay') / audEmitted) * 1000)} ms)`);
  console.log(`Banda: inviata ${fmt((d(o0, o1, 'bytesSent') * 8) / SECONDS / 1e6, 2)} Mbit/s · stimata ${fmt((h1.pair?.availableOutgoingBitrate || 0) / 1e6, 2)} Mbit/s · obiettivo ${fmt((o1.targetBitrate || 0) / 1e6, 2)} Mbit/s · RTT ${fmt((h1.pair?.currentRoundTripTime || 0) * 1000)} ms`);
  console.log(`NACK ${d(o0, o1, 'nackCount')} · PLI ${d(o0, o1, 'pliCount')} · keyframe ${d(o0, o1, 'keyFramesEncoded')}`);
  console.log(`Schermo→video (${lat.length} campioni): mediana ${fmt(pct(lat, 50), 0)} ms · p90 ${fmt(pct(lat, 90), 0)} ms · max ${fmt(Math.max(...lat), 0)} ms`);
  if (net.length) console.log(`  di cui cattura→ricezione: mediana ${fmt(pct(net, 50), 0)} ms · ricezione→schermo: mediana ${fmt(pct(rx, 50), 0)} ms`);
  console.log(`Cattura locale sull'host (${localLat.length} campioni): schermo→video locale mediana ${fmt(pct(localLat, 50), 0)} ms · p90 ${fmt(pct(localLat, 90), 0)} ms${localCap.length ? ` · schermo→timestamp di cattura mediana ${fmt(pct(localCap, 50), 0)} ms` : ''}`);
  console.log(`Input mouse (${mmLat.length}/60 arrivati): mediana ${fmt(pct(mmLat, 50))} ms · p90 ${fmt(pct(mmLat, 90))} ms`);
  console.log(`Input tastiera (${kLat.length}/60): mediana ${fmt(pct(kLat, 50))} ms · p90 ${fmt(pct(kLat, 90))} ms`);
  console.log('Al secondo:');
  for (const s of perSecond) console.log(`  cattura ${s.capFps} · inviati ${s.sentFps} · ricevuti ${s.recvFps} fps · ${s.res} · ${s.limit} · obiettivo ${fmt((s.target || 0) / 1e6, 2)} / stimata ${fmt((s.avail || 0) / 1e6, 2)} Mbit/s`);
} catch (err) {
  console.error('ERRORE:', err.stack || err.message);
  code = 1;
} finally {
  if (process.env.PROBE_LOGS && host) {
    const re = new RegExp(process.env.PROBE_LOGS, 'i');
    const lines = host.logs.join('').split(/\r?\n/).filter((l) => re.test(l));
    console.log(`--- log host filtrati (${lines.length}) ---`);
    for (const l of lines.slice(0, 60)) console.log(l.slice(0, 300));
  }
  await host?.app.evaluate(() => globalThis.__probeWins?.forEach((w) => !w.isDestroyed() && w.destroy())).catch(() => {});
  await closeRemoto(viewer);
  await closeRemoto(host);
  await server.stop();
}
process.exit(code);
