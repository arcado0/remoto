// Preset di qualità video e preferenza codec.

/**
 * Fotogrammi al secondo della cattura dello schermo, uguali per tutti i preset. Chromium su Windows
 * cattura con Windows Graphics Capture, che consegna immagini vecchie di circa due periodi di
 * cattura: a 30 fps erano ~90 ms di ritardo solo qui, a 60 fps ~32 ms. L'encoder poi ne usa al
 * massimo `maxFramerate` del preset, prendendo sempre il fotogramma più recente.
 */
export const CAPTURE_FRAMERATE = 60;

/**
 * Banda del video nelle sessioni in rete locale (kbit/s): si parte già alti invece di ~300 kbit/s e la
 * stima non può scendere sotto il minimo per le oscillazioni del Wi-Fi (vedi withVideoBitrates in sdp.js).
 * Il massimo resta quello del preset.
 */
export const LAN_BITRATES = Object.freeze({ startKbps: 10_000, minKbps: 1_500 });

// contentHint 'motion' per tutti: con 'detail' (contenuto "schermo") i fotogrammi grandi si accodano
// nell'invio e, con contenuti in movimento, la latenza saliva a ~500 ms (p90); con 'motion' resta ~60 ms
// ed è anche più nitido in movimento. "Qualità" non abbassa mai la risoluzione e ha più banda.
export const QUALITY_PRESETS = Object.freeze({
  quality: { label: 'Qualità ottimale', maxBitrate: 30_000_000, maxFramerate: 60, scale: 1, contentHint: 'motion', degradation: 'maintain-resolution' },
  balanced: { label: 'Bilanciata', maxBitrate: 12_000_000, maxFramerate: 60, scale: 1, contentHint: 'motion', degradation: 'balanced' },
  speed: { label: 'Velocità', maxBitrate: 2_000_000, maxFramerate: 30, scale: 1.5, contentHint: 'motion', degradation: 'maintain-framerate' },
});

export function getPreset(name) {
  return QUALITY_PRESETS[name] || QUALITY_PRESETS.balanced;
}

export const CODECS = Object.freeze([
  { key: 'auto', label: 'Automatico', mime: null },
  { key: 'h264', label: 'H.264', mime: 'video/H264' },
  { key: 'vp9', label: 'VP9', mime: 'video/VP9' },
  { key: 'vp8', label: 'VP8', mime: 'video/VP8' },
  { key: 'av1', label: 'AV1', mime: 'video/AV1' },
]);

/** Il codec scelto con "Automatico". */
export const AUTO_CODEC = 'video/H264';

/**
 * Riordina le capability dei codec mettendo prima quello preferito.
 * Le voci ausiliarie (rtx, red, ulpfec) restano in coda.
 */
export function orderCodecs(codecs, preferredKey) {
  const mime = preferredKey === 'auto' ? AUTO_CODEC : CODECS.find((c) => c.key === preferredKey)?.mime;
  if (!mime) return codecs.slice();
  const lower = mime.toLowerCase();
  const first = codecs.filter((c) => c.mimeType.toLowerCase() === lower);
  if (!first.length) return codecs.slice();
  return [...first, ...codecs.filter((c) => c.mimeType.toLowerCase() !== lower)];
}
