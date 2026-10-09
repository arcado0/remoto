// Rilevamento delle postazioni Remoto nella rete locale tramite broadcast UDP.
import { EventEmitter } from 'node:events';
import dgram from 'node:dgram';
import os from 'node:os';
import crypto from 'node:crypto';
import { isValidId } from '../../shared/ids.js';
import { safeParse, sanitizeName, PROTOCOL_VERSION } from '../../shared/protocol.js';

/** Indirizzi di broadcast di ogni interfaccia IPv4 (più 255.255.255.255). */
export function broadcastAddresses(interfaces = os.networkInterfaces()) {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(interfaces)) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...out];
}

/** MAC delle interfacce fisiche (per il Wake-on-LAN). */
export function localMacs(interfaces = os.networkInterfaces()) {
  const out = new Set();
  for (const list of Object.values(interfaces)) {
    for (const a of list || []) {
      if (!a.internal && a.mac && a.mac !== '00:00:00:00:00:00') out.add(a.mac.toLowerCase());
    }
  }
  return [...out];
}

export class Discovery extends EventEmitter {
  // annunci ogni 2,5 s: Windows lascia entrare per 3 s le risposte unicast a un broadcast, così la porta
  // resta sempre raggiungibile dalla segnalazione UDP (lan-udp.js) anche con il firewall che blocca Remoto
  constructor({ port, getAnnouncement, intervalMs = 2500, ttlMs = 12_000, bindAddress = '0.0.0.0', targets = null, logger = console }) {
    super();
    this.port = port;
    this.getAnnouncement = getAnnouncement;
    this.intervalMs = intervalMs;
    this.ttlMs = ttlMs;
    this.bindAddress = bindAddress;
    this.targets = targets; // per i test: destinazioni fisse al posto del broadcast
    this.log = logger;
    this.instance = crypto.randomBytes(6).toString('hex');
    this.socket = null;
    this.timer = null;
    this.sweepTimer = null;
    this.map = new Map();
    this.error = null;
    /** Riceve i datagrammi della segnalazione UDP ({ u: ... }) che arrivano su questa stessa porta. */
    this.onDatagram = null;
  }

  get running() {
    return Boolean(this.socket);
  }

  async start() {
    if (this.socket) return;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(this.port, this.bindAddress, () => {
        socket.off('error', reject);
        resolve();
      });
    }).catch((err) => {
      this.error = err.message;
      socket.close();
      throw err;
    });
    try {
      socket.setBroadcast(true);
    } catch {
      /* alcune interfacce non lo consentono */
    }
    this.socket = socket;
    this.error = null;
    socket.on('message', (buf, rinfo) => this.#onMessage(buf, rinfo));
    socket.on('error', (err) => this.log.warn?.(`rilevamento LAN: ${err.message}`));
    this.announce();
    this.timer = setInterval(() => this.announce(), this.intervalMs);
    this.sweepTimer = setInterval(() => this.#sweep(), 1000);
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.sweepTimer);
    this.timer = this.sweepTimer = null;
    if (this.socket) {
      const s = this.socket;
      this.socket = null;
      try {
        s.close();
      } catch {
        /* già chiuso */
      }
    }
    if (this.map.size) {
      this.map.clear();
      this.emit('change', []);
    }
  }

  /** Invia un datagramma dal socket del rilevamento (la porta che gli altri PC conoscono). */
  sendRaw(buf, port, address) {
    if (!this.socket) throw new Error('rilevamento LAN non attivo');
    this.socket.send(buf, port, address, () => {});
  }

  announce() {
    if (!this.socket) return;
    const a = this.getAnnouncement();
    if (!a || !isValidId(a.id)) return;
    const msg = Buffer.from(JSON.stringify({ app: 'remoto', v: PROTOCOL_VERSION, inst: this.instance, id: a.id, name: a.name, port: a.port, macs: a.macs || [], os: a.os || '' }));
    for (const t of this.targets || broadcastAddresses()) {
      // "indirizzo" oppure "indirizzo:porta" (i test usano porte diverse per ogni istanza)
      const [addr, p] = String(t).split(':');
      this.socket.send(msg, Number(p) || this.port, addr, () => {});
    }
  }

  #onMessage(buf, rinfo) {
    const m = safeParse(buf.toString());
    if (!m || m.app !== 'remoto') return;
    if (typeof m.u === 'string') {
      this.onDatagram?.(m, rinfo);
      return;
    }
    if (buf.length > 4096 || m.inst === this.instance || !isValidId(m.id)) return;
    const port = Number(m.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    const key = m.id;
    const prev = this.map.get(key);
    // una postazione con più schede di rete (VPN, Hyper-V...) si annuncia da più indirizzi
    const addresses = [rinfo.address, ...(prev?.addresses || []).filter((a) => a !== rinfo.address)].slice(0, 4);
    const entry = {
      id: m.id,
      name: sanitizeName(m.name),
      address: prev?.address && prev.addresses.includes(prev.address) ? prev.address : rinfo.address,
      addresses,
      port,
      // porta UDP del rilevamento di quella postazione: è lì che si manda la segnalazione UDP
      uport: rinfo.port,
      macs: Array.isArray(m.macs) ? m.macs.filter((x) => typeof x === 'string' && /^[0-9a-f:]{17}$/i.test(x)).slice(0, 4) : [],
      os: typeof m.os === 'string' ? m.os.slice(0, 32) : '',
      lastSeen: Date.now(),
    };
    this.map.set(key, entry);
    if (!prev || prev.name !== entry.name || prev.addresses.length !== entry.addresses.length || prev.port !== entry.port) this.emit('change', this.peers());
  }

  #sweep() {
    const cutoff = Date.now() - this.ttlMs;
    let changed = false;
    for (const [k, v] of this.map) {
      if (v.lastSeen < cutoff) {
        this.map.delete(k);
        changed = true;
      }
    }
    if (changed) this.emit('change', this.peers());
  }

  peers() {
    return [...this.map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  find(id) {
    return this.map.get(id) || null;
  }
}
