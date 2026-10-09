#!/usr/bin/env node
// Avvio del server ID come processo autonomo (VPS, Docker, servizio).
// Su Windows lo stesso server parte anche senza Node con: Remoto.exe --server
import { createRendezvousServer } from './core.js';
import { serverOptions, consoleLogger, SERVER_HELP } from './run.js';

const { help, options } = serverOptions(process.argv.slice(2));
if (help) {
  console.log(SERVER_HELP);
  process.exit(0);
}

const logger = consoleLogger();
const server = createRendezvousServer({ ...options, logger });
await server.start();

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info(`${signal}: arresto in corso`);
  await server.stop();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
