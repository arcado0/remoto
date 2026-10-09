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
