// Canale di segnalazione di una singola sessione. Host e viewer non sanno se i messaggi
// passano dal server ID (RelayTransport) o da un WebSocket diretto in LAN (DirectTransport).
import { EventEmitter } from 'node:events';
import { safeParse, LIMITS } from '../../shared/protocol.js';

export class Transport extends EventEmitter {
  constructor({ kind, sid, peerId, verified, address = null }) {
    super();
    this.kind = kind;
    this.sid = sid;
    this.peerId = peerId;
    /** true se l'ID del peer è garantito dal server; in LAN è solo dichiarato. */
    this.verified = verified;
    this.address = address;
    this.closed = false;
  }

  /** Consegna un messaggio ricevuto (usato dal router per i messaggi inoltrati dal server). */
  deliver(data) {
    if (!this.closed) this.emit('message', data);
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', reason);
  }
}

export class RelayTransport extends Transport {
  constructor(link, peerId, sid) {
    super({ kind: 'relay', sid, peerId, verified: true });
    this.link = link;
  }

  send(data) {
    if (this.closed) return false;
    return this.link.relay(this.peerId, this.sid, data);
  }
}

export class DirectTransport extends Transport {
  constructor(ws, { sid, peerId, address }) {
    super({ kind: 'direct', sid, peerId, verified: false, address });
    this.ws = ws;
    ws.on('message', (raw, isBinary) => {
      if (isBinary || raw.length > LIMITS.maxDirectMessage) return;
      const msg = safeParse(raw.toString());
      if (msg && msg.t === 'p' && msg.data && typeof msg.data === 'object') this.deliver(msg.data);
    });
    // il codice dice chi ha chiuso: 1000 = l'altra app, 1006 = connessione troncata (rete, firewall, antivirus)
    ws.on('close', (code) => this.close(`socket-closed:${code}`));
    ws.on('error', (err) => this.close(`socket-error:${err?.code || err?.message || 'sconosciuto'}`));
  }

  send(data) {
    if (this.closed || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify({ t: 'p', data }));
    return true;
  }

  close(reason) {
    if (this.closed) return;
    super.close(reason);
    try {
      this.ws.close(1000, 'bye');
    } catch {
      /* già chiuso */
    }
  }
}
