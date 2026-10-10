// Finestra nascosta che gestisce le sessioni in arrivo (una HostPeer per sessione).
import { HostPeer } from './host-peer.js';

const peers = new Map();
window.__peers = peers; // diagnostica e test end-to-end

window.addEventListener('error', (e) => remoto.send('app:log', 'error', `${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => remoto.send('app:log', 'error', String(e.reason?.stack || e.reason)));

remoto.on('engine:start', (info) => {
  const peer = new HostPeer(info);
  peers.set(info.id, peer);
  peer.start().catch((err) => {
    remoto.send('app:log', 'error', `avvio sessione: ${err.stack || err.message}`);
    remoto.send('engine:state', info.id, 'failed', { reason: 'error' });
  });
});

remoto.on('engine:signal', (id, data) => peers.get(id)?.onSignal(data));

remoto.on('engine:stop', (id) => {
  peers.get(id)?.close();
  peers.delete(id);
});

remoto.on('engine:perms', (id, perms) => peers.get(id)?.setPerms(perms));
remoto.on('engine:host-clipboard', (ids, payload) => ids.forEach((id) => peers.get(id)?.sendClipboard(payload)));
remoto.on('engine:host-chat', (id, text) => peers.get(id)?.sendChat(text));
remoto.on('engine:displays-changed', (displays) => peers.forEach((p) => p.displaysChanged(displays).catch(() => {})));
remoto.on('engine:audio-prefs-changed', () => peers.forEach((p) => p.routeMic().catch(() => {})));
// un cavo audio virtuale appena installato (o scollegato): la voce di chi controlla si sposta da sola
navigator.mediaDevices.addEventListener('devicechange', () => peers.forEach((p) => p.routeMic().catch(() => {})));
// controllo completo e desktop protetto (UAC/blocco): valgono per tutte le sessioni attive
remoto.on('engine:caps', (caps) => peers.forEach((p) => p.setCaps(caps)));
remoto.on('engine:secure', (on) => peers.forEach((p) => p.setSecure(Boolean(on))));
remoto.on('engine:secure-frame', (frame) => peers.forEach((p) => p.pushSecureFrame(frame)));

remoto.send('engine:ready');
