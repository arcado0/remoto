// File negli appunti di Windows (formato CF_HDROP, quello di "Copia" in Esplora risorse), via koffi.
// Electron sa leggere e scrivere solo testo e immagini: per copiare file da un PC all'altro serve
// leggere l'elenco dei file copiati e, dall'altra parte, mettere negli appunti i file ricevuti.
import koffi from 'koffi';

const CF_HDROP = 15;
const GMEM_MOVEABLE = 0x0002;
const DROPEFFECT_COPY = 1;
const MAX_FILES = 1000;

let api;

function load() {
  if (api !== undefined) return api;
  if (process.platform !== 'win32') return (api = null);
  try {
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const shell32 = koffi.load('shell32.dll');
    api = {
      OpenClipboard: user32.func('bool __stdcall OpenClipboard(intptr_t hwnd)'),
      CloseClipboard: user32.func('bool __stdcall CloseClipboard()'),
      EmptyClipboard: user32.func('bool __stdcall EmptyClipboard()'),
      IsClipboardFormatAvailable: user32.func('bool __stdcall IsClipboardFormatAvailable(uint32_t fmt)'),
      GetClipboardData: user32.func('void * __stdcall GetClipboardData(uint32_t fmt)'),
      SetClipboardData: user32.func('void * __stdcall SetClipboardData(uint32_t fmt, void *mem)'),
      RegisterClipboardFormatW: user32.func('uint32_t __stdcall RegisterClipboardFormatW(const char16_t *name)'),
      GlobalAlloc: kernel32.func('void * __stdcall GlobalAlloc(uint32_t flags, uintptr_t bytes)'),
      GlobalLock: kernel32.func('void * __stdcall GlobalLock(void *mem)'),
      GlobalUnlock: kernel32.func('bool __stdcall GlobalUnlock(void *mem)'),
      GlobalFree: kernel32.func('void * __stdcall GlobalFree(void *mem)'),
      // copia senza creare ArrayBuffer su memoria esterna: in Electron (gabbia di memoria di V8) farebbe chiudere il processo
      RtlMoveMemory: kernel32.func('void __stdcall RtlMoveMemory(void *dst, const void *src, uintptr_t len)'),
      DragQueryFileW: shell32.func('uint32_t __stdcall DragQueryFileW(void *drop, uint32_t i, void *buf, uint32_t cch)'),
    };
  } catch {
    api = null;
  }
  return api;
}

/** Gli appunti possono essere aperti da un altro programma in quel momento: qualche tentativo ravvicinato. */
function open(a, hwnd) {
  for (let i = 0; i < 8; i++) {
    if (a.OpenClipboard(hwnd)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
  }
  return false;
}

/** Copia un buffer in un blocco di memoria globale (quello che vogliono gli appunti). */
function globalBlock(a, data) {
  const mem = a.GlobalAlloc(GMEM_MOVEABLE, data.length);
  if (!mem) throw new Error('memoria non disponibile');
  const p = a.GlobalLock(mem);
  try {
    a.RtlMoveMemory(p, data, data.length);
  } finally {
    a.GlobalUnlock(mem);
  }
  return mem;
}

/** DROPFILES (20 byte) + percorsi UTF-16 terminati da zero + zero finale. */
export function dropFilesBuffer(paths) {
  const head = Buffer.alloc(20);
  head.writeUInt32LE(20, 0); // pFiles: i nomi iniziano dopo l'intestazione
  head.writeInt32LE(1, 16); // fWide: UTF-16
  return Buffer.concat([head, Buffer.from(`${paths.join('\0')}\0\0`, 'utf16le')]);
}

/**
 * @param {() => bigint} getHwnd  finestra di Remoto che diventa proprietaria degli appunti quando li scrive
 * @returns {{hasFiles(): boolean, readFiles(): string[]|null, writeFiles(paths: string[]): boolean}|null}
 */
export function clipboardFiles(getHwnd) {
  const a = load();
  if (!a) return null;
  return {
    hasFiles: () => Boolean(a.IsClipboardFormatAvailable(CF_HDROP)),

    readFiles() {
      if (!a.IsClipboardFormatAvailable(CF_HDROP) || !open(a, 0n)) return null;
      try {
        const drop = a.GetClipboardData(CF_HDROP);
        if (!drop) return null;
        const n = Math.min(a.DragQueryFileW(drop, 0xffffffff, null, 0), MAX_FILES);
        const out = [];
        for (let i = 0; i < n; i++) {
          const len = a.DragQueryFileW(drop, i, null, 0);
          if (!len) continue;
          const buf = Buffer.alloc((len + 1) * 2);
          a.DragQueryFileW(drop, i, buf, len + 1);
          out.push(buf.toString('utf16le', 0, len * 2));
        }
        return out;
      } finally {
        a.CloseClipboard();
      }
    },

    writeFiles(paths) {
      if (!paths?.length) return false;
      const drop = globalBlock(a, dropFilesBuffer(paths));
      const effect = Buffer.alloc(4);
      effect.writeUInt32LE(DROPEFFECT_COPY, 0); // incollando si copia (non si sposta) dalla cartella temporanea
      const effectMem = globalBlock(a, effect);
      if (!open(a, getHwnd())) {
        a.GlobalFree(drop);
        a.GlobalFree(effectMem);
        return false;
      }
      try {
        a.EmptyClipboard();
        // dopo SetClipboardData la memoria appartiene agli appunti; se fallisce va liberata
        if (!a.SetClipboardData(CF_HDROP, drop)) {
          a.GlobalFree(drop);
          a.GlobalFree(effectMem);
          return false;
        }
        if (!a.SetClipboardData(a.RegisterClipboardFormatW('Preferred DropEffect'), effectMem)) a.GlobalFree(effectMem);
        return true;
      } finally {
        a.CloseClipboard();
      }
    },
  };
}
