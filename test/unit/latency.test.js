// Opzioni di Chromium per la bassa latenza e preset video.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeList, parseFieldTrials, mergeFieldTrials, applyChromiumFlags, LOW_LATENCY_TRIALS } from '../../src/main/chromium-flags.js';
import { QUALITY_PRESETS, CAPTURE_FRAMERATE, getPreset } from '../../src/shared/quality.js';

test('mergeList unisce senza duplicati e senza perdere i valori già passati', () => {
  assert.equal(mergeList('', ['A']), 'A');
  assert.equal(mergeList(null, ['A', 'B']), 'A,B');
  assert.equal(mergeList('X, A', ['A', 'B']), 'X,A,B');
});

test('field trial: lettura e unione, vince quello passato a mano', () => {
  assert.deepEqual(parseFieldTrials('T1/G1/T2/k:1,j:2/'), [['T1', 'G1'], ['T2', 'k:1,j:2']]);
  assert.deepEqual(parseFieldTrials(''), []);
  assert.equal(mergeFieldTrials('', { A: 'x:0' }), 'A/x:0/');
  assert.equal(mergeFieldTrials('B/y/', { A: 'x:0' }), 'B/y/A/x:0/');
  assert.equal(mergeFieldTrials('A/Disabled/', { A: 'x:0' }), 'A/Disabled/');
});

test('applyChromiumFlags aggiunge ritardo di riproduzione zero in ricezione e in invio', () => {
  const switches = new Map([['disable-features', 'Utente']]);
  const cl = { getSwitchValue: (n) => switches.get(n) || '', appendSwitch: (n, v) => switches.set(n, v) };
  applyChromiumFlags(cl, { disableFeatures: ['WebRtcHideLocalIpsWithMdns'], fieldTrials: LOW_LATENCY_TRIALS });
  assert.equal(switches.get('disable-features'), 'Utente,WebRtcHideLocalIpsWithMdns');
  const trials = Object.fromEntries(parseFieldTrials(switches.get('force-fieldtrials')));
  assert.equal(trials['WebRTC-ForcePlayoutDelay'], 'min_ms:0,max_ms:0');
  assert.equal(trials['WebRTC-ForceSendPlayoutDelay'], 'min_ms:0,max_ms:0');
});

test('preset: la cattura va almeno veloce quanto ogni preset, "Bilanciata" privilegia la reattività', () => {
  for (const p of Object.values(QUALITY_PRESETS)) assert.ok(CAPTURE_FRAMERATE >= p.maxFramerate);
  assert.ok(CAPTURE_FRAMERATE >= 60, 'a 30 fps Windows Graphics Capture aggiunge ~90 ms');
  for (const p of Object.values(QUALITY_PRESETS)) assert.equal(p.contentHint, 'motion', 'con "detail" i fotogrammi grandi si accodano: p90 ~500 ms');
  assert.equal(getPreset('quality').degradation, 'maintain-resolution');
  assert.equal(getPreset('sconosciuto'), QUALITY_PRESETS.balanced);
});

test('withVideoBitrates: parametri di banda sui codec video, non sull’audio né su rtx', async () => {
  const { withVideoBitrates } = await import('../../src/shared/sdp.js');
  const sdp = [
    'v=0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98',
    'a=rtpmap:96 H264/90000',
    'a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;x-google-start-bitrate=300',
    'a=rtpmap:97 rtx/90000',
    'a=fmtp:97 apt=96',
    'a=rtpmap:98 VP8/90000',
    '',
  ].join('\r\n');
  const out = withVideoBitrates(sdp, { startKbps: 10000, minKbps: 1500 });
  assert.match(out, /a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;x-google-start-bitrate=10000;x-google-min-bitrate=1500\r\n/);
  assert.match(out, /a=rtpmap:98 VP8\/90000\r\na=fmtp:98 x-google-start-bitrate=10000;x-google-min-bitrate=1500/);
  assert.match(out, /a=fmtp:97 apt=96\r\n/, 'rtx invariato');
  assert.match(out, /a=fmtp:111 minptime=10;useinbandfec=1\r\n/, 'audio invariato');
  assert.equal(withVideoBitrates(sdp, {}), sdp);
});
