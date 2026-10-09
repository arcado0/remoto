// Segnalazione in rete locale su UDP: l'alternativa alla connessione TCP diretta che funziona anche
// quando il Windows Firewall del PC da controllare blocca le connessioni in entrata (al primo avvio
// qualcuno ha premuto "Annulla", oppure la rete è "Pubblica" e Remoto è consentito solo sulle private).
//
// Come attraversa il firewall senza regole:
//   - il PC controllato (B) annuncia la sua presenza in broadcast ogni pochi secondi dalla porta del
//     rilevamento, e Windows lascia entrare per 3 secondi le risposte unicast a un broadcast inviato;
//   - chi si collega (A) manda lì "hi" (più volte, finché non risponde); B risponde "ok" e da quel
//     momento ciascuno dei due ha già inviato all'altro: per entrambi i firewall il resto è traffico
//     di ritorno, come per il video WebRTC (ed è per questo che il verso B→A funzionava già).
// Sopra c'è un canale ordinato e affidabile (numerazione, conferme, ritrasmissione) per i pochi
// messaggi di segnalazione. Il trasporto si comporta come quello TCP diretto (kind 'direct').
import { EventEmitter } from 'node:events';
import { Transport } from './transports.js';
import { isValidId } from '../../shared/ids.js';
import { PROTOCOL_VERSION, isValidSid, sanitizeName } from '../../shared/protocol.js';
import { SlidingWindowCounter } from '../../shared/ratelimit.js';

/** Dimensione massima di un datagramma: i messaggi di segnalazione stanno in pochi KB. */
export const UDP_MAX_BYTES = 60_000;

export const UDP_TIMING = Object.freeze({
  helloMs: 200, // ripetizione di "hi" finché B non risponde
  rtoMs: 250, // ritrasmissione dei messaggi non confermati
  giveUpMs: 10_000, // un messaggio mai confermato: il collegamento è perso
  keepaliveMs: 2_000, // tiene aperto il passaggio nei firewall quando non c'è traffico
  idleMs: 15_000, // nulla ricevuto per tanto così: collegamento perso
  lingerMs: 2_000, // alla chiusura si attende la conferma degli ultimi messaggi (es. "reject")
  tickMs: 100,
});

const APP = 'remoto';

export class UdpTransport extends Transport {
  constructor(hub, { sid, peerId, address, port }) {
    super({ kind: 'direct', sid, peerId, verified: false, address });
    this.via = 'udp';
    this.hub = hub;
    this.port = port;
    this.txSeq = 0;
    this.unacked = new Map(); // n → { pkt, firstAt, lastAt }
    this.rxNext = 1;
    this.rxBuf = new Map();
    this.lastRx = hub.now();
    this.lastTx = hub.now();
    this.lingerUntil = 0;
    this.byeSent = false;
  }

