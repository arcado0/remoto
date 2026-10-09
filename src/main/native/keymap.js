// KeyboardEvent.code (tasto fisico) → scancode set 1 per SendInput.
// Si inviano scancode e non caratteri: il layout di tastiera applicato è quello del PC remoto,
// come fa AnyDesk in modalità predefinita. `ext` = prefisso E0 (KEYEVENTF_EXTENDEDKEY).
// Alcuni tasti funzionano solo come virtual key (`vk`).

const sc = (code, ext = false) => ({ sc: code, ext });
const vk = (code) => ({ vk: code });

export const KEYMAP = Object.freeze({
  Escape: sc(0x01),
  Digit1: sc(0x02), Digit2: sc(0x03), Digit3: sc(0x04), Digit4: sc(0x05), Digit5: sc(0x06),
  Digit6: sc(0x07), Digit7: sc(0x08), Digit8: sc(0x09), Digit9: sc(0x0a), Digit0: sc(0x0b),
  Minus: sc(0x0c), Equal: sc(0x0d), Backspace: sc(0x0e), Tab: sc(0x0f),
  KeyQ: sc(0x10), KeyW: sc(0x11), KeyE: sc(0x12), KeyR: sc(0x13), KeyT: sc(0x14),
  KeyY: sc(0x15), KeyU: sc(0x16), KeyI: sc(0x17), KeyO: sc(0x18), KeyP: sc(0x19),
  BracketLeft: sc(0x1a), BracketRight: sc(0x1b), Enter: sc(0x1c), ControlLeft: sc(0x1d),
  KeyA: sc(0x1e), KeyS: sc(0x1f), KeyD: sc(0x20), KeyF: sc(0x21), KeyG: sc(0x22),
  KeyH: sc(0x23), KeyJ: sc(0x24), KeyK: sc(0x25), KeyL: sc(0x26),
  Semicolon: sc(0x27), Quote: sc(0x28), Backquote: sc(0x29), ShiftLeft: sc(0x2a), Backslash: sc(0x2b),
  KeyZ: sc(0x2c), KeyX: sc(0x2d), KeyC: sc(0x2e), KeyV: sc(0x2f), KeyB: sc(0x30),
  KeyN: sc(0x31), KeyM: sc(0x32), Comma: sc(0x33), Period: sc(0x34), Slash: sc(0x35),
  ShiftRight: sc(0x36), NumpadMultiply: sc(0x37), AltLeft: sc(0x38), Space: sc(0x39), CapsLock: sc(0x3a),
  F1: sc(0x3b), F2: sc(0x3c), F3: sc(0x3d), F4: sc(0x3e), F5: sc(0x3f),
  F6: sc(0x40), F7: sc(0x41), F8: sc(0x42), F9: sc(0x43), F10: sc(0x44),
  NumLock: sc(0x45, true), ScrollLock: sc(0x46),
  Numpad7: sc(0x47), Numpad8: sc(0x48), Numpad9: sc(0x49), NumpadSubtract: sc(0x4a),
  Numpad4: sc(0x4b), Numpad5: sc(0x4c), Numpad6: sc(0x4d), NumpadAdd: sc(0x4e),
  Numpad1: sc(0x4f), Numpad2: sc(0x50), Numpad3: sc(0x51), Numpad0: sc(0x52), NumpadDecimal: sc(0x53),
  IntlBackslash: sc(0x56), F11: sc(0x57), F12: sc(0x58), NumpadEqual: sc(0x59),
  F13: sc(0x64), F14: sc(0x65), F15: sc(0x66), F16: sc(0x67), F17: sc(0x68), F18: sc(0x69),
  F19: sc(0x6a), F20: sc(0x6b), F21: sc(0x6c), F22: sc(0x6d), F23: sc(0x6e), F24: sc(0x76),
  KanaMode: sc(0x70), IntlRo: sc(0x73), Convert: sc(0x79), NonConvert: sc(0x7b), IntlYen: sc(0x7d), NumpadComma: sc(0x7e),
  // tasti estesi (E0)
  NumpadEnter: sc(0x1c, true), ControlRight: sc(0x1d, true), NumpadDivide: sc(0x35, true), AltRight: sc(0x38, true),
  Home: sc(0x47, true), ArrowUp: sc(0x48, true), PageUp: sc(0x49, true), ArrowLeft: sc(0x4b, true),
  ArrowRight: sc(0x4d, true), End: sc(0x4f, true), ArrowDown: sc(0x50, true), PageDown: sc(0x51, true),
  Insert: sc(0x52, true), Delete: sc(0x53, true), MetaLeft: sc(0x5b, true), MetaRight: sc(0x5c, true),
  ContextMenu: sc(0x5d, true),
  // tasti che vanno inviati come virtual key
  PrintScreen: vk(0x2c), Pause: vk(0x13),
  AudioVolumeMute: vk(0xad), AudioVolumeDown: vk(0xae), AudioVolumeUp: vk(0xaf),
  MediaTrackNext: vk(0xb0), MediaTrackPrevious: vk(0xb1), MediaStop: vk(0xb2), MediaPlayPause: vk(0xb3),
  BrowserBack: vk(0xa6), BrowserForward: vk(0xa7), BrowserRefresh: vk(0xa8), BrowserStop: vk(0xa9),
  BrowserSearch: vk(0xaa), BrowserFavorites: vk(0xab), BrowserHome: vk(0xac),
  LaunchMail: vk(0xb4), LaunchApp1: vk(0xb6), LaunchApp2: vk(0xb7),
});

export function lookupKey(code) {
  return Object.hasOwn(KEYMAP, code) ? KEYMAP[code] : null;
}

/** Combinazioni della barra "Tasti speciali" (il sistema operativo locale le intercetterebbe). */
export const COMBOS = Object.freeze({
  // Ctrl+Alt+Canc non c'e': Windows lo accetta solo da un servizio di sistema (SendSAS).
  'ctrl-shift-esc': ['ControlLeft', 'ShiftLeft', 'Escape'],
  win: ['MetaLeft'],
  'win-r': ['MetaLeft', 'KeyR'],
  'win-d': ['MetaLeft', 'KeyD'],
  'win-e': ['MetaLeft', 'KeyE'],
  'win-tab': ['MetaLeft', 'Tab'],
  'alt-tab': ['AltLeft', 'Tab'],
  'alt-f4': ['AltLeft', 'F4'],
  printscreen: ['PrintScreen'],
});

/** Sequenza premi/rilascia: premi in ordine, rilascia in ordine inverso. */
export function comboSequence(name) {
  const keys = COMBOS[name];
  if (!keys) return null;
  return [...keys.map((c) => ({ code: c, down: true })), ...[...keys].reverse().map((c) => ({ code: c, down: false }))];
}
