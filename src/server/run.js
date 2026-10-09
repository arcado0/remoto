// Opzioni del server ID da riga di comando o da variabili d'ambiente REMOTO_*.
// Usato da `node src/server/cli.js` e da `Remoto.exe --server` (nessun Node da installare).
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_PORTS, DEFAULT_STUN } from '../shared/protocol.js';

export const SERVER_HELP = `Remoto - server ID

Uso: node src/server/cli.js [opzioni]      oppure      Remoto.exe --server [opzioni]

  --port <n>            porta (REMOTO_PORT, predefinita ${DEFAULT_PORTS.server})
  --host <ip>           indirizzo di ascolto (REMOTO_HOST, predefinito 0.0.0.0)
  --data <cartella>     dove salvare il registro degli ID (REMOTO_DATA_DIR)
  --name <testo>        nome mostrato nella pagina di stato (REMOTO_NAME)
  --stun <url,...>      server STUN da comunicare ai client (REMOTO_STUN_URLS)
  --turn-urls <url,...> server TURN, es. turn:turn.example.com:3478 (REMOTO_TURN_URLS)
  --turn-secret <s>     segreto condiviso con coturn (static-auth-secret) (REMOTO_TURN_SECRET)
  --turn-ttl <sec>      validità delle credenziali TURN (REMOTO_TURN_TTL, predefinita 86400)
  --tls-cert <file>     certificato PEM per servire wss:// (REMOTO_TLS_CERT)
  --tls-key <file>      chiave PEM (REMOTO_TLS_KEY)
  --trust-proxy         usa X-Forwarded-For (dietro Caddy/nginx) (REMOTO_TRUST_PROXY=1)
`;

const OPTIONS = {
  port: { type: 'string' },
  host: { type: 'string' },
  data: { type: 'string' },
  name: { type: 'string' },
  stun: { type: 'string' },
  'turn-urls': { type: 'string' },
  'turn-secret': { type: 'string' },
  'turn-ttl': { type: 'string' },
  'tls-cert': { type: 'string' },
  'tls-key': { type: 'string' },
  'trust-proxy': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

/** Opzioni per createRendezvousServer a partire da argomenti e ambiente. */
export function serverOptions(argv, env = process.env, { defaultDataDir = './data' } = {}) {
  const { values: args } = parseArgs({ args: argv, options: OPTIONS, strict: false, allowPositionals: true });
  const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  const pick = (a, e, d) => a ?? env[e] ?? d;
  const certFile = pick(args['tls-cert'], 'REMOTO_TLS_CERT');
  const keyFile = pick(args['tls-key'], 'REMOTO_TLS_KEY');
  const stun = pick(args.stun, 'REMOTO_STUN_URLS');
  return {
    help: Boolean(args.help),
    options: {
      port: Number(pick(args.port, 'REMOTO_PORT', DEFAULT_PORTS.server)),
      host: pick(args.host, 'REMOTO_HOST', '0.0.0.0'),
      dataDir: path.resolve(pick(args.data, 'REMOTO_DATA_DIR', defaultDataDir)),
      name: pick(args.name, 'REMOTO_NAME', 'Remoto ID server'),
      stunUrls: stun !== undefined ? list(stun) : [...DEFAULT_STUN],
      turnUrls: list(pick(args['turn-urls'], 'REMOTO_TURN_URLS', '')),
      turnSecret: pick(args['turn-secret'], 'REMOTO_TURN_SECRET', ''),
      turnTtl: Number(pick(args['turn-ttl'], 'REMOTO_TURN_TTL', 86400)),
      tls: certFile && keyFile ? { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) } : null,
      trustProxy: Boolean(args['trust-proxy'] || env.REMOTO_TRUST_PROXY === '1'),
    },
  };
}

export function consoleLogger(stream = null) {
  const write = (level, m) => {
    const line = `${new Date().toISOString()} ${level} ${m}`;
    (level === 'ERROR' ? console.error : console.log)(line);
    stream?.write(`${line}\n`);
  };
  return { info: (m) => write('INFO ', m), warn: (m) => write('WARN ', m), error: (m) => write('ERROR', m) };
}