  #raw(obj) {
    const ok = this.hub.raw(obj, this.port, this.address);
    if (ok) this.lastTx = this.hub.now();
    return ok;
  }

  send(data) {
    if (this.closed) return false;
    const n = this.txSeq + 1;
    const pkt = { app: APP, u: 'd', sid: this.sid, n, data };
    if (!this.#raw(pkt)) return false;
    this.txSeq = n;
    const t = this.hub.now();
    this.unacked.set(n, { pkt, firstAt: t, lastAt: t });
    return true;
  }

  /** Pacchetto arrivato dall'altra parte (già filtrato per indirizzo, porta e sid). */
  onPacket(m) {
    this.lastRx = this.hub.now();
    switch (m.u) {
      case 'd': {
        const n = m.n;
        if (!Number.isInteger(n) || n < 1) return;
        if (!this.closed && n >= this.rxNext && n < this.rxNext + 256 && !this.rxBuf.has(n)) this.rxBuf.set(n, m.data);
        if (this.closed && n >= this.rxNext) this.rxNext = n + 1; // chiuso: si conferma soltanto
        const ready = [];
        while (this.rxBuf.has(this.rxNext)) {
          ready.push(this.rxBuf.get(this.rxNext));
          this.rxBuf.delete(this.rxNext);
          this.rxNext++;
        }
        this.#raw({ app: APP, u: 'a', sid: this.sid, n: this.rxNext - 1 });
        for (const d of ready) if (d && typeof d === 'object' && !Array.isArray(d)) this.deliver(d);
        break;
      }
      case 'a':
        if (!Number.isInteger(m.n)) return;
        for (const n of [...this.unacked.keys()]) if (n <= m.n) this.unacked.delete(n);
        if (this.closed && !this.unacked.size) this.#sendBye();
        break;
      case 'x':
        // l'altra app ha chiuso: come il codice 1000 di una WebSocket
        this.byeSent = true;
        this.#finish(`udp-closed:${typeof m.why === 'string' ? m.why.slice(0, 40) : ''}`);
        break;
      default:
        break; // 'k': serve solo a tenere aperto il passaggio
    }
  }

  tick(now, timing) {
    if (this.closed) {
      if (this.byeSent) return;
      if (!this.unacked.size || now >= this.lingerUntil) this.#sendBye();
      else this.#retransmit(now, timing);
      return;
    }
    for (const e of this.unacked.values()) {
      if (now - e.firstAt > timing.giveUpMs) return this.#finish('udp-timeout');
    }
    if (now - this.lastRx > timing.idleMs) return this.#finish('udp-timeout');
    this.#retransmit(now, timing);
    if (now - this.lastTx >= timing.keepaliveMs) this.#raw({ app: APP, u: 'k', sid: this.sid });
  }

  #retransmit(now, timing) {
    for (const e of this.unacked.values()) {
      if (now - e.lastAt < timing.rtoMs) continue;
      e.lastAt = now;
      this.#raw(e.pkt);
    }
  }

  #sendBye() {
    if (this.byeSent) return;
    this.byeSent = true;
    const bye = { app: APP, u: 'x', sid: this.sid, why: String(this.closeReason || '').slice(0, 40) };
    this.#raw(bye);
    this.#raw(bye);
    this.hub.forget(this);
  }

  /** Avvisa subito l'altra parte senza attendere le conferme (uscita dall'app). */
  byeNow() {
    this.#sendBye();
  }

  /** Chiusura da questa parte: la sessione lo sa subito, i messaggi in volo arrivano comunque. */
  close(reason = 'closed') {
    if (this.closed) return;
    this.closeReason = reason;
    this.lingerUntil = this.hub.now() + this.hub.timing.lingerMs;
    super.close(reason);
    if (!this.unacked.size) this.#sendBye();
  }

  /** Chiusura decisa dall'altra parte o dal timeout: niente da attendere. */
  #finish(reason) {
    this.byeSent = true;
    this.unacked.clear();
    this.rxBuf.clear();
    this.hub.forget(this);
    if (!this.closed) super.close(reason);
  }
}

export class UdpHub extends EventEmitter {
  /**
   * @param {object} o
   * @param {(buf: Buffer, port: number, address: string) => void} o.send  invio sul socket del rilevamento LAN
   * @param {() => {id: string, name: string}} o.getIdentity
   */
  constructor({ send, getIdentity, logger = console, now = Date.now, timing = {}, perIpPerMinute = 30, maxTransports = 32 }) {
    super();
    this.sendFn = send;
    this.getIdentity = getIdentity;
    this.log = logger;
    this.now = now;
    this.timing = { ...UDP_TIMING, ...timing };
    this.maxTransports = maxTransports;
    this.limiter = new SlidingWindowCounter({ windowMs: 60_000, limit: perIpPerMinute, now });
    this.transports = new Map(); // "indirizzo|porta|sid" → UdpTransport
    this.connects = new Map(); // sid → tentativo di connessione in corso
    this.timer = null;
  }

  /** Invia un oggetto come datagramma JSON; false se troppo grande o se il socket non c'è. */
  raw(obj, port, address) {
    const buf = Buffer.from(JSON.stringify(obj));
    if (buf.length > UDP_MAX_BYTES) return false;
    try {
      this.sendFn(buf, port, address);
      return true;
    } catch {
      return false;
    }
  }

  forget(t) {
    const key = `${t.address}|${t.port}|${t.sid}`;
    if (this.transports.get(key) === t) this.transports.delete(key);
    this.#maybeStopTimer();
  }

  /** Datagramma ricevuto sulla porta del rilevamento. true se apparteneva alla segnalazione UDP. */
  handle(m, rinfo) {
    if (!m || m.app !== APP || typeof m.u !== 'string') return false;
    if (!isValidSid(m.sid)) return true;
    const key = `${rinfo.address}|${rinfo.port}|${m.sid}`;
    const t = this.transports.get(key);
    if (m.u === 'hi') this.#onHello(m, rinfo, key, t);
    else if (m.u === 'ok' || m.u === 'no') this.#onWelcome(m, rinfo, t);
    else if (t) t.onPacket(m);
    else if (m.u === 'd') this.raw({ app: APP, u: 'x', sid: m.sid, why: 'unknown' }, rinfo.port, rinfo.address);
    return true;
  }

