// Costanti e validazioni comuni a server, main e renderer.

export const APP_NAME = 'Remoto';
export const PROTOCOL_VERSION = 1;

export const DEFAULT_PORTS = Object.freeze({ server: 47800, direct: 47801, discovery: 47802 });

export const LIMITS = Object.freeze({
  maxServerMessage: 64 * 1024,
  maxDirectMessage: 256 * 1024,
  maxNameLength: 48,
  maxQueryIds: 200,
  maxChatLength: 4000,
  maxClipboardText: 1024 * 1024,
  maxClipboardImage: 16 * 1024 * 1024,
});

export const TIMEOUTS = Object.freeze({
  pendingMs: 90_000,
  promptMs: 60_000,
  negotiationMs: 30_000,
  directHelloMs: 5_000,
});

export const DEFAULT_STUN = Object.freeze(['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']);

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function safeParse(text) {
  try {
    const v = JSON.parse(text);
    return isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
}

export function sanitizeName(name, fallback = 'Postazione') {
  const s = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '')
    .trim()
    .slice(0, LIMITS.maxNameLength);
  return s || fallback;
}

export function isValidSid(sid) {
  return typeof sid === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(sid);
}

export function newSid() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function isValidSecret(secret) {
  return typeof secret === 'string' && /^[0-9a-f]{32,128}$/.test(secret);
}

/** Motivi di rifiuto/chiusura con il testo da mostrare all'utente. */
export const REASONS = Object.freeze({
  declined: 'La richiesta è stata rifiutata dalla postazione remota.',
  timeout: 'La postazione remota non ha risposto in tempo.',
  busy: 'La postazione remota ha già il numero massimo di sessioni attive.',
  disabled: 'La postazione remota non accetta connessioni in arrivo.',
  acl: 'Il tuo ID non è autorizzato su questa postazione.',
  offline: 'La postazione remota non è online.',
  unreachable: 'Impossibile raggiungere la postazione remota. Controlla che Remoto sia aperto sull’altro PC e che i due PC siano sulla stessa rete (o che l’indirizzo sia giusto).',
  'lan-blocked': 'La postazione si vede in rete locale ma non accetta la connessione: probabilmente il firewall, l’antivirus o la VPN dell’altro PC blocca Remoto. Prova a collegarti nel verso opposto, oppure configura un server ID.',
  'connection-lost': 'La connessione si è interrotta. Se succede subito dopo la richiesta, un antivirus, un firewall o la VPN di uno dei due PC sta probabilmente bloccando Remoto.',
  'no-server': 'Nessun server ID connesso e postazione non trovata in rete locale.',
  self: 'Non puoi connetterti alla tua stessa postazione.',
  'rate-limited': 'Troppe richieste in poco tempo: riprova tra qualche istante.',
  'webrtc-failed': 'Connessione diretta non riuscita (rete o firewall). Configura un server TURN.',
  ended: 'Sessione terminata.',
  'host-closed': 'La postazione remota ha chiuso la sessione.',
  'viewer-closed': 'La sessione è stata chiusa.',
  restart: 'La postazione remota si sta riavviando.',
  error: 'Errore sulla postazione remota.',
  version: 'Versione del protocollo non compatibile.',
  invalid: 'Richiesta non valida.',
});

export function reasonText(code) {
  return REASONS[code] || REASONS.error;
}

/** Normalizza l'indirizzo del server inserito dall'utente in un URL ws(s)://. */
export function normalizeServerUrl(input, defaultPort = DEFAULT_PORTS.server) {
  let s = String(input ?? '').trim();
  if (!s) return '';
  if (!/^wss?:\/\//i.test(s)) {
    if (/^https:\/\//i.test(s)) s = 'wss://' + s.slice(8);
    else if (/^http:\/\//i.test(s)) s = 'ws://' + s.slice(7);
    else s = 'ws://' + s;
  }
  let url;
  try {
    url = new URL(s);
  } catch {
    return '';
  }
  if (!url.hostname) return '';
  if (!url.port && url.protocol === 'ws:') url.port = String(defaultPort);
  if (url.pathname === '/' || !url.pathname) url.pathname = '/ws';
  return url.toString();
}

/** Server ICE nel formato WebRTC: voci malformate farebbero fallire RTCPeerConnection. */
export function sanitizeIceServers(list) {
  if (!Array.isArray(list)) return [];
  const okUrl = (u) => typeof u === 'string' && /^(stun|stuns|turn|turns):[^\s]+$/i.test(u);
  return list
    .filter((s) => s && typeof s === 'object')
    .map((s) => {
      const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(okUrl);
      if (!urls.length) return null;
      const out = { urls };
      if (typeof s.username === 'string') out.username = s.username.slice(0, 256);
      if (typeof s.credential === 'string') out.credential = s.credential.slice(0, 256);
      return out;
    })
    .filter(Boolean)
    .slice(0, 10);
}
