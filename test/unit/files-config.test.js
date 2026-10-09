import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { FileService } from '../../src/main/features/files.js';
import { ConfigStore, deepMerge, defaultConfig } from '../../src/main/config.js';
import { lookupKey, comboSequence, KEYMAP } from '../../src/main/native/keymap.js';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remoto-fs-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function copyThrough(svc, src, destDir) {
  const { files } = await svc.expand([src]);
  const ctx = await svc.beginWrite(destDir);
  for (const f of files) {
    if (f.dir) {
      await svc.openWrite(ctx, f.rel, { dir: true });
      continue;
    }
    const r = await svc.openRead(f.abs);
    const w = await svc.openWrite(ctx, f.rel);
    for (;;) {
      const chunk = await svc.read(r, 7000);
      if (!chunk.length) break;
      svc.write(w, chunk);
    }
    await svc.closeRead(r);
    await svc.finishWrite(w);
  }
  return svc.endWrite(ctx);
}

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

test('list ordina cartelle prima dei file e nasconde i parziali', async () => {
  fs.mkdirSync(path.join(dir, 'zeta'));
  fs.writeFileSync(path.join(dir, 'b.txt'), 'bb');
  fs.writeFileSync(path.join(dir, 'a10.txt'), 'a');
  fs.writeFileSync(path.join(dir, 'a2.txt'), 'a');
  fs.writeFileSync(path.join(dir, 'x.remoto-part'), '');
  const svc = new FileService();
  const res = await svc.list(dir);
  assert.deepEqual(res.entries.map((e) => e.name), ['zeta', 'a2.txt', 'a10.txt', 'b.txt']);
  assert.equal(res.entries[3].size, 2);
  assert.equal(res.parent, path.dirname(dir));
  await assert.rejects(svc.list(path.join(dir, 'non-esiste')), /inesistente/);
});

test('copia di file e cartelle (anche vuote) con integrità e nomi in conflitto', async () => {
  const src = path.join(dir, 'Foto');
  fs.mkdirSync(path.join(src, 'sotto', 'vuota'), { recursive: true });
  fs.writeFileSync(path.join(src, 'grande.bin'), crypto.randomBytes(300_000));
  fs.writeFileSync(path.join(src, 'sotto', 'nota.txt'), 'ciao');
  const dest = path.join(dir, 'dest');
  fs.mkdirSync(dest);
  const svc = new FileService();
  await copyThrough(svc, src, dest);
  assert.equal(sha(path.join(dest, 'Foto', 'grande.bin')), sha(path.join(src, 'grande.bin')));
  assert.equal(fs.readFileSync(path.join(dest, 'Foto', 'sotto', 'nota.txt'), 'utf8'), 'ciao');
  assert.ok(fs.statSync(path.join(dest, 'Foto', 'sotto', 'vuota')).isDirectory());
  // seconda copia: la cartella di primo livello diventa "Foto (1)" per tutti i file
  await copyThrough(svc, src, dest);
  assert.ok(fs.existsSync(path.join(dest, 'Foto (1)', 'sotto', 'nota.txt')));
  assert.ok(fs.existsSync(path.join(dest, 'Foto (1)', 'grande.bin')));
  // file singolo in conflitto
  const single = path.join(dir, 'doc.txt');
  fs.writeFileSync(single, 'x');
  await copyThrough(svc, single, dest);
  await copyThrough(svc, single, dest);
  assert.ok(fs.existsSync(path.join(dest, 'doc (1).txt')));
  assert.equal(fs.readdirSync(dest).filter((n) => n.endsWith('.remoto-part')).length, 0);
});

test('openWrite rifiuta percorsi che escono dalla destinazione; abort cancella il parziale', async () => {
  const svc = new FileService();
  const ctx = await svc.beginWrite(dir);
  await assert.rejects(svc.openWrite(ctx, '../fuori.txt'), /Percorso non valido/);
  await assert.rejects(svc.openWrite(ctx, 'C:\\Windows\\x.txt'), /Percorso non valido/);
  const h = await svc.openWrite(ctx, 'parziale.txt');
  await svc.write(h, Buffer.from('abc'));
  await svc.abortWrite(h);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('mkdir, rename, remove e protezione della radice', async () => {
  const svc = new FileService();
  const p = await svc.mkdir(dir, 'Nuova:cartella');
  assert.equal(path.basename(p), 'Nuova_cartella');
  const r = await svc.rename(p, 'Rinominata');
  assert.ok(fs.existsSync(r));
  fs.mkdirSync(path.join(dir, 'Altra'));
  await assert.rejects(svc.rename(r, 'Altra'), /Esiste già/);
  await svc.remove(r);
  assert.ok(!fs.existsSync(r));
  await assert.rejects(svc.remove(path.parse(dir).root), /non consentita/);
});

test('roots include le cartelle speciali esistenti e almeno un disco', async () => {
  const svc = new FileService({ specialFolders: { desktop: dir, documents: path.join(dir, 'manca') } });
  const roots = await svc.roots();
  assert.ok(roots.some((r) => r.name === 'Desktop' && r.path === dir));
  assert.ok(!roots.some((r) => r.name === 'Documenti'));
  assert.ok(roots.some((r) => r.kind === 'drive'));
});

const fakeCrypt = { encrypt: (s) => 'enc:' + Buffer.from(s).toString('base64'), decrypt: (s) => Buffer.from(s.slice(4), 'base64').toString() };

test('ConfigStore: valori predefiniti, merge, normalizzazione, file corrotto', () => {
  const file = path.join(dir, 'config.json');
  const store = new ConfigStore({ file, crypt: fakeCrypt });
  const c = store.load();
  assert.equal(c.security.allowIncoming, true);
  assert.ok(fs.existsSync(file));
  store.update({ security: { maxSessions: 99, permissions: { files: false, bogus: 1 } } });
  assert.equal(store.get().security.maxSessions, 10);
  assert.equal(store.get().security.permissions.files, false);
  assert.equal('bogus' in store.get().security.permissions, false);
  assert.equal(store.decrypt(store.encrypt('segreto')), 'segreto');
  assert.equal(store.decrypt(null), null);
  const broken = new ConfigStore({ file, crypt: { encrypt: (s) => s, decrypt: () => { throw new Error('DPAPI'); } } });
  assert.equal(broken.decrypt('qualcosa'), null);

  const again = new ConfigStore({ file, crypt: fakeCrypt }).load();
  assert.equal(again.security.permissions.files, false);

  fs.writeFileSync(file, '{non json');
  const fresh = new ConfigStore({ file, crypt: fakeCrypt }).load();
  assert.equal(fresh.security.permissions.files, true);
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('config.json.corrotto-')));
});

