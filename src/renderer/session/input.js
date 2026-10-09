// Cattura di mouse e tastiera sul video e invio al PC remoto.
// Coordinate normalizzate 0..65535 rispetto all'immagine (tolte le bande nere).
import { containRect, toNormalized, wheelUnits } from '../../shared/geometry.js';

const LOCAL_TARGETS = '.side, .modal-backdrop, .menu, .toolbar, .wb-palette, input, textarea, select';

export class InputCapture {
  /**
   * @param {object} o
   * @param {HTMLElement} o.surface   elemento che riceve gli eventi del puntatore
   * @param {HTMLVideoElement} o.video
   * @param {() => object|null} o.peer
   * @param {() => boolean} o.enabled  controllo attivo (permesso + non sola visualizzazione)
   * @param {() => 'fit'|'original'} o.scaleMode
   * @param {(e: KeyboardEvent) => boolean} o.onHotkey  scorciatoie locali: true = gestita
   */
  constructor({ surface, video, peer, enabled, scaleMode, onHotkey = () => false }) {
    this.surface = surface;
    this.video = video;
    this.peer = peer;
    this.enabled = enabled;
    this.scaleMode = scaleMode;
    this.onHotkey = onHotkey;
    this.keys = new Set();
    this.buttons = new Set();
    this.pendingMove = null;
    this.raf = 0;
    this.wheelX = 0;
    this.wheelY = 0;
    this.#attach();
  }

  #contentRect() {
    const r = this.video.getBoundingClientRect();
    if (this.scaleMode() === 'original') return { x: r.left, y: r.top, width: r.width, height: r.height };
    const c = containRect(this.video.videoWidth, this.video.videoHeight, r.width, r.height);
    return { x: r.left + c.x, y: r.top + c.y, width: c.width, height: c.height };
  }

  #point(e, clamp = false) {
    return toNormalized(e.clientX, e.clientY, this.#contentRect(), clamp);
  }

  #attach() {
    const s = this.surface;
    s.addEventListener('pointermove', (e) => {
      if (!this.enabled() || !this.video.videoWidth) return;
      const p = this.#point(e, this.buttons.size > 0);
      if (!p) return;
      this.pendingMove = p;
      if (!this.raf) this.raf = requestAnimationFrame(() => this.#flushMove());
    });
    s.addEventListener('pointerdown', (e) => {
      if (!this.enabled() || e.pointerType === 'touch' && e.isPrimary === false) return;
      const p = this.#point(e);
      if (!p) return;
      e.preventDefault();
      s.setPointerCapture?.(e.pointerId);
      this.surface.focus?.({ preventScroll: true });
      this.#flushMove();
      const b = e.button;
      this.buttons.add(b);
      this.peer()?.sendCtrl({ t: 'mb', b, d: true, x: p.x, y: p.y });
    });
    const up = (e) => {
      if (!this.buttons.has(e.button)) return;
      const p = this.#point(e, true);
      this.buttons.delete(e.button);
      this.peer()?.sendCtrl({ t: 'mb', b: e.button, d: false, x: p?.x, y: p?.y });
    };
    s.addEventListener('pointerup', up);
    s.addEventListener('pointercancel', up);
    s.addEventListener(
      'wheel',
      (e) => {
        if (!this.enabled()) return;
        const p = this.#point(e);
        if (!p) return;
        e.preventDefault();
        // verticale: deltaY > 0 (giù) → unità negative; orizzontale: deltaX > 0 (destra) → positive
        this.wheelY += wheelUnits(e.deltaY, e.deltaMode);
        this.wheelX -= wheelUnits(e.deltaX, e.deltaMode);
        const dy = Math.trunc(this.wheelY);
        const dx = Math.trunc(this.wheelX);
        if (!dx && !dy) return;
        this.wheelY -= dy;
        this.wheelX -= dx;
        this.peer()?.sendCtrl({ t: 'mw', dx, dy, x: p.x, y: p.y });
      },
      { passive: false },
    );
    s.addEventListener('contextmenu', (e) => e.preventDefault());
    s.addEventListener('auxclick', (e) => e.preventDefault());
    s.addEventListener('dragstart', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => this.#onKey(e, true), true);
    window.addEventListener('keyup', (e) => this.#onKey(e, false), true);
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => document.hidden && this.releaseAll());
  }

  #flushMove() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (!this.pendingMove) return;
    this.peer()?.sendMove({ t: 'mm', x: this.pendingMove.x, y: this.pendingMove.y });
    this.pendingMove = null;
  }

  #onKey(e, down) {
    if (down && this.onHotkey(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest(LOCAL_TARGETS) && !(!down && this.keys.has(e.code))) return;
    if (!this.enabled()) return;
    if (e.isComposing || e.code === 'Unidentified') return;
    e.preventDefault();
    e.stopPropagation();
    if (down) this.keys.add(e.code);
    else if (!this.keys.delete(e.code)) return;
    this.peer()?.sendCtrl({ t: 'k', c: e.code, d: down, key: e.key && [...e.key].length === 1 ? e.key : '' });
  }

  /** Rilascia sul remoto tutto ciò che risulta premuto (cambio finestra, perdita del focus). */
  releaseAll() {
    const peer = this.peer();
    if (!peer) return;
    for (const code of this.keys) peer.sendCtrl({ t: 'k', c: code, d: false });
    for (const b of this.buttons) peer.sendCtrl({ t: 'mb', b, d: false });
    if (this.keys.size || this.buttons.size) peer.sendCtrl({ t: 'release' });
    this.keys.clear();
    this.buttons.clear();
  }
}
