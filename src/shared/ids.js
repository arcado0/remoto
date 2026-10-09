// Identificativi delle postazioni (9 cifre, come AnyDesk) e interpretazione di "ID o indirizzo".

export const ID_LENGTH = 9;

function randomInt(n) {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / n) * n;
  do globalThis.crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % n;
}

/** Nuovo ID casuale a 9 cifre; la prima cifra non e' mai 0. */
export function generateId(rand = randomInt) {
  let id = String(1 + rand(9));
  for (let i = 1; i < ID_LENGTH; i++) id += String(rand(10));
  return id;
}

export function isValidId(id) {
  return typeof id === 'string' && /^[1-9]\d{8}$/.test(id);
}

/** Accetta "123 456 789", "123-456-789", "123456789"; restituisce l'ID pulito o null. */
export function normalizeId(input) {
  // niente punto tra i separatori: "192.168.1.10" ha 9 cifre ma e' un indirizzo IP
  const s = String(input ?? '').replace(/[\s-]/g, '');
  return isValidId(s) ? s : null;
}

export function formatId(id) {
  return isValidId(id) ? `${id.slice(0, 3)} ${id.slice(3, 6)} ${id.slice(6)}` : String(id ?? '');
}

/**
 * Interpreta il testo digitato nella barra "postazione remota".
 * @returns {{kind:'id', id:string} | {kind:'address', host:string, port:number} | null}
 */
export function parseTarget(input, defaultPort) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const id = normalizeId(raw);
  if (id) return { kind: 'id', id };
  if (/^[\d\s-]+$/.test(raw)) return null; // numero che non e' un ID valido

  let host;
  let port = defaultPort;
  let m = raw.match(/^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/);
  if (m) {
    host = m[1];
    if (m[2]) port = Number(m[2]);
  } else if (/^[0-9a-fA-F:]+$/.test(raw) && raw.split(':').length > 2) {
    host = raw; // IPv6 senza parentesi: niente porta
  } else {
    m = raw.match(/^([A-Za-z0-9][A-Za-z0-9.\-_]*)(?::(\d{1,5}))?$/);
    if (!m) return null;
    host = m[1];
    if (m[2]) port = Number(m[2]);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { kind: 'address', host, port };
}

/** Chiave stabile per rubrica e recenti: "id:123456789" oppure "addr:host:porta". */
export function targetKey(target) {
  if (!target) return '';
  return target.kind === 'id' ? `id:${target.id}` : `addr:${target.host.toLowerCase()}:${target.port}`;
}

export function targetLabel(target) {
  if (!target) return '';
  if (target.kind === 'id') return formatId(target.id);
  const host = target.host.includes(':') ? `[${target.host}]` : target.host;
  return `${host}:${target.port}`;
}
