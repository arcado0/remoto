// Binding Win32 tramite koffi (nessuna compilazione nativa). Caricati solo su Windows.
import koffi from 'koffi';

export const SM = Object.freeze({ XVIRTUALSCREEN: 76, YVIRTUALSCREEN: 77, CXVIRTUALSCREEN: 78, CYVIRTUALSCREEN: 79, SWAPBUTTON: 23 });

export const INPUT_MOUSE = 0;
export const INPUT_KEYBOARD = 1;

export const MOUSEEVENTF = Object.freeze({
  MOVE: 0x0001, LEFTDOWN: 0x0002, LEFTUP: 0x0004, RIGHTDOWN: 0x0008, RIGHTUP: 0x0010,
  MIDDLEDOWN: 0x0020, MIDDLEUP: 0x0040, XDOWN: 0x0080, XUP: 0x0100,
  WHEEL: 0x0800, HWHEEL: 0x1000, VIRTUALDESK: 0x4000, ABSOLUTE: 0x8000,
});

export const KEYEVENTF = Object.freeze({ EXTENDEDKEY: 0x0001, KEYUP: 0x0002, UNICODE: 0x0004, SCANCODE: 0x0008 });

let api;

/** Restituisce le funzioni Win32 oppure null (altri sistemi o caricamento fallito). */
export function win32() {
  if (api !== undefined) return api;
  if (process.platform !== 'win32') {
    api = null;
    return api;
  }
  try {
    const user32 = koffi.load('user32.dll');
    const shell32 = koffi.load('shell32.dll');
    const POINT = koffi.struct('REMOTO_POINT', { x: 'int32_t', y: 'int32_t' });
    const MOUSEINPUT = koffi.struct('REMOTO_MOUSEINPUT', { dx: 'int32_t', dy: 'int32_t', mouseData: 'uint32_t', dwFlags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t' });
    const KEYBDINPUT = koffi.struct('REMOTO_KEYBDINPUT', { wVk: 'uint16_t', wScan: 'uint16_t', dwFlags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t' });
    const HARDWAREINPUT = koffi.struct('REMOTO_HARDWAREINPUT', { uMsg: 'uint32_t', wParamL: 'uint16_t', wParamH: 'uint16_t' });
    const INPUT = koffi.struct('REMOTO_INPUT', { type: 'uint32_t', u: koffi.union({ mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }) });
    const SendInput = user32.func('unsigned int __stdcall SendInput(unsigned int cInputs, REMOTO_INPUT *pInputs, int cbSize)');
    const INPUT_SIZE = koffi.sizeof(INPUT);
    api = {
      INPUT_SIZE,
      sendInput: (inputs) => SendInput(inputs.length, inputs, INPUT_SIZE),
      getSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int nIndex)'),
      getCursorPos: (() => {
        const fn = user32.func('bool __stdcall GetCursorPos(_Out_ REMOTO_POINT *lpPoint)');
        return () => {
          const p = {};
          return fn(p) ? p : null;
        };
      })(),
      blockInput: user32.func('bool __stdcall BlockInput(bool fBlockIt)'),
      lockWorkStation: user32.func('bool __stdcall LockWorkStation()'),
      getClipboardSequenceNumber: user32.func('uint32_t __stdcall GetClipboardSequenceNumber()'),
      isUserAnAdmin: shell32.func('bool __stdcall IsUserAnAdmin()'),
      /** Sessione Windows di questo processo (per trovare l'helper del servizio nella stessa sessione). */
      sessionId: (() => {
        const kernel32 = koffi.load('kernel32.dll');
        const GetCurrentProcessId = kernel32.func('uint32_t __stdcall GetCurrentProcessId()');
        const ProcessIdToSessionId = kernel32.func('bool __stdcall ProcessIdToSessionId(uint32_t pid, _Out_ uint32_t *sid)');
        return () => {
          const out = [0];
          return ProcessIdToSessionId(GetCurrentProcessId(), out) ? out[0] : null;
        };
      })(),
      getForegroundWindow: user32.func('void * __stdcall GetForegroundWindow()'),
      /** Finestra di primo livello visibile nel punto (pixel fisici): per verificare cosa vede l'utente. */
      topWindowAt: (() => {
        const WindowFromPoint = user32.func('void * __stdcall WindowFromPoint(REMOTO_POINT pt)');
        const GetAncestor = user32.func('void * __stdcall GetAncestor(void *hwnd, unsigned int flags)');
        return (x, y) => {
          const h = WindowFromPoint({ x, y });
          return h ? GetAncestor(h, 2) : null; // GA_ROOT
        };
      })(),
    };
    void POINT;
  } catch (err) {
    console.error('Remoto: impossibile caricare le API Win32', err);
    api = null;
  }
  return api;
}

export function virtualScreen(w = win32()) {
  if (!w) return null;
  return {
    x: w.getSystemMetrics(SM.XVIRTUALSCREEN),
    y: w.getSystemMetrics(SM.YVIRTUALSCREEN),
    width: w.getSystemMetrics(SM.CXVIRTUALSCREEN),
    height: w.getSystemMetrics(SM.CYVIRTUALSCREEN),
  };
}
