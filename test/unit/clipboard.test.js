// Appunti: rilevamento di testo e file copiati, niente "eco" di ciò che arriva dall'altro PC,
// formato CF_HDROP e cartella temporanea dei file ricevuti.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ClipboardBridge } from '../../src/main/features/clipboard.js';
import { ClipTemp } from '../../src/main/features/clip-temp.js';
import { dropFilesBuffer } from '../../src/main/native/clipboard-files.js';
import { until } from '../helpers/fakes.js';

/** Appunti finti (Electron + file di Windows) con il contatore di sequenza come Windows. */
function fakeSystem() {
  const st = { text: '', files: null, seq: 1 };
  // API asincrona di Electron 44
  const clipboard = {
    readText: async () => st.text,
    read: async () => (st.image ? [{ types: ['image/png'], getType: async () => new Blob([st.image], { type: 'image/png' }) }] : []),
    writeText: async (t) => {
      st.text = t;
      st.files = null;
      st.image = null;
      st.seq++;
    },
    write: async (items) => {
      st.image = Buffer.from(await (await items[0].getType('image/png')).arrayBuffer());
      st.text = '';
      st.files = null;
      st.seq++;
    },
  };
  const files = {
    hasFiles: () => Boolean(st.files?.length),
    readFiles: () => (st.files ? st.files.slice() : null),
    writeFiles: (paths) => {
      st.files = paths.slice();
      st.text = '';
      st.seq++;
      return true;
    },
  };
  const user = {
    copyText: (t) => clipboard.writeText(t),
    copyFiles: (paths) => files.writeFiles(paths),
    copyImage: (png) => {
      st.image = png;
      st.text = '';
      st.files = null;
      st.seq++;
    },
  };
  return { st, clipboard, files, user, sequence: () => st.seq };
}

test('appunti: testo e file copiati vengono segnalati una volta sola, quelli ricevuti non tornano indietro', async () => {
  const sys = fakeSystem();
  // ClipboardItem minimo come quello di Electron
  class Item {
    constructor(map) {
      this.map = map;
      this.types = Object.keys(map);
    }
    async getType(t) {
      return this.map[t];
    }
  }
  const bridge = new ClipboardBridge({ clipboard: sys.clipboard, ClipboardItem: Item, sequence: sys.sequence, intervalMs: 10, files: sys.files });
  const seen = [];
  bridge.on('change', (p) => seen.push(p));
  bridge.retain();
  try {
    sys.user.copyText('ciao');
    await until(() => seen.length === 1, 2000);
    assert.deepEqual(seen[0], { kind: 'text', data: 'ciao' });

    sys.user.copyFiles(['C:\\Dati\\relazione.docx', 'C:\\Dati\\Foto']);
    await until(() => seen.length === 2, 2000);
    assert.deepEqual(seen[1], { kind: 'files', paths: ['C:\\Dati\\relazione.docx', 'C:\\Dati\\Foto'] });

    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    sys.user.copyImage(png);
    await until(() => seen.length === 3, 2000);
    assert.deepEqual(seen[2], { kind: 'image', data: png.toString('base64') });

    // file arrivati dall'altro PC: finiscono negli appunti ma non vengono ri-annunciati
    assert.equal(bridge.applyFiles(['C:\\Temp\\Remoto-appunti\\1\\relazione.docx']), true);
    assert.deepEqual(sys.st.files, ['C:\\Temp\\Remoto-appunti\\1\\relazione.docx']);
    assert.equal(await bridge.apply({ kind: 'text', data: 'dal PC remoto' }), true);
    assert.equal(sys.st.text, 'dal PC remoto');
    assert.equal(await bridge.apply({ kind: 'image', data: Buffer.from([1, 2, 3, 4]).toString('base64') }), true);
    assert.deepEqual([...sys.st.image], [1, 2, 3, 4]);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(seen.length, 3, 'nessuna eco');
  } finally {
    bridge.release();
  }
});

test('CF_HDROP: intestazione DROPFILES e percorsi UTF-16 terminati da due zeri', () => {
  const b = dropFilesBuffer(['C:\\a.txt', 'D:\\b']);
  assert.equal(b.readUInt32LE(0), 20, 'i nomi iniziano dopo i 20 byte di intestazione');
  assert.equal(b.readInt32LE(16), 1, 'caratteri wide');
  assert.equal(b.subarray(20).toString('utf16le'), 'C:\\a.txt\0D:\\b\0\0');
});

test('cartella temporanea dei file ricevuti: solo le ultime copie, solo percorsi suoi', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'remoto-clip-'));
  const t = new ClipTemp(base, { keep: 2 });
  const a = await t.prepare();
  await new Promise((r) => setTimeout(r, 5));
  const b = await t.prepare();
  await new Promise((r) => setTimeout(r, 5));
  const c = await t.prepare();
  assert.equal(fs.existsSync(a), false, 'la più vecchia è stata cancellata');
  assert.ok(fs.existsSync(b) && fs.existsSync(c));
  fs.writeFileSync(path.join(c, 'nota.txt'), 'x');
  fs.writeFileSync(path.join(c, 'grande.bin.remoto-part'), 'x');
  fs.mkdirSync(path.join(c, 'Foto'));
  assert.deepEqual((await t.entries(c)).map((p) => path.basename(p)).sort(), ['Foto', 'nota.txt']);
  assert.equal(t.owns(c), true);
  assert.equal(t.owns(path.join(c, 'Foto')), false, 'solo sottocartelle dirette');
  assert.equal(t.owns(base), false);
  assert.equal(t.owns(os.tmpdir()), false);
  assert.equal(t.owns(path.join(base, '..', 'altro')), false);
  await t.cleanAll();
  assert.equal(fs.existsSync(base), false);
});
