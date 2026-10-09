// Appunti sul canale "file": il contenuto (testo o PNG in base64) viaggia a pezzi da 192 KB,
// così anche un'immagine grande non blocca i comandi di mouse e tastiera sul canale "ctrl".

const PART = 192 * 1024;

export function sendClipboard(channel, payload) {
  if (!payload || channel.readyState !== 'open') return false;
  const id = Math.random().toString(36).slice(2, 10);
  const data = String(payload.data);
  const n = Math.max(1, Math.ceil(data.length / PART));
  for (let i = 0; i < n; i++) {
    channel.send(JSON.stringify({ t: 'clip', id, i, n, kind: payload.kind, data: data.slice(i * PART, (i + 1) * PART) }));
  }
  return true;
}

export class ClipboardAssembler {
  constructor(onPayload, maxBytes = 24 * 1024 * 1024) {
    this.onPayload = onPayload;
    this.maxBytes = maxBytes;
    this.parts = new Map();
  }

  add(msg) {
    if (msg.t !== 'clip' || typeof msg.data !== 'string' || !(msg.n >= 1 && msg.n <= 200)) return;
    let p = this.parts.get(msg.id);
    if (!p) {
      p = { n: msg.n, kind: msg.kind, chunks: [], size: 0 };
      this.parts.set(msg.id, p);
      if (this.parts.size > 4) this.parts.delete(this.parts.keys().next().value);
    }
    p.chunks[msg.i] = msg.data;
    p.size += msg.data.length;
    if (p.size > this.maxBytes) {
      this.parts.delete(msg.id);
      return;
    }
    if (p.chunks.filter((x) => x !== undefined).length === p.n) {
      this.parts.delete(msg.id);
      if (p.kind === 'text' || p.kind === 'image') this.onPayload({ kind: p.kind, data: p.chunks.join('') });
    }
  }
}
