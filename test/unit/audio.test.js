// Audio "solo da chi controlla": casse silenziate e microfono di chi controlla durante la sessione,
// tutto ripristinato a fine sessione (anche dopo un arresto improvviso).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AudioRedirect, pairedCapture } from '../../src/main/features/audio-redirect.js';

const silent = { info() {}, warn() {} };

/** Dispositivi audio finti di un portatile con VB-CABLE. */
function fakeDevices() {
  const st = {
    render: [
      { id: 'r-spk', name: 'Altoparlanti (Realtek(R) Audio)', muted: false, isDefault: true, isDefaultComm: true },
      { id: 'r-hdmi', name: 'LG TV (NVIDIA High Definition Audio)', muted: false, isDefault: false, isDefaultComm: false },
      { id: 'r-cable', name: 'CABLE Input (VB-Audio Virtual Cable)', muted: false, isDefault: false, isDefaultComm: false },
    ],
    capture: [
      { id: 'c-mic', name: 'Microfono (Realtek(R) Audio)', muted: false, isDefault: true, isDefaultComm: true },
      { id: 'c-cam', name: 'Microfono (Webcam HD)', muted: true, isDefault: false, isDefaultComm: false },
      { id: 'c-cable', name: 'CABLE Output (VB-Audio Virtual Cable)', muted: false, isDefault: false, isDefaultComm: false },
    ],
  };
  const all = () => [...st.render, ...st.capture];
  return {
    st,
    audioDevicesAvailable: () => true,
    listDevices: (flow) => st[flow].map((d) => ({ ...d })),
    setMuted: (id, on) => {
      all().find((d) => d.id === id).muted = on;
    },
    setDefault: (id, roles = ['console', 'multimedia', 'communications']) => {
      const flow = st.render.some((d) => d.id === id) ? 'render' : 'capture';
      for (const d of st[flow]) {
        if (roles.includes('console')) d.isDefault = d.id === id;
        if (roles.includes('communications')) d.isDefaultComm = d.id === id;
      }
    },
  };
}

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'remoto-audio-')), 'ripristino.json');

test('pairedCapture: dal lato "casse" del cavo virtuale al suo lato "microfono"', () => {
  const caps = fakeDevices().listDevices('capture');
  assert.equal(pairedCapture('CABLE Input (VB-Audio Virtual Cable)', caps).id, 'c-cable');
  assert.equal(pairedCapture('Altoparlanti (Realtek(R) Audio)', caps), null, 'un dispositivo vero non è un cavo');
  const steam = [{ id: 's', name: 'Microfono (Steam Streaming Microphone)', muted: false }];
  assert.equal(pairedCapture('Altoparlanti (Steam Streaming Microphone)', steam).id, 's');
});

test('durante la sessione: casse silenziate e voce di chi controlla come microfono; poi tutto come prima', () => {
  const dev = fakeDevices();
  const file = tmpFile();
  const a = new AudioRedirect({ devices: dev, file, logger: silent });
  a.setSpeakers('s1', true);
  assert.equal(dev.st.render.find((d) => d.id === 'r-spk').muted, true, 'casse predefinite silenziate');
  assert.equal(dev.st.render.find((d) => d.id === 'r-cable').muted, false, 'il cavo virtuale non si tocca');
  a.setMic('s1', 'CABLE Input (VB-Audio Virtual Cable)');
  const cap = Object.fromEntries(dev.st.capture.map((d) => [d.id, d]));
  assert.equal(cap['c-cable'].isDefault, true);
  assert.equal(cap['c-cable'].isDefaultComm, true);
  assert.equal(cap['c-mic'].muted, true, 'microfono del PC silenziato');
  assert.ok(fs.existsSync(file), 'stato da ripristinare salvato');
  assert.deepEqual(a.state(), { speakersMuted: true, micRedirected: true, micDevice: 'CABLE Output (VB-Audio Virtual Cable)' });

  a.release('s1');
  assert.equal(dev.st.render.find((d) => d.id === 'r-spk').muted, false);
  assert.equal(cap['c-mic'].isDefault, true);
  assert.equal(cap['c-mic'].isDefaultComm, true);
  assert.equal(cap['c-mic'].muted, false);
  assert.equal(cap['c-cam'].muted, true, 'era già silenziato: resta com’era');
  assert.equal(fs.existsSync(file), false);
});

test('più sessioni: si ripristina solo quando finisce l’ultima', () => {
  const dev = fakeDevices();
  const a = new AudioRedirect({ devices: dev, file: tmpFile(), logger: silent });
  a.setSpeakers('s1', true);
  a.setSpeakers('s2', true);
  a.release('s1');
  assert.equal(dev.st.render.find((d) => d.id === 'r-spk').muted, true);
  a.release('s2');
  assert.equal(dev.st.render.find((d) => d.id === 'r-spk').muted, false);
});

