// Indirizzi IPv4 di questa postazione, dal più utile al meno utile: prima quello della rete "vera"
// (la scheda che il sistema usa per uscire), poi le altre schede fisiche, in fondo quelle virtuali
// (Hyper-V/WSL, VirtualBox, VMware, VPN...), che dall'altro PC di solito non si raggiungono.
// Prima si mostravano nell'ordine di Windows, e con due IP capitava di comunicare quello sbagliato.
import os from 'node:os';
import dgram from 'node:dgram';

const VIRTUAL = /(vEthernet|Hyper-V|WSL|VirtualBox|VMware|VMnet|Docker|Hamachi|ZeroTier|Tailscale|Radmin|Wintun|WireGuard|OpenVPN|NordLynx|Proton|Npcap|Bluetooth|TAP-|Virtual|Pseudo)/i;

/**
 * @param {ReturnType<typeof os.networkInterfaces>} interfaces
 * @param {string|null} primary  indirizzo della scheda usata per uscire (vedi primaryAddress)
 * @returns {{address: string, name: string, virtual: boolean, primary: boolean}[]}
 */
export function rankAddresses(interfaces = os.networkInterfaces(), primary = null) {
  const out = [];
  for (const [name, list] of Object.entries(interfaces || {})) {
    for (const a of list || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue; // scheda senza rete (APIPA)
      out.push({ address: a.address, name, virtual: VIRTUAL.test(name), primary: a.address === primary });
    }
  }
  const rank = (x) => (x.primary ? 0 : x.virtual ? 2 : 1);
  return out.map((x, i) => ({ x, i })).sort((p, q) => rank(p.x) - rank(q.x) || p.i - q.i).map((p) => p.x);
}

/**
 * Indirizzo locale che il sistema userebbe per uscire verso Internet. Un "connect" UDP non invia
 * nulla: chiede solo al sistema quale scheda userebbe. Null se non c'è un percorso predefinito.
 */
export function primaryAddress({ probe = '8.8.8.8', timeoutMs = 1000 } = {}) {
  return new Promise((resolve) => {
    let s;
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        s?.close();
      } catch {
        /* già chiuso */
      }
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    try {
      s = dgram.createSocket('udp4');
      s.once('error', () => done(null));
      s.connect(53, probe, () => {
        try {
          done(s.address().address || null);
        } catch {
          done(null);
        }
      });
    } catch {
      done(null);
    }
  });
}