test('deepMerge ignora __proto__', () => {
  const merged = deepMerge(defaultConfig(), JSON.parse('{"__proto__": {"inquinato": true}, "general": {"theme": "dark"}}'));
  assert.equal({}.inquinato, undefined);
  assert.equal(merged.general.theme, 'dark');
});

test('keymap: scancode ed estesi corretti, combinazioni ordinate', () => {
  assert.deepEqual(lookupKey('KeyA'), { sc: 0x1e, ext: false });
  assert.deepEqual(lookupKey('ArrowLeft'), { sc: 0x4b, ext: true });
  assert.deepEqual(lookupKey('NumpadEnter'), { sc: 0x1c, ext: true });
  assert.deepEqual(lookupKey('PrintScreen'), { vk: 0x2c });
  assert.equal(lookupKey('toString'), null);
  assert.equal(lookupKey('Inesistente'), null);
  const seq = comboSequence('ctrl-shift-esc');
  assert.deepEqual(seq.map((s) => `${s.code}:${s.down ? 'giu' : 'su'}`), ['ControlLeft:giu', 'ShiftLeft:giu', 'Escape:giu', 'Escape:su', 'ShiftLeft:su', 'ControlLeft:su']);
  assert.equal(comboSequence('ctrl-alt-del'), null);
  const scancodes = Object.values(KEYMAP).filter((k) => 'sc' in k).map((k) => `${k.sc}:${k.ext}`);
  assert.equal(new Set(scancodes).size, scancodes.length, 'nessuno scancode duplicato');
});

test('ConfigStore cancella l’accesso non presidiato delle versioni precedenti, anche su disco', () => {
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({
    security: { allowIncoming: true, accessMode: 'password', unattended: { enabled: true, salt: 'c2FsZQ==', key: 'enc:segreto' } },
    savedAuth: { 222222222: { salt: 'x', key: 'enc:y' } },
    profile: { name: 'Vecchio PC' },
  }));
  const c = new ConfigStore({ file, crypt: fakeCrypt }).load();
  assert.equal('accessMode' in c.security, false);
  assert.equal('unattended' in c.security, false);
  assert.equal('savedAuth' in c, false);
  assert.equal(c.profile.name, 'Vecchio PC');
  const onDisk = fs.readFileSync(file, 'utf8');
  assert.ok(!onDisk.includes('unattended') && !onDisk.includes('savedAuth') && !onDisk.includes('segreto'));
});

import { portableDataDir } from '../../src/main/paths.js';
import { serverOptions } from '../../src/server/run.js';

test('portable: dati accanto al .exe autoestraente o nella cartella Remoto-dati della versione zip', () => {
  const exeDir = path.join(dir, 'chiavetta');
  fs.mkdirSync(exeDir);
  const fromStub = portableDataDir({ isPackaged: true, env: { PORTABLE_EXECUTABLE_DIR: exeDir } });
  assert.equal(fromStub, path.join(exeDir, 'Remoto-dati'));
  assert.ok(fs.existsSync(fromStub), 'la cartella viene creata accanto al .exe portable');

  const unzipped = path.join(dir, 'Remoto');
  fs.mkdirSync(unzipped);
  const exe = path.join(unzipped, 'Remoto.exe');
  assert.equal(portableDataDir({ isPackaged: true, execPath: exe, env: {} }), null, 'senza Remoto-dati: versione installata');
  fs.mkdirSync(path.join(unzipped, 'Remoto-dati'));
  assert.equal(portableDataDir({ isPackaged: true, execPath: exe, env: {} }), path.join(unzipped, 'Remoto-dati'));
  assert.equal(portableDataDir({ isPackaged: true, execPath: exe, env: {}, suffix: '-b' }), null);
  assert.equal(portableDataDir({ isPackaged: false, execPath: exe, env: {} }), null, 'in sviluppo mai portable');
});

test('opzioni del server ID da argomenti e variabili d’ambiente', () => {
  const { options, help } = serverOptions(['--port', '5000', '--turn-urls', 'turn:a:3478, turn:b:3478', 'posizionale'], { REMOTO_TURN_SECRET: 's3', REMOTO_TRUST_PROXY: '1' }, { defaultDataDir: dir });
  assert.equal(help, false);
  assert.equal(options.port, 5000);
  assert.deepEqual(options.turnUrls, ['turn:a:3478', 'turn:b:3478']);
  assert.equal(options.turnSecret, 's3');
  assert.equal(options.trustProxy, true);
  assert.equal(options.dataDir, path.resolve(dir));
  assert.ok(options.stunUrls.length >= 1);
  assert.equal(serverOptions(['--help']).help, true);
  assert.deepEqual(serverOptions(['--stun', ''], {}).options.stunUrls, []);
});
