// Iniezione di mouse e tastiera sul PC controllato (SendInput, coordinate assolute sul desktop
// virtuale in pixel fisici). Tiene traccia di tasti e pulsanti premuti da ogni sessione per
// poterli rilasciare se la sessione si interrompe (niente Ctrl "incastrato" sul remoto).
import { win32, virtualScreen, SM, INPUT_MOUSE, INPUT_KEYBOARD, MOUSEEVENTF, KEYEVENTF } from './win32.js';
import { lookupKey, comboSequence } from './keymap.js';
import { toScreenPoint, toAbsoluteInput } from '../../shared/geometry.js';

const BUTTONS = [
  { down: MOUSEEVENTF.LEFTDOWN, up: MOUSEEVENTF.LEFTUP, data: 0 },
  { down: MOUSEEVENTF.MIDDLEDOWN, up: MOUSEEVENTF.MIDDLEUP, data: 0 },
  { down: MOUSEEVENTF.RIGHTDOWN, up: MOUSEEVENTF.RIGHTUP, data: 0 },
  { down: MOUSEEVENTF.XDOWN, up: MOUSEEVENTF.XUP, data: 1 },
  { down: MOUSEEVENTF.XDOWN, up: MOUSEEVENTF.XUP, data: 2 },
];

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.trunc(Number(v) || 0)));

/** Struct INPUT (koffi) → tupla nel formato atteso dal servizio: ['m',dx,dy,mouseData,flags] / ['k',vk,scan,flags]. */
function toWire(input) {
  if (input.type === INPUT_MOUSE) {
    const mi = input.u.mi;
    return ['m', mi.dx | 0, mi.dy | 0, mi.mouseData >>> 0, mi.dwFlags >>> 0];
  }
  const ki = input.u.ki;
  return ['k', ki.wVk & 0xffff, ki.wScan & 0xffff, ki.dwFlags >>> 0];
}

export class InputInjector {
  constructor({ api = win32() } = {}) {
    this.api = api;
    this.virt = api ? virtualScreen(api) : null;
    this.pressed = new Map(); // sessione → { keys:Set, buttons:Set }
    this.sink = null; // servizio di controllo completo (se collegato, riceve l'input al posto di SendInput locale)
  }

  get available() {
    return Boolean(this.api) || Boolean(this.sink?.connected);
  }

  /** Collega il servizio "controllo completo": da quel momento l'input passa da lì (finestre di amministratore, UAC, blocco). */
  setSink(sink) {
    this.sink = sink || null;
  }

