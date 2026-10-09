// Più strade verso la stessa postazione (indirizzi diversi, TCP o UDP) provate in parallelo:
// vince la prima che risponde, le altre vengono annullate o chiuse. Prima si provava un indirizzo
// alla volta, con 4 s di attesa per ognuno che non rispondeva (le schede virtuali tipo Hyper-V/VPN).

/**
 * @param {Array<{label: string, delayMs?: number, start: (signal: AbortSignal) => Promise<{transport, peer}>}>} attempts
 *   delayMs: partenza ritardata (per preferire le altre strade se rispondono subito); parte comunque
 *   appena tutte quelle già avviate sono fallite.
 * @param {{accept?: (res: {transport, peer}) => boolean}} [opts]  false = risposta di un'altra postazione
 * @returns {Promise<{transport, peer, via: string}>}
 */
export function firstConnection(attempts, { accept = () => true } = {}) {
  return new Promise((resolve, reject) => {
    const ctl = new AbortController();
    const errors = [];
    const items = attempts.map((a) => ({ a, state: 'waiting', timer: null }));
    let done = false;

    const settleFailure = () => {
      if (done) return;
      if (items.some((i) => i.state === 'running')) return;
      const waiting = items.filter((i) => i.state === 'waiting');
      if (waiting.length) {
        // le strade avviate sono fallite tutte: inutile aspettare il ritardo delle altre
        for (const i of waiting) run(i);
        return;
      }
      done = true;
      reject(combineErrors(errors));
    };
    const run = (item) => {
      if (done || item.state !== 'waiting') return;
      clearTimeout(item.timer);
      item.state = 'running';
      const { a } = item;
      Promise.resolve()
        .then(() => a.start(ctl.signal))
        .then(
          (res) => {
            item.state = 'done';
            if (done) {
              res.transport.close('superseded');
              return;
            }
            if (!accept(res)) {
              res.transport.close('wrong-peer');
              errors.push(Object.assign(new Error('risponde un’altra postazione'), { code: 'unreachable', label: a.label }));
              settleFailure();
              return;
            }
            done = true;
            for (const i of items) clearTimeout(i.timer);
            ctl.abort();
            resolve({ ...res, via: a.label });
          },
          (err) => {
            item.state = 'done';
            const e = err instanceof Error ? err : new Error(String(err));
            e.label = a.label;
            errors.push(e);
            settleFailure();
          },
        );
    };

    if (!items.length) {
      done = true;
      reject(Object.assign(new Error('nessun percorso'), { code: 'unreachable', errors }));
      return;
    }
    for (const i of items) {
      if (i.a.delayMs > 0) i.timer = setTimeout(() => run(i), i.a.delayMs);
    }
    for (const i of items) if (!(i.a.delayMs > 0)) run(i);
  });
}

/** Un solo errore che riassume i tentativi: "version" se l'altra parte è incompatibile, altrimenti "unreachable". */
export function combineErrors(errors) {
  const real = errors.filter((e) => e.code !== 'aborted');
  const code = real.some((e) => e.code === 'version') ? 'version' : 'unreachable';
  const detail = real.map((e) => `${e.label || '?'}: ${e.message}`).join('; ');
  return Object.assign(new Error(detail || 'irraggiungibile'), { code, errors: real, detail });
}
