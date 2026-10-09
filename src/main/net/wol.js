// Wake-on-LAN: "magic packet" = 6 byte 0xFF + 16 ripetizioni del MAC, in broadcast UDP.
import dgram from 'node:dgram';
import { broadcastAddresses } from './discovery.js';

export function parseMac(mac) {
  const hex = String(mac ?? '').replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) return null;
  return Buffer.from(hex, 'hex');
}

export function magicPacket(mac) {
  const m = parseMac(mac);
  if (!m) throw new Error('Indirizzo MAC non valido');
  const buf = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) m.copy(buf, 6 + i * 6);
  return buf;
}

export async function wake(mac, { addresses = broadcastAddresses(), ports = [9, 7] } = {}) {
  const packet = magicPacket(mac);
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => socket.bind(0, (err) => (err ? reject(err) : resolve())));
  socket.setBroadcast(true);
  const sends = [];
  for (const addr of addresses) {
    for (const port of ports) {
      sends.push(new Promise((resolve) => socket.send(packet, port, addr, () => resolve())));
    }
  }
  await Promise.all(sends);
  socket.close();
  return addresses.length;
}
