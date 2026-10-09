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
