// Lavagna sul PC controllato: disegna i tratti ricevuti da chi controlla, a coordinate 0..1.
import { drawStroke } from '../session/whiteboard.js';

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const strokes = new Map(); // id → tratto
let anim = 0;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  redraw();
}

function redraw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  const rect = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  const now = performance.now();
  for (const [id, s] of strokes) {
    if (s.tool === 'highlighter' && s.ended && now - s.ended > 2600) {
      strokes.delete(id);
      continue;
    }
    drawStroke(ctx, s, rect, now);
  }
}

function animate() {
  if (anim) return;
  const step = () => {
    redraw();
    anim = [...strokes.values()].some((s) => s.tool === 'highlighter' && s.ended) ? requestAnimationFrame(step) : 0;
  };
  anim = requestAnimationFrame(step);
}

const clamp = (v) => Math.min(1, Math.max(0, Number(v) || 0));
const pt = (p) => (Array.isArray(p) ? [clamp(p[0]), clamp(p[1])] : null);

remoto.on('wb:op', (op) => {
  const key = `${op.owner}:${op.id}`;
  switch (op.op) {
    case 'begin': {
      const p = pt(op.p);
      if (!p) return;
      const width = Math.min(40, Math.max(1, Number(op.w) || 4));
      strokes.set(key, { color: /^#[0-9a-f]{6}$/i.test(op.color) ? op.color : '#ff3b5c', tool: op.tool === 'highlighter' ? 'highlighter' : 'pen', width, pts: [p], ended: 0, owner: op.owner });
      break;
    }
    case 'pts': {
      const s = strokes.get(key);
      if (!s || !Array.isArray(op.pts)) return;
      for (const p of op.pts.slice(0, 500)) {
        const q = pt(p);
        if (q) s.pts.push(q);
      }
      break;
    }
    case 'end': {
      const s = strokes.get(key);
      if (s) {
        s.ended = performance.now();
        animate();
      }
      break;
    }
    case 'clear':
      for (const [k, s] of strokes) if (s.owner === op.owner) strokes.delete(k);
      break;
    default:
      return;
  }
  redraw();
});

window.addEventListener('resize', resize);
resize();
