// Piccole letture dell'SDP di WebRTC.

/**
 * mid della sezione audio che l'host vuole solo ricevere (a=recvonly): è il canale del microfono
 * di chi si collega. Il viewer la trasforma in "sendonly" prima di rispondere.
 */
export function recvonlyAudioMid(sdp) {
  const sections = String(sdp || '').split(/\r?\nm=/).slice(1);
  for (const sec of sections) {
    if (!sec.startsWith('audio')) continue;
    if (!/\r?\na=recvonly\b/.test(sec)) continue;
    const m = sec.match(/\r?\na=mid:(\S+)/);
    if (m) return m[1];
  }
  return null;
}

const VIDEO_CODECS = /^(H264|H265|VP8|VP9|AV1)$/i;

/**
 * Indicazioni di banda per il video, nei parametri `x-google-*` che Chromium legge dalle righe a=fmtp
 * dei codec (si mettono nella risposta prima di applicarla sul lato che invia). In LAN la stima di banda
 * parte da ~300 kbit/s e col Wi-Fi scende a ogni oscillazione del ritardo: l'encoder resta senza banda e
 * scarta fotogrammi. Un valore di partenza e un minimo più alti lo evitano.
 * @param {string} sdp
 * @param {{startKbps?: number, minKbps?: number, maxKbps?: number}} rates
 */
export function withVideoBitrates(sdp, { startKbps, minKbps, maxKbps } = {}) {
  const params = [
    startKbps > 0 && `x-google-start-bitrate=${Math.round(startKbps)}`,
    minKbps > 0 && `x-google-min-bitrate=${Math.round(minKbps)}`,
    maxKbps > 0 && `x-google-max-bitrate=${Math.round(maxKbps)}`,
  ].filter(Boolean);
  const text = String(sdp || '');
  if (!params.length || !text) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const out = [];
  let section = [];
  const flush = () => {
    if (section.length && /^m=video /.test(section[0])) {
      const pts = new Set();
      for (const l of section) {
        const m = /^a=rtpmap:(\d+) ([^/]+)\//.exec(l);
        if (m && VIDEO_CODECS.test(m[2])) pts.add(m[1]);
      }
      const withFmtp = new Set();
      section = section.map((l) => {
        const m = /^a=fmtp:(\d+) (.*)$/.exec(l);
        if (!m || !pts.has(m[1])) return l;
        withFmtp.add(m[1]);
        const kept = m[2].split(';').filter((p) => p && !/^x-google-(start|min|max)-bitrate=/.test(p.trim()));
        return `a=fmtp:${m[1]} ${[...kept, ...params].join(';')}`;
      });
      // codec senza riga a=fmtp (es. VP8): la si aggiunge subito dopo il suo a=rtpmap
      const done = [];
      for (const l of section) {
        done.push(l);
        const m = /^a=rtpmap:(\d+) /.exec(l);
        if (m && pts.has(m[1]) && !withFmtp.has(m[1])) done.push(`a=fmtp:${m[1]} ${params.join(';')}`);
      }
      section = done;
    }
    out.push(...section);
    section = [];
  };
  for (const l of lines) {
    if (l.startsWith('m=')) flush();
    section.push(l);
  }
  flush();
  return out.join(eol);
}
