// Geometria: dal punto cliccato nel video al pixel fisico del monitor remoto.

export const NORM_MAX = 65535;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Rettangolo occupato dal video dentro il suo box con object-fit: contain. */
export function containRect(videoW, videoH, boxW, boxH) {
  if (!(videoW > 0 && videoH > 0 && boxW > 0 && boxH > 0)) {
    return { x: 0, y: 0, width: Math.max(0, boxW || 0), height: Math.max(0, boxH || 0) };
  }
  const scale = Math.min(boxW / videoW, boxH / videoH);
  const width = videoW * scale;
  const height = videoH * scale;
  return { x: (boxW - width) / 2, y: (boxH - height) / 2, width, height };
}

/**
 * Punto (relativo al box) → coordinate normalizzate intere 0..65535.
 * Fuori dal rettangolo restituisce null, a meno di `clampOutside` (utile durante i trascinamenti).
 */
export function toNormalized(px, py, rect, clampOutside = false) {
  if (!(rect.width > 0 && rect.height > 0)) return null;
  let fx = (px - rect.x) / rect.width;
  let fy = (py - rect.y) / rect.height;
  if (!clampOutside && (fx < 0 || fy < 0 || fx > 1 || fy > 1)) return null;
  fx = clamp(fx, 0, 1);
  fy = clamp(fy, 0, 1);
  return { x: Math.round(fx * NORM_MAX), y: Math.round(fy * NORM_MAX) };
}

/** Coordinate normalizzate → pixel fisico dentro il monitor (rect in pixel fisici). */
export function toScreenPoint(nx, ny, rect) {
  const fx = clamp(Number(nx) || 0, 0, NORM_MAX) / NORM_MAX;
  const fy = clamp(Number(ny) || 0, 0, NORM_MAX) / NORM_MAX;
  return {
    x: rect.x + Math.round(fx * Math.max(0, rect.width - 1)),
    y: rect.y + Math.round(fy * Math.max(0, rect.height - 1)),
  };
}

/**
 * Pixel fisico → coordinate assolute per SendInput (MOUSEEVENTF_VIRTUALDESK).
 * Windows calcola x = floor(dx * larghezza / 65536): con il ceil si ricade esattamente sul pixel.
 */
export function toAbsoluteInput(x, y, virt) {
  return {
    dx: clamp(Math.ceil(((x - virt.x) * 65536) / virt.width), 0, 65535),
    dy: clamp(Math.ceil(((y - virt.y) * 65536) / virt.height), 0, 65535),
  };
}

/** Inverso di toAbsoluteInput, come lo calcola Windows (usato nei test). */
export function fromAbsoluteInput(dx, dy, virt) {
  return {
    x: virt.x + Math.floor((dx * virt.width) / 65536),
    y: virt.y + Math.floor((dy * virt.height) / 65536),
  };
}

/** Converte un delta della rotellina del browser in unità WHEEL_DELTA (120 = uno scatto). */
export function wheelUnits(delta, deltaMode) {
  if (deltaMode === 1) return -delta * 40; // righe: 3 righe = 1 scatto
  if (deltaMode === 2) return -delta * 120; // pagine
  return (-delta * 120) / 100; // pixel: Chromium su Windows usa 100 px per scatto
}
