// Classificazione del collegamento WebRTC scelto: LAN diretta, P2P via Internet o relay TURN.

export function isPrivateAddress(ip) {
  const a = String(ip || '').toLowerCase();
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a) || a === '::1' || a.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/.test(a);
}

/**
 * @param {{candidateType?:string, address?:string, ip?:string}|undefined} local
 * @param {{candidateType?:string, address?:string, ip?:string}|undefined} remote
 * @returns {'lan'|'p2p'|'relay'|''}
 */
export function classifyPair(local, remote) {
  if (!local || !remote) return '';
  if (local.candidateType === 'relay' || remote.candidateType === 'relay') return 'relay';
  const la = local.address || local.ip;
  const ra = remote.address || remote.ip;
  if (local.candidateType === 'host' && remote.candidateType === 'host') return 'lan';
  // un candidato remoto "prflx" ha spesso l'indirizzo oscurato da Chromium: se ci ha raggiunto
  // su un nostro indirizzo privato, il peer è per forza nella stessa rete locale (o VPN)
  if (local.candidateType === 'host' && remote.candidateType === 'prflx' && isPrivateAddress(la)) return 'lan';
  if (isPrivateAddress(la) && isPrivateAddress(ra)) return 'lan';
  return 'p2p';
}

/** Coppia di candidati selezionata da un report di getStats(). */
export function selectedPair(stats) {
  let pair = null;
  stats.forEach((r) => {
    if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
  });
  if (!pair) {
    stats.forEach((r) => {
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
    });
  }
  if (!pair) return null;
  return { pair, local: stats.get(pair.localCandidateId), remote: stats.get(pair.remoteCandidateId) };
}

const ipv4 = (s) => {
  const p = String(s || '').split('.');
  if (p.length !== 4) return null;
  const n = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  return n.every((x) => x >= 0 && x <= 255) ? ((n[0] << 24) | (n[1] << 16) | (n[2] << 8) | n[3]) >>> 0 : null;
};

/**
 * Indirizzi IPv4 privati di chi si collega che stanno in una sottorete di questo PC: vuol dire
 * stessa rete locale anche se la richiesta è passata dal server (si usa la banda da LAN da subito).
 * @param {string[]} addrs  indirizzi dichiarati dall'altro PC
 * @param {Record<string, {address: string, netmask: string, family: string|number, internal: boolean}[]>} interfaces
 */
export function sharesSubnet(addrs, interfaces) {
  const nets = [];
  for (const list of Object.values(interfaces || {})) {
    for (const a of list || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal || !a.netmask) continue;
      const ip = ipv4(a.address);
      const mask = ipv4(a.netmask);
      if (ip !== null && mask !== null && mask !== 0) nets.push([(ip & mask) >>> 0, mask]);
    }
  }
  return (addrs || []).some((x) => {
    if (!isPrivateAddress(x)) return false;
    const ip = ipv4(x);
    return ip !== null && nets.some(([net, mask]) => ((ip & mask) >>> 0) === net);
  });
}
