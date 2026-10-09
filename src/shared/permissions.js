// Permessi concessi dalla postazione controllata a chi si collega.

export const PERMISSIONS = Object.freeze([
  { key: 'control', label: 'Mouse e tastiera', hint: 'Consente di controllare mouse e tastiera', icon: 'mouse', default: true },
  { key: 'clipboard', label: 'Appunti', hint: 'Sincronizza testo e immagini copiati', icon: 'clipboard', default: true },
  { key: 'files', label: 'File', hint: 'Consente di sfogliare e trasferire file', icon: 'folder', default: true },
  { key: 'audio', label: 'Audio', hint: 'Trasmette l’audio di questo computer', icon: 'volume', default: true },
  { key: 'microphone', label: 'Microfono', hint: 'Chi si collega può parlare con il proprio microfono nelle app di questo PC (es. Teams)', icon: 'mic', default: true },
  { key: 'whiteboard', label: 'Lavagna', hint: 'Consente di disegnare sullo schermo', icon: 'pen', default: true },
  { key: 'privacy', label: 'Privacy', hint: 'Consente di oscurare questo schermo durante la sessione', icon: 'eye-off', default: false },
  { key: 'blockInput', label: 'Blocco input', hint: 'Consente di bloccare mouse e tastiera locali (serve amministratore)', icon: 'lock', default: false },
  { key: 'system', label: 'Riavvio', hint: 'Consente di riavviare o bloccare questo computer', icon: 'power', default: false },
]);

export const PERMISSION_KEYS = Object.freeze(PERMISSIONS.map((p) => p.key));

export function defaultPermissions() {
  return Object.fromEntries(PERMISSIONS.map((p) => [p.key, p.default]));
}

/** Tiene solo le chiavi note, forza i booleani, completa con `base`. */
export function sanitizePermissions(input, base = defaultPermissions()) {
  const out = {};
  for (const key of PERMISSION_KEYS) {
    const v = input && typeof input === 'object' ? input[key] : undefined;
    out[key] = typeof v === 'boolean' ? v : Boolean(base[key]);
  }
  return out;
}

/** In modalità "solo file" lo schermo non viene trasmesso: niente controllo, audio, lavagna, privacy. */
export function permissionsForMode(perms, mode) {
  if (mode !== 'files') return { ...perms };
  return { ...perms, control: false, audio: false, microphone: false, whiteboard: false, privacy: false, blockInput: false };
}
