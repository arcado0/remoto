// Opzioni di Chromium impostate da Remoto. Si uniscono a quelle eventualmente già passate da riga
// di comando (appendSwitch sostituirebbe il valore: un "--disable-features" dell'utente andrebbe perso).

/**
 * Field trial di WebRTC per la latenza minima (come lo streaming di giochi): il ricevitore mostra ogni
 * fotogramma appena decodificato, senza il buffer anti-jitter che in LAN tratteneva il video 35-60 ms.
 * Il primo vale per il video ricevuto; il secondo lo chiede, dentro i pacchetti RTP, a chi riceve il
 * nostro video: così funziona anche se dall'altra parte c'è una versione di Remoto senza il primo.
 */
export const LOW_LATENCY_TRIALS = Object.freeze({
  'WebRTC-ForcePlayoutDelay': 'min_ms:0,max_ms:0',
  'WebRTC-ForceSendPlayoutDelay': 'min_ms:0,max_ms:0',
});

/** Unisce elenchi separati da virgola (es. "--disable-features") senza duplicati, mantenendo l'ordine. */
export function mergeList(current, values) {
  const out = [];
  for (const v of [...String(current || '').split(','), ...values]) {
    const t = v.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out.join(',');
}

/** "Trial/Gruppo/Trial2/Gruppo2/" in coppie [trial, gruppo]. */
export function parseFieldTrials(value) {
  const parts = String(value || '').split('/');
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) out.push([parts[i], parts[i + 1]]);
  return out;
}

/** Aggiunge i field trial mancanti; quelli già presenti (passati a mano) vincono. */
export function mergeFieldTrials(current, trials) {
  const list = parseFieldTrials(current);
  for (const [name, group] of Object.entries(trials)) if (!list.some(([n]) => n === name)) list.push([name, group]);
  return list.map(([n, g]) => `${n}/${g}/`).join('');
}

/** Applica le opzioni a app.commandLine (o a un oggetto con la stessa interfaccia, per i test). */
export function applyChromiumFlags(commandLine, { disableFeatures = [], fieldTrials = {} } = {}) {
  if (disableFeatures.length) commandLine.appendSwitch('disable-features', mergeList(commandLine.getSwitchValue('disable-features'), disableFeatures));
  if (Object.keys(fieldTrials).length) commandLine.appendSwitch('force-fieldtrials', mergeFieldTrials(commandLine.getSwitchValue('force-fieldtrials'), fieldTrials));
}
