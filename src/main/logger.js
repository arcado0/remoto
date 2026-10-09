// Log su file nella cartella del profilo (ruotato a 5 MB, tre copie).
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

const MAX_BYTES = 5 * 1024 * 1024;

function rotate(file) {
  try {
    if (fs.statSync(file).size < MAX_BYTES) return;
  } catch {
    return;
  }
  for (let i = 2; i >= 1; i--) {
    const from = file.replace(/\.log$/, `.${i}.log`);
    const to = file.replace(/\.log$/, `.${i + 1}.log`);
    if (fs.existsSync(from)) fs.renameSync(from, to);
  }
  fs.renameSync(file, file.replace(/\.log$/, '.1.log'));
}

export function createLogger(dir, { toConsole = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'remoto.log');
  rotate(file);
  const stream = fs.createWriteStream(file, { flags: 'a' });
  const write = (level, args) => {
    const text = args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 4, breakLength: 160 }))).join(' ');
    const line = `${new Date().toISOString()} ${level} ${text}\n`;
    stream.write(line);
    if (toConsole) (level === 'ERROR' ? console.error : console.log)(line.trimEnd());
  };
  return {
    dir,
    file,
    info: (...a) => write('INFO ', a),
    warn: (...a) => write('WARN ', a),
    error: (...a) => write('ERROR', a),
    close: () => stream.end(),
  };
}
