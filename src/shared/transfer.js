// Trasferimento file: framing dei chunk binari e sanificazione di nomi e percorsi.

export const CHUNK_SIZE = 64 * 1024;
export const HEADER_SIZE = 8;
export const MAX_TRANSFER_FILES = 20000;

/** [xid u32 LE][indice file u32 LE][dati] */
export function encodeChunk(xid, index, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const out = new Uint8Array(HEADER_SIZE + bytes.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, xid >>> 0, true);
  view.setUint32(4, index >>> 0, true);
  out.set(bytes, HEADER_SIZE);
  return out;
}

export function decodeChunk(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < HEADER_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    xid: view.getUint32(0, true),
    index: view.getUint32(4, true),
    data: bytes.subarray(HEADER_SIZE),
  };
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Nome file valido su Windows (caratteri vietati sostituiti, nomi riservati evitati). */
export function sanitizeFileName(name) {
  let s = String(name ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!s || s === '.' || s === '..') s = 'file';
  if (RESERVED.test(s)) s = '_' + s;
  return s.slice(0, 200);
}

/**
 * Percorso relativo sicuro ("cartella/sotto/file.txt") oppure null se tenta di uscire
 * dalla destinazione (assoluto, unità, "..").
 */
export function sanitizeRelativePath(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 2048) return null;
  if (/^[a-zA-Z]:/.test(rel) || rel.startsWith('/') || rel.startsWith('\\')) return null;
  const parts = rel.split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
  if (!parts.length || parts.length > 64) return null;
  if (parts.some((p) => p === '..')) return null;
  return parts.map(sanitizeFileName).join('/');
}

export function splitExt(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return [name, ''];
  return [name.slice(0, i), name.slice(i)];
}

/** "nome.ext" → "nome (1).ext", "nome (2).ext"... finché `exists` dice false. */
export function uniqueName(name, exists) {
  if (!exists(name)) return name;
  const [base, ext] = splitExt(name);
  for (let i = 1; i < 10000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!exists(candidate)) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}