  #welcome(sid) {
    const me = this.getIdentity();
    return { app: APP, u: 'ok', v: PROTOCOL_VERSION, sid, id: me.id, name: me.name };
  }

  // ---- lato controllato: arriva "hi" ----

  #onHello(m, rinfo, key, existing) {
    if (existing) {
      // il nostro "ok" si è perso e A ripete il saluto: si risponde di nuovo, stesso trasporto
      if (!existing.closed) this.raw(this.#welcome(m.sid), rinfo.port, rinfo.address);
      return;
    }
    if (m.v !== PROTOCOL_VERSION) {
      this.raw({ app: APP, u: 'no', sid: m.sid, code: 'version' }, rinfo.port, rinfo.address);
      return;
    }
    if (this.transports.size >= this.maxTransports || !this.limiter.hit(rinfo.address)) return;
    const peerId = isValidId(m.id) ? m.id : null;
    const t = new UdpTransport(this, { sid: m.sid, peerId, address: rinfo.address, port: rinfo.port });
    this.transports.set(key, t);
    this.#ensureTimer();
    this.raw(this.#welcome(m.sid), rinfo.port, rinfo.address);
    this.emit('incoming', t, { peerId, peerName: sanitizeName(m.name), address: rinfo.address });
  }

  // ---- lato che si collega ----

  /**
   * Saluta la postazione su tutti i suoi indirizzi finché uno risponde.
   * @returns {Promise<{transport: UdpTransport, peer: {id: string|null, name: string}}>}
   */
  connect({ targets, identity, sid, expectId = null, timeoutMs = 6000, signal = null }) {
    return new Promise((resolve, reject) => {
      const list = (targets || []).filter((t) => t && t.host && Number.isInteger(t.port) && t.port > 0);
      const fail = (code, msg) => reject(Object.assign(new Error(msg), { code }));
      if (!list.length) return fail('unreachable', 'nessun indirizzo');
      if (!isValidSid(sid) || this.connects.has(sid)) return fail('unreachable', 'sessione non valida');
      if (signal?.aborted) return fail('aborted', 'annullato');
      const hello = { app: APP, u: 'hi', v: PROTOCOL_VERSION, sid, id: identity.id, name: identity.name };
      const c = {
        expectId,
        finish: (err, res) => {
          if (!this.connects.has(sid)) return;
          this.connects.delete(sid);
          clearInterval(c.again);
          clearTimeout(c.timer);
          signal?.removeEventListener('abort', onAbort);
          if (err) reject(err);
          else resolve(res);
        },
      };
      const say = () => {
        let sent = 0;
        for (const t of list) if (this.raw(hello, t.port, t.host)) sent++;
        if (!sent) c.finish(Object.assign(new Error('rilevamento LAN non attivo'), { code: 'unreachable' }));
      };
      const onAbort = () => c.finish(Object.assign(new Error('annullato'), { code: 'aborted' }));
      signal?.addEventListener('abort', onAbort, { once: true });
      c.again = setInterval(say, this.timing.helloMs);
      c.timer = setTimeout(() => c.finish(Object.assign(new Error('Nessuna risposta (UDP)'), { code: 'unreachable' })), timeoutMs);
      this.connects.set(sid, c);
      say();
    });
  }

  #onWelcome(m, rinfo, existing) {
    if (existing) return; // "ok" ripetuto: il trasporto c'è già
    const c = this.connects.get(m.sid);
    const peerId = isValidId(m.id) ? m.id : null;
    if (!c || (c.expectId && peerId !== c.expectId)) {
      // risposta tardiva o di un'altra postazione: le si dice di lasciar perdere
      if (m.u === 'ok') this.raw({ app: APP, u: 'x', sid: m.sid, why: c ? 'wrong-peer' : 'superseded' }, rinfo.port, rinfo.address);
      return;
    }
    if (m.u === 'no') {
      c.finish(Object.assign(new Error('Versione diversa'), { code: m.code === 'version' ? 'version' : 'unreachable' }));
      return;
    }
    const t = new UdpTransport(this, { sid: m.sid, peerId, address: rinfo.address, port: rinfo.port });
    this.transports.set(`${rinfo.address}|${rinfo.port}|${m.sid}`, t);
    this.#ensureTimer();
    c.finish(null, { transport: t, peer: { id: peerId, name: sanitizeName(m.name) } });
  }

  // ---- temporizzatore unico per ritrasmissioni e keepalive ----

  #ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = this.now();
      for (const t of [...this.transports.values()]) t.tick(now, this.timing);
    }, this.timing.tickMs);
    this.timer.unref?.();
  }

  #maybeStopTimer() {
    if (this.timer && !this.transports.size) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Chiude tutto (uscita dall'app o rilevamento LAN spento): l'altra parte viene avvisata subito. */
  closeAll(reason = 'closed') {
    for (const c of [...this.connects.values()]) c.finish(Object.assign(new Error('chiuso'), { code: 'unreachable' }));
    for (const t of [...this.transports.values()]) {
      t.close(reason);
      t.byeNow();
    }
  }
}
