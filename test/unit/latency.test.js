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
  assert.equal(getPreset('balanced').contentHint, 'motion');
  assert.equal(getPreset('sconosciuto'), QUALITY_PRESETS.balanced);
});