  /** Invia gli eventi: al servizio se collegato (nessun limite di sistema), altrimenti con SendInput locale. */
  #send(inputs) {
    if (this.sink?.connected) {
      this.sink.input(inputs.map(toWire));
      return inputs.length;
    }
    return this.api ? this.api.sendInput(inputs) : 0;
  }

  /** Da chiamare quando cambiano monitor o risoluzione. */
  refresh() {
    if (this.api) this.virt = virtualScreen(this.api);
  }

  #state(sessionId) {
    let st = this.pressed.get(sessionId);
    if (!st) {
      st = { keys: new Set(), buttons: new Set() };
      this.pressed.set(sessionId, st);
    }
    return st;
  }

  #mouse(dx, dy, flags, mouseData = 0) {
    return { type: INPUT_MOUSE, u: { mi: { dx, dy, mouseData: mouseData >>> 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
  }

  #key(vk, scan, flags) {
    return { type: INPUT_KEYBOARD, u: { ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
  }

  #abs(rect, nx, ny) {
    const p = toScreenPoint(nx, ny, rect);
    if (!this.virt || this.virt.width <= 0) this.refresh();
    return toAbsoluteInput(p.x, p.y, this.virt);
  }

  #absFlags() {
    return MOUSEEVENTF.MOVE | MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUALDESK;
  }

  move(rect, nx, ny) {
    if (!this.api) return 0;
    const a = this.#abs(rect, nx, ny);
    return this.#send([this.#mouse(a.dx, a.dy, this.#absFlags())]);
  }

  button(sessionId, rect, b, down, nx, ny) {
    if (!this.api) return 0;
    const logical = clampInt(b, 0, 4);
    const st = this.#state(sessionId);
    if (down) st.buttons.add(logical);
    else st.buttons.delete(logical);
    // mouse per mancini sul PC remoto: SendInput lavora sui pulsanti fisici
    let idx = logical;
    if ((idx === 0 || idx === 2) && this.api.getSystemMetrics(SM.SWAPBUTTON)) idx = 2 - idx;
    const btn = BUTTONS[idx];
    const flags = down ? btn.down : btn.up;
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      const a = this.#abs(rect, nx, ny);
      return this.#send([this.#mouse(a.dx, a.dy, this.#absFlags() | flags, btn.data)]);
    }
    return this.#send([this.#mouse(0, 0, flags, btn.data)]);
  }

  wheel(rect, dx, dy, nx, ny) {
    if (!this.api) return 0;
    const events = [];
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      const a = this.#abs(rect, nx, ny);
      events.push(this.#mouse(a.dx, a.dy, this.#absFlags()));
    }
    const v = clampInt(dy, -12000, 12000);
    const h = clampInt(dx, -12000, 12000);
    // convenzione di Windows: dy > 0 = rotella in avanti (su), dx > 0 = verso destra
    if (v) events.push(this.#mouse(0, 0, MOUSEEVENTF.WHEEL, v));
    if (h) events.push(this.#mouse(0, 0, MOUSEEVENTF.HWHEEL, h));
    return events.length ? this.#send(events) : 0;
  }

  /** Tasto fisico (KeyboardEvent.code). Se il codice è sconosciuto si ripiega sul carattere Unicode. */
  key(sessionId, code, down, fallbackChar = '') {
    if (!this.api) return 0;
    const entry = lookupKey(String(code || ''));
    const st = this.#state(sessionId);
    if (entry) {
      if (down) st.keys.add(code);
      else st.keys.delete(code);
      if ('vk' in entry) return this.#send([this.#key(entry.vk, 0, down ? 0 : KEYEVENTF.KEYUP)]);
      let flags = KEYEVENTF.SCANCODE | (down ? 0 : KEYEVENTF.KEYUP);
      if (entry.ext) flags |= KEYEVENTF.EXTENDEDKEY;
      return this.#send([this.#key(0, entry.sc, flags)]);
    }
    if (down && typeof fallbackChar === 'string' && [...fallbackChar].length === 1) return this.text(fallbackChar);
    return 0;
  }

  /** Digita testo come caratteri Unicode (indipendente dal layout di tastiera). */
  text(str) {
    if (!this.api) return 0;
    const s = String(str ?? '').slice(0, 100_000).replace(/\r\n/g, '\n');
    let sent = 0;
    let batch = [];
    const flush = () => {
      if (batch.length) sent += this.#send(batch);
      batch = [];
    };
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\n' || ch === '\t') {
        const k = lookupKey(ch === '\n' ? 'Enter' : 'Tab');
        batch.push(this.#key(0, k.sc, KEYEVENTF.SCANCODE), this.#key(0, k.sc, KEYEVENTF.SCANCODE | KEYEVENTF.KEYUP));
      } else {
        const unit = s.charCodeAt(i); // le coppie surrogate passano come due unità UTF-16
        batch.push(this.#key(0, unit, KEYEVENTF.UNICODE), this.#key(0, unit, KEYEVENTF.UNICODE | KEYEVENTF.KEYUP));
      }
      if (batch.length >= 200) flush();
    }
    flush();
    return sent;
  }

  combo(sessionId, name) {
    const seq = comboSequence(name);
    if (!seq || !this.api) return 0;
    let n = 0;
    for (const step of seq) n += this.key(sessionId, step.code, step.down);
    return n;
  }

  /** Rilascia tutto ciò che la sessione ha lasciato premuto. */
  releaseAll(sessionId) {
    const st = this.pressed.get(sessionId);
    if (!st || !this.api) return;
    for (const code of [...st.keys]) this.key(sessionId, code, false);
    for (const b of [...st.buttons]) this.button(sessionId, null, b, false);
    st.keys.clear();
    st.buttons.clear();
  }

  forget(sessionId) {
    this.releaseAll(sessionId);
    this.pressed.delete(sessionId);
  }

  cursor() {
    return this.api ? this.api.getCursorPos() : null;
  }
}
