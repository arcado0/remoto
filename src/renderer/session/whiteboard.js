// Lavagna: chi controlla disegna sopra il video; i tratti (coordinate 0..1 dell'immagine)
// arrivano al PC remoto e compaiono in una finestra trasparente sopra il suo schermo.
import { containRect } from '../../shared/geometry.js';

export const WB_COLORS = ['#ff3b5c', '#ffb020', '#22c55e', '#3b82f6', '#a855f7', '#ffffff', '#111111'];
const FADE_MS = 2500;

export class Whiteboard {
  constructor({ canvas, video, peer, scaleMode }) {
    this.canvas = canvas;
    this.video = video;
    this.peer = peer;
    this.scaleMode = scaleMode;
    this.ctx = canvas.getContext('2d');
    this.strokes = [];
    this.current = null;
    this.color = WB_COLORS[0];
    this.tool = 'pen';
    this.active = false;
    this.flushTimer = 0;
    this.pendingPts = [];
    this.anim = 0;
    canvas.addEventListener('pointerdown', (e) => this.#down(e));
    canvas.addEventListener('pointermove', (e) => this.#move(e));
    canvas.addEventListener('pointerup', (e) => this.#up(e));
    canvas.addEventListener('pointercancel', (e) => this.#up(e));
    new ResizeObserver(() => this.redraw()).observe(canvas);
  }

  setActive(on) {
    this.active = on;
    this.canvas.classList.toggle('drawing', on);
  }

  #rect() {
    const r = this.canvas.getBoundingClientRect();
    const v = this.video.getBoundingClientRect();
    if (this.scaleMode() === 'original') return { x: v.left - r.left, y: v.top - r.top, width: v.width, height: v.height };
    const c = containRect(this.video.videoWidth, this.video.videoHeight, v.width, v.height);
    return { x: v.left - r.left + c.x, y: v.top - r.top + c.y, width: c.width, height: c.height };
  }

  #norm(e) {
    const r = this.#rect();
    const box = this.canvas.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - box.left - r.x) / r.width)), Math.min(1, Math.max(0, (e.clientY - box.top - r.y) / r.height))];
  }

  #down(e) {
    if (!this.active || e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    const id = Math.random().toString(36).slice(2, 9);
    const width = this.tool === 'highlighter' ? 18 : 4;
    this.current = { id, color: this.color, tool: this.tool, width, pts: [this.#norm(e)], ended: 0 };
    this.strokes.push(this.current);
    this.peer()?.sendCtrl({ t: 'wb', op: 'begin', id, color: this.color, tool: this.tool, w: width, p: this.current.pts[0] });
    this.redraw();
  }

  #move(e) {
    if (!this.current) return;
    const p = this.#norm(e);
    this.current.pts.push(p);
    this.pendingPts.push(p);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.#flush(), 30);
    this.redraw();
  }

  #flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = 0;
    if (!this.current || !this.pendingPts.length) return;
    this.peer()?.sendCtrl({ t: 'wb', op: 'pts', id: this.current.id, pts: this.pendingPts.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]) });
    this.pendingPts = [];
  }

  #up() {
    if (!this.current) return;
    this.#flush();
    this.peer()?.sendCtrl({ t: 'wb', op: 'end', id: this.current.id });
    this.current.ended = performance.now();
    this.current = null;
    this.#animateFade();
  }

  clear() {
    this.strokes = [];
    this.current = null;
    this.peer()?.sendCtrl({ t: 'wb', op: 'clear' });
    this.redraw();
  }

  #animateFade() {
    if (this.anim) return;
    const tick = () => {
      const now = performance.now();
      this.strokes = this.strokes.filter((s) => s.tool !== 'highlighter' || !s.ended || now - s.ended < FADE_MS);
      this.redraw();
      this.anim = this.strokes.some((s) => s.tool === 'highlighter' && s.ended) ? requestAnimationFrame(tick) : 0;
    };
    this.anim = requestAnimationFrame(tick);
  }

  redraw() {
    const dpr = window.devicePixelRatio || 1;
    const box = this.canvas.getBoundingClientRect();
    const w = Math.round(box.width * dpr);
    const h = Math.round(box.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.width, box.height);
    if (!this.video.videoWidth) return;
    const r = this.#rect();
    const now = performance.now();
    for (const s of this.strokes) drawStroke(ctx, s, r, now);
  }
}

export function drawStroke(ctx, s, r, now = performance.now()) {
  if (!s.pts.length) return;
  let alpha = s.tool === 'highlighter' ? 0.4 : 1;
  if (s.tool === 'highlighter' && s.ended) alpha *= Math.max(0, 1 - (now - s.ended) / FADE_MS);
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const [x0, y0] = s.pts[0];
  ctx.moveTo(r.x + x0 * r.width, r.y + y0 * r.height);
  if (s.pts.length === 1) ctx.lineTo(r.x + x0 * r.width + 0.1, r.y + y0 * r.height);
  for (let i = 1; i < s.pts.length; i++) ctx.lineTo(r.x + s.pts[i][0] * r.width, r.y + s.pts[i][1] * r.height);
  ctx.stroke();
  ctx.restore();
}