test('impostazione disattivata o senza cavo virtuale: non si tocca nulla', () => {
  const dev = fakeDevices();
  let on = false;
  const a = new AudioRedirect({ devices: dev, file: tmpFile(), enabled: () => on, logger: silent });
  a.setSpeakers('s1', true);
  a.setMic('s1', 'CABLE Input (VB-Audio Virtual Cable)');
  assert.equal(dev.st.render[0].muted, false);
  assert.equal(dev.st.capture[0].isDefault, true);
  on = true;
  a.refresh();
  assert.equal(dev.st.render[0].muted, true, 'riattivata durante la sessione: si applica subito');
  assert.equal(dev.st.capture.find((d) => d.id === 'c-cable').isDefault, true);
  // la voce remota passa dal cavo alle casse vere: niente cavo, il microfono torna quello del PC
  a.setMic('s1', 'Altoparlanti (Realtek(R) Audio)');
  assert.equal(dev.st.capture[0].isDefault, true, 'senza cavo virtuale il microfono resta quello del PC');
  assert.equal(dev.st.capture[0].muted, false);
});

test('arresto improvviso durante la sessione: al riavvio casse e microfoni tornano come prima', () => {
  const dev = fakeDevices();
  const file = tmpFile();
  const a = new AudioRedirect({ devices: dev, file, logger: silent });
  a.setSpeakers('s1', true);
  a.setMic('s1', 'CABLE Input (VB-Audio Virtual Cable)');
  // l'app "muore" qui: un nuovo avvio legge il file di ripristino
  const b = new AudioRedirect({ devices: dev, file, logger: silent });
  assert.equal(b.recover(), true);
  assert.equal(dev.st.render[0].muted, false);
  assert.equal(dev.st.capture.find((d) => d.id === 'c-mic').isDefault, true);
  assert.equal(dev.st.capture.find((d) => d.id === 'c-mic').muted, false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(new AudioRedirect({ devices: dev, file, logger: silent }).recover(), false, 'niente da ripristinare');
});

test('cavo virtuale: pacchetto ufficiale più recente, firma VB-Audio, installazione con UAC', async () => {
  const { findPackUrl, signatureOk, VirtualCableInstaller } = await import('../../src/main/features/virtual-cable.js');
  const page = '<a href="https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack43.zip">43</a> <a href="//evil.example/Download_CABLE/VBCABLE_Driver_Pack45.zip">45</a>';
  assert.equal(findPackUrl(page), 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip', 'solo il nome del file: l’host resta quello ufficiale');
  assert.equal(findPackUrl('<html>niente</html>'), null);
  assert.equal(signatureOk('Valid|CN=VB-Audio Software, O=VB-Audio Software, C=FR'), true);
  assert.equal(signatureOk('Valid|CN=Altro Editore'), false);
  assert.equal(signatureOk('NotSigned|'), false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remoto-cavo-'));
  const calls = [];
  const fakeFetch = async (url) => ({
    ok: true,
    status: 200,
    text: async () => page,
    arrayBuffer: async () => new Uint8Array([80, 75, 3, 4]).buffer,
    url,
  });
  const fakeExec = (sig, installCode) => async (cmd, args) => {
    calls.push([path.basename(cmd), args.join(' ')]);
    if (/tar/i.test(cmd)) {
      fs.writeFileSync(path.join(args[3], 'VBCABLE_Setup_x64.exe'), 'MZ');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args.join(' ').includes('Get-AuthenticodeSignature')) return { code: 0, stdout: sig, stderr: '' };
    return { code: installCode, stdout: '', stderr: installCode === 1223 ? 'The operation was canceled by the user.' : '' };
  };
  const steps = [];
  const ok = await new VirtualCableInstaller({ dir, fetch: fakeFetch, exec: fakeExec('Valid|CN=VB-Audio Software', 0), arch: 'x64', platform: 'win32', logger: silent }).install((s) => steps.push(s));
  assert.deepEqual(ok, { ok: true });
  assert.deepEqual(steps, ['download', 'verify', 'install']);
  assert.match(calls.at(-1)[1], /-Verb RunAs/);
  assert.match(calls.at(-1)[1], /'-i','-h'/);

  calls.length = 0;
  const bad = await new VirtualCableInstaller({ dir, fetch: fakeFetch, exec: fakeExec('Valid|CN=Qualcun Altro', 0), arch: 'x64', platform: 'win32', logger: silent }).install();
  assert.equal(bad.ok, false);
  assert.match(bad.error, /firma/);
  assert.ok(!calls.some(([, a]) => /RunAs/.test(a)), 'con la firma sbagliata non si esegue nulla');

  const cancelled = await new VirtualCableInstaller({ dir, fetch: fakeFetch, exec: fakeExec('Valid|CN=VB-Audio Software', 1223), arch: 'x64', platform: 'win32', logger: silent }).install();
  assert.equal(cancelled.cancelled, true);
});
