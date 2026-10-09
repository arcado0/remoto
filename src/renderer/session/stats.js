// Statistiche della connessione (FPS, bitrate, RTT, tipo di collegamento) da getStats().
import { formatBitrate } from '../../shared/format.js';
import { classifyPair, selectedPair } from '../../shared/netinfo.js';

export const CONN_LABELS = { lan: 'LAN diretta', p2p: 'P2P Internet', relay: 'Relay TURN', '': '—' };

export class StatsProbe {
  constructor(pc) {
    this.pc = pc;
    this.prev = null;
  }

  async sample() {
    const stats = await this.pc.getStats();
    const out = { fps: 0, width: 0, height: 0, bitrate: 0, rtt: null, lost: 0, codec: '', decoder: '', conn: '', jitter: null };
    let video = null;
    stats.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') video = r;
    });
    const sel = selectedPair(stats);
    if (video) {
      out.fps = Math.round(video.framesPerSecond || 0);
      out.width = video.frameWidth || 0;
      out.height = video.frameHeight || 0;
      out.lost = video.packetsLost || 0;
      out.jitter = video.jitter != null ? Math.round(video.jitter * 1000) : null;
      out.decoder = video.decoderImplementation || '';
      out.codec = (stats.get(video.codecId)?.mimeType || '').replace('video/', '');
      const now = video.timestamp;
      if (this.prev && now > this.prev.ts) out.bitrate = ((video.bytesReceived - this.prev.bytes) * 8 * 1000) / (now - this.prev.ts);
      this.prev = { ts: now, bytes: video.bytesReceived };
    }
    if (sel) {
      out.rtt = sel.pair.currentRoundTripTime != null ? Math.round(sel.pair.currentRoundTripTime * 1000) : null;
      out.conn = classifyPair(sel.local, sel.remote);
    }
    return out;
  }
}

export function statsRows(s) {
  return [
    ['Collegamento', CONN_LABELS[s.conn] || '—'],
    ['Latenza (RTT)', s.rtt != null ? `${s.rtt} ms` : '—'],
    ['Fotogrammi', s.fps ? `${s.fps} fps` : '—'],
    ['Risoluzione', s.width ? `${s.width}×${s.height}` : '—'],
    ['Banda', s.bitrate ? formatBitrate(s.bitrate) : '—'],
    ['Codec', s.codec || '—'],
    s.decoder ? ['Decoder', s.decoder] : null,
    ['Pacchetti persi', String(s.lost)],
    ['Jitter', s.jitter != null ? `${s.jitter} ms` : '—'],
  ].filter(Boolean);
}
