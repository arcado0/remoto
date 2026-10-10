// Dispositivi audio di Windows (Core Audio, interfacce COM chiamate tramite koffi): elenco delle casse e
// dei microfoni, silenziamento, dispositivo predefinito. Serve a fare come Desktop remoto di Windows:
// durante la sessione l'audio esce solo dal PC di chi controlla e il microfono è il suo.
// Il dispositivo predefinito si cambia con IPolicyConfig (non documentata, ma stabile da Windows 7 e usata
// da tutti i programmi che cambiano le casse predefinite); nessuna operazione richiede l'amministratore.
import koffi from 'koffi';

export const FLOW = Object.freeze({ render: 0, capture: 1 });
export const ROLE = Object.freeze({ console: 0, multimedia: 1, communications: 2 });

const CLSCTX_ALL = 0x17;
const DEVICE_STATE_ACTIVE = 0x1;
const VT_LPWSTR = 31;
const PTR = 8; // solo Windows a 64 bit

let api;

function guid(text) {
  const h = text.replace(/[{}-]/g, '');
  const b = Buffer.alloc(16);
  b.writeUInt32LE(parseInt(h.slice(0, 8), 16), 0);
  b.writeUInt16LE(parseInt(h.slice(8, 12), 16), 4);
  b.writeUInt16LE(parseInt(h.slice(12, 16), 16), 6);
  for (let i = 0; i < 8; i++) b[8 + i] = parseInt(h.slice(16 + i * 2, 18 + i * 2), 16);
  return b;
}

const CLSID_MMDeviceEnumerator = guid('BCDE0395-E52F-467C-8E3D-C4579291692E');
const IID_IMMDeviceEnumerator = guid('A95664D2-9614-4F35-A746-DE8DB63617E6');
const IID_IAudioEndpointVolume = guid('5CDF2C82-841E-4546-9722-0CF74078229A');
const CLSID_PolicyConfigClient = guid('870AF99C-171D-4F9E-AF0D-E63DF40C2BC9');
const IID_IPolicyConfig = guid('F8679F50-850A-41CF-9C72-430F290290C8');
// PKEY_Device_FriendlyName = {a45c254e-df1c-4efd-8020-67d146a850e0}, 14
const PKEY_FriendlyName = Buffer.concat([guid('A45C254E-DF1C-4EFD-8020-67D146A850E0'), Buffer.from([14, 0, 0, 0])]);

function load() {
  if (api !== undefined) return api;
  if (process.platform !== 'win32' || process.arch !== 'x64') return (api = null);
  try {
    const ole32 = koffi.load('ole32.dll');
    const P = (sig) => koffi.proto(`int32_t __stdcall ${sig}`);
    api = {
      CoInitializeEx: ole32.func('int32_t __stdcall CoInitializeEx(void *pv, uint32_t coinit)'),
      CoCreateInstance: ole32.func('int32_t __stdcall CoCreateInstance(void *clsid, void *outer, uint32_t ctx, void *iid, _Out_ void **ppv)'),
      CoTaskMemFree: ole32.func('void __stdcall CoTaskMemFree(void *pv)'),
      PropVariantClear: ole32.func('int32_t __stdcall PropVariantClear(void *pv)'),
      Release: P('Release_(void *self)'),
      EnumAudioEndpoints: P('EnumAudioEndpoints(void *self, int32_t flow, uint32_t mask, _Out_ void **coll)'),
      GetDefaultAudioEndpoint: P('GetDefaultAudioEndpoint(void *self, int32_t flow, int32_t role, _Out_ void **dev)'),
      GetDevice: P('GetDevice(void *self, const char16_t *id, _Out_ void **dev)'),
      GetCount: P('GetCount(void *self, _Out_ uint32_t *n)'),
      Item: P('Item(void *self, uint32_t i, _Out_ void **dev)'),
      Activate: P('Activate(void *self, void *iid, uint32_t ctx, void *params, _Out_ void **itf)'),
      OpenPropertyStore: P('OpenPropertyStore(void *self, uint32_t access, _Out_ void **store)'),
      GetId: P('GetId(void *self, _Out_ void **id)'),
      GetValue: P('GetValue(void *self, void *key, void *pv)'),
      SetMute: P('SetMute(void *self, int32_t mute, void *ctx)'),
      GetMute: P('GetMute(void *self, _Out_ int32_t *mute)'),
      SetDefaultEndpoint: P('SetDefaultEndpoint(void *self, const char16_t *id, int32_t role)'),
    };
    // il thread principale di Electron ha già COM (STA): S_FALSE o "modalità diversa" vanno bene
    api.CoInitializeEx(null, 0x2);
  } catch {
    api = null;
  }
  return api;
}

/** Chiama il metodo n-esimo della vtable di un'interfaccia COM. */
function vcall(obj, index, proto, ...args) {
  const vtbl = koffi.decode(obj, 'void *');
  const fn = koffi.decode(vtbl, index * PTR, 'void *');
  return koffi.call(fn, proto, obj, ...args);
}

