// Client WebSocket per i test: coda dei messaggi ricevuti con attesa su predicato.
import { WebSocket } from 'ws';

export function wsClient(url) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  let closeInfo = null;
  const closed = new Promise((resolve) => {
    ws.on('close', (code, reason) => {
      closeInfo = { code, reason: reason.toString() };
      resolve(closeInfo);
    });
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) {
      const [w] = waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    } else inbox.push(msg);
  });
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return {
    ws,
    opened,
    closed,
    get closeInfo() {
      return closeInfo;
    },
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    next(pred = () => true, timeoutMs = 3000) {
      const p = typeof pred === 'string' ? (m) => m.t === pred : pred;
      const i = inbox.findIndex(p);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { pred: p, resolve, timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`timeout in attesa di un messaggio (${pred.toString().slice(0, 60)})`));
        }, timeoutMs) };
        waiters.push(w);
      });
    },
    close() {
      ws.close();
    },
  };
}

export const SECRET_A = 'a'.repeat(64);
export const SECRET_B = 'b'.repeat(64);
