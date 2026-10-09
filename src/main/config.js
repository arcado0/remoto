// Impostazioni persistenti (config.json nella cartella del profilo).
// I segreti (segreto del server, chiave dell'accesso non presidiato, password ricordate)
// sono cifrati con safeStorage (DPAPI su Windows) tramite l'oggetto `crypt` iniettato.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { defaultPermissions, sanitizePermissions } from '../shared/permissions.js';
import { DEFAULT_PORTS, sanitizeName } from '../shared/protocol.js';

export const CONFIG_VERSION = 1;

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    identity: { id: null, secret: null },
    profile: { name: sanitizeName(os.hostname(), 'Postazione') },
    network: {
      serverUrl: '',
      direct: { enabled: true, port: DEFAULT_PORTS.direct },
      discovery: { enabled: true },
      iceServers: [],
    },
    embeddedServer: { enabled: false, port: DEFAULT_PORTS.server },
    // ogni connessione va accettata da chi è davanti al PC: niente accesso non presidiato
    security: {
      allowIncoming: true,
      permissions: defaultPermissions(),
      acl: [],
      maxSessions: 3,
      lockOnEnd: false,
    },
    viewer: { quality: 'balanced', codec: 'auto', scaleMode: 'fit', showStats: false, clipboardSync: true, audio: true, micDevice: '', micLabel: '', speakerDevice: '' },
    // microfono di chi si collega: 'auto' = cavo audio virtuale se presente, 'none', 'default' o un dispositivo
    audio: { micSink: 'auto', micSinkLabel: '' },
    general: { theme: 'system', startWithWindows: false, closeToTray: true, sounds: true, trayHintShown: false },
    addressBook: [],
    recent: [],
    accessLog: [],
  };
}

/** Chiavi delle versioni precedenti da eliminare (anche dal file su disco). */
const LEGACY = {
  security: ['accessMode', 'unattended'],
  root: ['savedAuth'],
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Merge profondo: gli oggetti si fondono, array e valori primitivi si sostituiscono. */
export function deepMerge(base, patch) {
  if (!isObj(patch)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export class ConfigStore extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.file
   * @param {{encrypt:(s:string)=>string, decrypt:(s:string)=>string}} o.crypt
   */
  constructor({ file, crypt }) {
    super();
    this.file = file;
    this.crypt = crypt;
    this.data = defaultConfig();
  }

  load() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // file corrotto: si conserva una copia e si riparte dai valori predefiniti
        try {
          fs.copyFileSync(this.file, `${this.file}.corrotto-${Date.now()}`);
        } catch {
          /* ignorato */
        }
      }
    }
    const hadLegacy = Boolean(raw && (LEGACY.root.some((k) => k in raw) || LEGACY.security.some((k) => raw.security && k in raw.security)));
    this.data = this.#normalize(deepMerge(defaultConfig(), raw || {}));
    // primo avvio, oppure configurazione con l'accesso non presidiato: si riscrive subito il file
    if (!raw || hadLegacy) this.save();
    return this.data;
  }

  #normalize(c) {
    c.version = CONFIG_VERSION;
    // accesso non presidiato rimosso: password, chiavi e password ricordate vengono cancellate
    for (const k of LEGACY.security) delete c.security[k];
    for (const k of LEGACY.root) delete c[k];
    c.security.permissions = sanitizePermissions(c.security.permissions);
    c.security.maxSessions = Math.min(10, Math.max(1, Number(c.security.maxSessions) || 3));
    c.security.acl = Array.isArray(c.security.acl) ? c.security.acl.filter((x) => typeof x === 'string') : [];
    for (const k of ['addressBook', 'recent', 'accessLog']) if (!Array.isArray(c[k])) c[k] = [];
    c.profile.name = sanitizeName(c.profile.name, sanitizeName(os.hostname(), 'Postazione'));
    return c;
  }

  get() {
    return this.data;
  }

  /** Applica una patch (merge profondo), salva ed emette 'change'. */
  update(patch) {
    this.data = this.#normalize(deepMerge(this.data, patch));
    this.save();
    this.emit('change', this.data, patch);
    return this.data;
  }

  /** Sostituisce un intero ramo (es. liste) senza merge. */
  set(key, value) {
    this.data[key] = value;
    this.data = this.#normalize(this.data);
    this.save();
    this.emit('change', this.data, { [key]: value });
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  encrypt(plain) {
    return plain == null ? null : this.crypt.encrypt(String(plain));
  }

  decrypt(stored) {
    if (stored == null || stored === '') return null;
    try {
      return this.crypt.decrypt(stored);
    } catch {
      return null; // es. profilo copiato da un altro utente Windows: DPAPI non decifra
    }
  }
}
