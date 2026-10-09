// Registrazione della sessione in WebM (video + audio remoto), scritta su disco a blocchi.

function pickMime() {
  for (const m of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

export class Recorder {
  constructor(stream) {
    this.stream = stream;
    this.rec = null;
    this.handle = null;
    this.chain = Promise.resolve();
    this.startedAt = 0;
  }

  get active() {
    return Boolean(this.rec && this.rec.state !== 'inactive');
  }

  async start() {
    this.handle = await remoto.invoke('viewer:rec-open', 'webm');
    const mimeType = pickMime();
    this.rec = new MediaRecorder(this.stream, { mimeType, videoBitsPerSecond: 8_000_000 });
    this.rec.ondataavailable = (e) => {
      if (!e.data?.size) return;
      const blob = e.data;
      this.chain = this.chain.then(async () => remoto.send('viewer:rec-write', this.handle, await blob.arrayBuffer()));
    };
    this.rec.start(1000);
    this.startedAt = Date.now();
  }

  async stop() {
    if (!this.rec) return null;
    const stopped = new Promise((r) => this.rec.addEventListener('stop', r, { once: true }));
    if (this.rec.state !== 'inactive') this.rec.stop();
    await stopped;
    await this.chain;
    const file = await remoto.invoke('viewer:rec-close', this.handle);
    this.rec = null;
    this.handle = null;
    return file;
  }
}
