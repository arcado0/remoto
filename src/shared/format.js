// Formattazione in italiano per l'interfaccia.

const nf1 = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 });

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${nf1.format(x)} ${units[i]}`;
}

export function formatBitrate(bps) {
  const v = Number(bps) || 0;
  if (v >= 1e6) return `${nf1.format(v / 1e6)} Mbit/s`;
  if (v >= 1e3) return `${nf1.format(v / 1e3)} kbit/s`;
  return `${Math.round(v)} bit/s`;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatRelativeTime(ts, now = Date.now()) {
  if (!ts) return 'mai';
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'adesso';
  if (min < 60) return `${min} min fa`;
  const h = Math.floor(min / 60);
  if (h < 24) return h === 1 ? 'un’ora fa' : `${h} ore fa`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'ieri';
  if (d < 7) return `${d} giorni fa`;
  return new Date(ts).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(ts) {
  return new Date(ts).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function initials(name) {
  const parts = String(name ?? '').trim().split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return '?';
  const letters = parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0];
  return letters.toUpperCase();
}

/** Colore stabile (tonalità HSL) derivato da una stringa, per gli avatar. */
export function hueFor(text) {
  let h = 0;
  for (const ch of String(text ?? '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}
