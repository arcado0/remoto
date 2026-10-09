// Doppi di test per trasporti, engine, prompt e server.
import { EventEmitter } from 'node:events';

/** Due trasporti collegati: ciò che uno invia l'altro lo riceve (in modo asincrono). */
export function transportPair({ sid = 'sessione-test-1', aPeer = '111111111', bPeer = '222222222', kind = 'direct', verified = false } = {}) {
  const mk = (peerId) => {
    const t = new EventEmitter();
    Object.assign(t, { kind, sid, peerId, verified, address: '10.0.0.9', closed: false, sent: [] });
    t.deliver = (d) => {
      if (!t.closed) t.emit('message', d);
    };
    t.close = (why) => {
      if (t.closed) return;
      t.closed = true;
      t.emit('close', why);
      setImmediate(() => other(t).close(why));
    };
    t.send = (d) => {
      if (t.closed) return false;
      t.sent.push(d);
      const o = other(t);
      setImmediate(() => o.deliver(structuredClone(d)));
      return true;
    };
    return t;
  };
  const a = mk(bPeer);
  const b = mk(aPeer);
  const other = (t) => (t === a ? b : a);
  return [a, b];
}

export function fakeEngine() {
  const calls = [];
  return {
    calls,
    start: (info) => calls.push(['start', info]),
    signal: (id, data) => calls.push(['signal', id, data]),
    stop: (id) => calls.push(['stop', id]),
    setPermissions: (id, perms) => calls.push(['perms', id, perms]),
    last: (name) => [...calls].reverse().find((c) => c[0] === name),
  };
}

/** Prompt controllabile dal test: answer() risolve l'ultima richiesta aperta. */
export function fakePrompts() {
  const opened = [];
  return {
    opened,
    open(request) {
      let resolve;
      const result = new Promise((r) => (resolve = r));
      const entry = { request, closed: false, answer: (v) => resolve(v) };
      opened.push(entry);
      return { result, close: () => (entry.closed = true) };
    },
  };
}

export function memoryKeystore() {
  const map = new Map();
  return {
    map,
    get: async (id) => map.get(id) || null,
    set: async (id, v) => void map.set(id, v),
    delete: async (id) => void map.delete(id),
  };
}

/** Server ID finto: instrada relay tra più "link". */
export function fakeServer() {
  const links = new Map();
  return {
    link(id, { online = true } = {}) {
      const l = new EventEmitter();
      l.online = online;
      l.iceServers = [{ urls: ['stun:stun.test:3478'] }];
      l.relay = (to, sid, data) => {
        if (!l.online) return false;
        const target = links.get(to);
        setImmediate(() => {
          if (!target || !target.online) l.emit('relay-fail', { to, sid, code: 'offline' });
          else target.emit('relay', { from: id, sid, data: structuredClone(data) });
        });
        return true;
      };
      links.set(id, l);
      return l;
    },
  };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await tick(5);
  }
  throw new Error('condizione non raggiunta: ' + fn.toString().slice(0, 80));
}
