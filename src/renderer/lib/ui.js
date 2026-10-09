// Componenti comuni: tema, toast, finestre modali, menu, interruttori, avatar, suoni.
import { h, icon, clear } from './dom.js';
import { initials, hueFor } from '../../shared/format.js';

// ---------- tema ----------
let themeMql = null;
export function applyTheme(theme = 'system') {
  const root = document.documentElement;
  const set = () => {
    const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    root.dataset.theme = dark ? 'dark' : 'light';
  };
  if (themeMql) themeMql.onchange = null;
  themeMql = window.matchMedia('(prefers-color-scheme: dark)');
  themeMql.onchange = () => theme === 'system' && set();
  set();
}

/** Applica il tema salvato e inoltra al main gli errori della pagina. */
export async function bootPage() {
  window.addEventListener('error', (e) => remoto.send('app:log', 'error', `${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => remoto.send('app:log', 'error', String(e.reason?.stack || e.reason)));
  const info = await remoto.invoke('app:info');
  applyTheme(info.theme);
  soundsEnabled = info.sounds !== false;
  return info;
}

// ---------- toast ----------
let toastRoot = null;
export function toast({ title, text = '', kind = 'info', timeout = 4500, actions = [] }) {
  if (!toastRoot) {
    toastRoot = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastRoot);
  }
  const iconName = kind === 'ok' ? 'check' : kind === 'bad' ? 'alert' : 'info';
  const el = h(
    'div',
    { class: `toast ${kind}` },
    icon(iconName),
    h(
      'div',
      { class: 'toast-body' },
      title && h('div', { class: 'toast-title' }, title),
      text && h('div', { class: 'toast-text' }, text),
      actions.length &&
        h(
          'div',
          { class: 'toast-actions' },
          actions.map((a) =>
            h('a', {
              onClick: () => {
                a.onClick();
                close();
              },
            }, a.label),
          ),
        ),
    ),
    h('button', { class: 'icon-btn', style: { width: '24px', height: '24px' }, 'aria-label': 'Chiudi', onClick: () => close() }, icon('x', 'sm')),
  );
  const close = () => el.remove();
  toastRoot.append(el);
  if (timeout) setTimeout(close, timeout);
  return close;
}

// ---------- modali ----------
export function modal({ title, body, actions = [], dismissValue = null, width }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const done = (v) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      prevFocus?.focus?.();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(dismissValue);
      }
    };
    const box = h(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true', style: width ? { width: `min(${width}px, 100%)` } : null },
      title && h('h3', null, title),
      body,
      actions.length &&
        h(
          'div',
          { class: 'actions' },
          actions.map((a) =>
            h('button', { class: `btn ${a.kind || ''}`, type: a.submit ? 'submit' : 'button', onClick: async () => {
              const v = typeof a.value === 'function' ? await a.value() : a.value;
              if (v !== undefined) done(v);
            } }, a.label),
          ),
        ),
    );
    const backdrop = h('div', { class: 'modal-backdrop', onMousedown: (e) => e.target === backdrop && done(dismissValue) }, box);
    document.body.append(backdrop);
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => (box.querySelector('input, textarea, select') || box.querySelector('.btn.primary, .btn.danger'))?.focus(), 30);
  });
}

export function confirmDialog({ title, text, confirm = 'Conferma', cancel = 'Annulla', danger = false }) {
  return modal({
    title,
    body: h('p', { class: 'muted' }, text),
    actions: [
      { label: cancel, value: false },
      { label: confirm, kind: danger ? 'danger' : 'primary', value: true },
    ],
    dismissValue: false,
  });
}

export function promptDialog({ title, label, value = '', placeholder = '', confirm = 'OK', type = 'text', hint = '' }) {
  const input = h('input', { class: 'input', type, value, placeholder, spellcheck: 'false' });
  const form = h('form', { class: 'field', onSubmit: (e) => {
    e.preventDefault();
    form.closest('.modal').querySelector('.btn.primary').click();
  } }, label && h('label', null, label), input, hint && h('div', { class: 'hint' }, hint));
  return modal({
    title,
    body: form,
    actions: [
      { label: 'Annulla', value: null },
      { label: confirm, kind: 'primary', value: () => input.value },
    ],
  });
}

// ---------- menu a tendina ----------
let openMenuEl = null;
export function closeMenu() {
  if (openMenuEl) {
    openMenuEl.remove();
    openMenuEl = null;
  }
}

/**
 * items: [{ label, icon, onClick, checked, disabled, danger, sub, shortcut } | { divider:true } | { title }]
 */
export function openMenu(anchor, items, { align = 'left' } = {}) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it.divider) menu.append(h('hr'));
    else if (it.title) menu.append(h('div', { class: 'menu-title' }, it.title));
    else {
      menu.append(
        h(
          'button',
          {
            class: `menu-item ${it.danger ? 'danger' : ''}`,
            role: 'menuitem',
            disabled: it.disabled,
            title: it.tooltip || null,
            onClick: () => {
              closeMenu();
              it.onClick?.();
            },
          },
          it.icon ? icon(it.icon) : null,
          h('span', { class: 'grow' }, h('div', null, it.label), it.sub && h('div', { class: 'menu-sub' }, it.sub)),
          it.checked ? h('span', { class: 'check' }, icon('check', 'sm')) : null,
          it.shortcut ? h('span', { class: 'shortcut' }, it.shortcut) : null,
        ),
      );
    }
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = align === 'right' ? r.right - mw : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  openMenuEl = menu;
  setTimeout(() => {
    const away = (e) => {
      if (!menu.contains(e.target)) {
        closeMenu();
        document.removeEventListener('mousedown', away, true);
      }
    };
    document.addEventListener('mousedown', away, true);
  });
  return menu;
}
window.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());
window.addEventListener('blur', () => closeMenu());

// ---------- interruttore ----------
export function switchEl({ checked = false, onChange, label = null, disabled = false, ariaLabel }) {
  const input = h('input', { type: 'checkbox', checked, disabled, 'aria-label': ariaLabel || label || '' });
  input.addEventListener('change', () => onChange?.(input.checked, input));
  return h('label', { class: 'switch' }, input, h('span', { class: 'track' }), label && h('span', null, label));
}

// ---------- avatar ----------
export function avatar(name, size = '') {
  return h('div', { class: `avatar ${size}`, style: `--h:${hueFor(name)}` }, initials(name));
}

// ---------- suoni (sintetizzati, nessun file) ----------
let soundsEnabled = true;
let audioCtx = null;
export function playSound(kind = 'ding') {
  if (!soundsEnabled) return;
  try {
    audioCtx ||= new AudioContext();
    const notes = { ding: [880, 1320], pop: [660], bye: [520, 390], msg: [1046] }[kind] || [880];
    const t0 = audioCtx.currentTime;
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = t0 + i * 0.13;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + 0.3);
    });
  } catch {
    /* audio non disponibile */
  }
}

export function setSounds(on) {
  soundsEnabled = on;
}

export { clear };
