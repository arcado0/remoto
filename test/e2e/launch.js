// Avvio di istanze di Remoto per i test end-to-end (profili temporanei, rete solo su loopback).
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function launchRemoto({ name, serverUrl = '', directPort = 0, env = {}, args = [] }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `remoto-e2e-${name}-`));
  const app = await electron.launch({
    args: [ROOT, ...args],
    cwd: ROOT,
    env: {
      ...process.env,
      REMOTO_PROFILE_DIR: profile,
      REMOTO_SERVER_URL: serverUrl,
      REMOTO_NAME: name,
      REMOTO_DIRECT_HOST: '127.0.0.1',
      REMOTO_DIRECT_PORT: String(directPort),
      REMOTO_DISCOVERY: '0',
      REMOTO_E2E: '1',
      REMOTO_AUDIO_EXCLUSIVE: '0',
      ...env,
    },
    timeout: 60_000,
  });
  const logs = [];
  app.process().stdout?.on('data', (d) => logs.push(d.toString()));
  app.process().stderr?.on('data', (d) => logs.push(d.toString()));
  return { app, profile, logs };
}

/** Attende una finestra il cui URL contiene `fragment`. */
export async function windowWith(app, fragment, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const w = app.windows().find((p) => p.url().includes(fragment));
    if (w) return w;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`finestra ${fragment} non trovata (aperte: ${app.windows().map((p) => p.url()).join(', ')})`);
}

export async function closeRemoto(inst) {
  if (!inst) return;
  try {
    await inst.app.evaluate(() => globalThis.__remoto?.quit());
  } catch {
    /* già chiusa */
  }
  await Promise.race([inst.app.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  try {
    inst.app.process().kill();
  } catch {
    /* già terminato */
  }
  fs.rmSync(inst.profile, { recursive: true, force: true, maxRetries: 3 });
}