function release(obj) {
  if (obj) vcall(obj, 2, api.Release);
}

function check(hr, what) {
  if (hr < 0) throw new Error(`${what}: 0x${(hr >>> 0).toString(16)}`);
}

function withEnumerator(fn) {
  const a = load();
  if (!a) throw new Error('audio di Windows non disponibile');
  const out = [null];
  check(a.CoCreateInstance(CLSID_MMDeviceEnumerator, null, CLSCTX_ALL, IID_IMMDeviceEnumerator, out), 'MMDeviceEnumerator');
  try {
    return fn(out[0]);
  } finally {
    release(out[0]);
  }
}

function deviceId(dev) {
  const out = [null];
  check(vcall(dev, 5, api.GetId, out), 'GetId');
  try {
    return koffi.decode.string16(out[0]);
  } finally {
    api.CoTaskMemFree(out[0]);
  }
}

function friendlyName(dev) {
  const store = [null];
  if (vcall(dev, 4, api.OpenPropertyStore, 0, store) < 0) return '';
  const pv = Buffer.alloc(24);
  try {
    if (vcall(store[0], 5, api.GetValue, PKEY_FriendlyName, pv) < 0) return '';
    if (pv.readUInt16LE(0) !== VT_LPWSTR) return '';
    const p = koffi.decode(pv, 8, 'void *');
    return p ? koffi.decode.string16(p) : '';
  } finally {
    api.PropVariantClear(pv);
    release(store[0]);
  }
}

function withEndpointVolume(dev, fn) {
  const out = [null];
  check(vcall(dev, 3, api.Activate, IID_IAudioEndpointVolume, CLSCTX_ALL, null, out), 'IAudioEndpointVolume');
  try {
    return fn(out[0]);
  } finally {
    release(out[0]);
  }
}

function getMuted(dev) {
  return withEndpointVolume(dev, (vol) => {
    const m = [0];
    check(vcall(vol, 15, api.GetMute, m), 'GetMute');
    return m[0] !== 0;
  });
}

function defaultId(en, flow, role) {
  const out = [null];
  if (vcall(en, 4, api.GetDefaultAudioEndpoint, flow, role, out) < 0 || !out[0]) return null;
  try {
    return deviceId(out[0]);
  } finally {
    release(out[0]);
  }
}

/** true se le API audio di Windows sono utilizzabili. */
export function audioDevicesAvailable() {
  return Boolean(load());
}

/**
 * Dispositivi attivi di un flusso ('render' = casse, 'capture' = microfoni).
 * @returns {{id: string, name: string, muted: boolean, isDefault: boolean, isDefaultComm: boolean}[]}
 */
export function listDevices(flow) {
  const f = FLOW[flow];
  return withEnumerator((en) => {
    const def = defaultId(en, f, ROLE.console);
    const comm = defaultId(en, f, ROLE.communications);
    const coll = [null];
    check(vcall(en, 3, api.EnumAudioEndpoints, f, DEVICE_STATE_ACTIVE, coll), 'EnumAudioEndpoints');
    const list = [];
    try {
      const n = [0];
      check(vcall(coll[0], 3, api.GetCount, n), 'GetCount');
      for (let i = 0; i < n[0]; i++) {
        const dev = [null];
        if (vcall(coll[0], 4, api.Item, i, dev) < 0) continue;
        try {
          const id = deviceId(dev[0]);
          let muted = false;
          try {
            muted = getMuted(dev[0]);
          } catch {
            /* dispositivo senza controllo del volume */
          }
          list.push({ id, name: friendlyName(dev[0]), muted, isDefault: id === def, isDefaultComm: id === comm });
        } finally {
          release(dev[0]);
        }
      }
    } finally {
      release(coll[0]);
    }
    return list;
  });
}

/** Silenzia (o riattiva) un dispositivo. */
export function setMuted(id, muted) {
  withEnumerator((en) => {
    const dev = [null];
    check(vcall(en, 5, api.GetDevice, id, dev), 'GetDevice');
    try {
      withEndpointVolume(dev[0], (vol) => check(vcall(vol, 14, api.SetMute, muted ? 1 : 0, null), 'SetMute'));
    } finally {
      release(dev[0]);
    }
  });
}

/** Rende un dispositivo il predefinito per uno o più ruoli (console, multimedia, comunicazioni). */
export function setDefault(id, roles = ['console', 'multimedia', 'communications']) {
  const a = load();
  if (!a) throw new Error('audio di Windows non disponibile');
  const out = [null];
  check(a.CoCreateInstance(CLSID_PolicyConfigClient, null, CLSCTX_ALL, IID_IPolicyConfig, out), 'PolicyConfig');
  try {
    for (const r of roles) check(vcall(out[0], 13, a.SetDefaultEndpoint, id, ROLE[r]), 'SetDefaultEndpoint');
  } finally {
    release(out[0]);
  }
}
