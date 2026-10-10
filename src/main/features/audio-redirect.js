// Audio "come Desktop remoto di Windows": durante una sessione le casse di questo PC tacciono (l'audio di
// sistema arriva solo a chi controlla) e le app usano come microfono quello di chi controlla. Per il
// microfono serve un cavo audio virtuale (es. VB-CABLE): Windows non permette a un programma di creare un
// microfono senza un driver. Remoto suona la voce remota su "CABLE Input", rende "CABLE Output" il
// microfono predefinito e silenzia gli altri microfoni.
// A fine sessione tutto torna com'era. Lo stato originale è salvato su disco: se Remoto si chiude di
// colpo durante una sessione, al riavvio casse e microfoni vengono ripristinati.
import fs from 'node:fs';

/** Cavi audio virtuali (le loro "casse" servono a portare la voce remota: non vanno silenziate). */
// "Steam Streaming Microphone" lo installa Steam (Remote Play) ed è anch'esso un cavo: casse + microfono.
export const VIRTUAL_DEVICE = /(CABLE|VB-Audio|Virtual Audio Cable|Voicemeeter|Hi-Fi Cable|Virtual Cable|Steam Streaming)/i;

/** Lato microfono del cavo virtuale su cui suona la voce remota ("CABLE Input (…)" → "CABLE Output (…)"). */
export function pairedCapture(renderName, captures) {
  const name = String(renderName || '');
  const m = /^(.*?)\bInput\b(.*)$/i.exec(name);
  if (m) {
    const want = `${m[1]}Output${m[2]}`.toLowerCase();
    const exact = captures.find((c) => c.name.toLowerCase() === want);
    if (exact) return exact;
  }
  const tail = /\(([^)]+)\)\s*$/.exec(name)?.[1];
  if (tail) {
    const same = captures.find((c) => c.name.includes(`(${tail})`) && VIRTUAL_DEVICE.test(c.name));
    if (same) return same;
  }
  return null;
}

export class AudioRedirect {
  /**
   * @param {object} o
   * @param {object} o.devices  listDevices(flow), setMuted(id, on), setDefault(id, roles), audioDevicesAvailable()
   * @param {string} o.file     dove salvare lo stato da ripristinare
   * @param {() => boolean} [o.enabled]  impostazione "audio solo da chi controlla"
   */
  constructor({ devices, file, enabled = () => true, logger = console }) {
    this.devices = devices;
    this.file = file;
    this.enabled = enabled;
    this.log = logger;
    this.speakerUsers = new Set(); // sessioni che ricevono l'audio di sistema
    this.micUsers = new Map(); // sessione → casse virtuali su cui suona il suo microfono
    this.saved = { speakers: null, mic: null };
  }

  get available() {
    try {
      return Boolean(this.devices.audioDevicesAvailable());
    } catch {
      return false;
    }
  }

  /** All'avvio: rimette casse e microfoni come prima di una sessione interrotta di colpo. */
  recover() {
    let st;
    try {
      st = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return false;
    }
    this.saved = { speakers: st?.speakers || null, mic: st?.mic || null };
    this.log.info?.('audio: ripristino di casse e microfoni dopo una sessione interrotta');
    this.#restoreSpeakers();
    this.#restoreMic();
    return true;
  }

  /** La sessione riceve (on) o non riceve più l'audio di sistema di questo PC. */
  setSpeakers(sessionId, on) {
    if (on) this.speakerUsers.add(sessionId);
    else this.speakerUsers.delete(sessionId);
    this.#apply();
  }

  /** Il microfono della sessione suona su queste casse virtuali (null = non più). */
  setMic(sessionId, sinkName) {
    if (sinkName) this.micUsers.set(sessionId, String(sinkName));
    else this.micUsers.delete(sessionId);
    this.#apply();
  }

  release(sessionId) {
    this.speakerUsers.delete(sessionId);
    this.micUsers.delete(sessionId);
    this.#apply();
  }

  /** Impostazione cambiata: si applica subito alle sessioni in corso. */
  refresh() {
    this.#apply();
  }

  restoreAll() {
    this.speakerUsers.clear();
    this.micUsers.clear();
    this.#restoreSpeakers();
    this.#restoreMic();
  }

  /** Stato per l'interfaccia. */
  state() {
    return { speakersMuted: Boolean(this.saved.speakers), micRedirected: Boolean(this.saved.mic), micDevice: this.saved.mic?.targetName || '' };
  }

  #apply() {
    const on = this.enabled() && this.available;
    const wantSpeakers = on && this.speakerUsers.size > 0;
    const sink = on ? [...this.micUsers.values()].pop() || null : null;
    if (wantSpeakers && !this.saved.speakers) this.#muteSpeakers();
    else if (!wantSpeakers && this.saved.speakers) this.#restoreSpeakers();
    // la voce remota ora suona altrove (o non più): prima si rimette tutto com'era
    if (this.saved.mic && this.saved.mic.sinkName !== sink) this.#restoreMic();
    if (sink && !this.saved.mic) this.#useRemoteMic(sink);
  }

  #try(fn, what) {
    try {
      fn();
      return true;
    } catch (err) {
      this.log.warn?.(`audio: ${what}: ${err.message}`);
      return false;
    }
  }

  #persist() {
    try {
      if (this.saved.speakers || this.saved.mic) fs.writeFileSync(this.file, JSON.stringify(this.saved));
      else fs.rmSync(this.file, { force: true });
    } catch (err) {
      this.log.warn?.(`audio: stato da ripristinare non salvato: ${err.message}`);
    }
  }

  // ---- casse ----

  #muteSpeakers() {
    let list = [];
    this.#try(() => {
      // le casse predefinite (anche quelle "per le comunicazioni", usate da Teams & co.), mai un cavo virtuale
      list = this.devices.listDevices('render').filter((d) => (d.isDefault || d.isDefaultComm) && !VIRTUAL_DEVICE.test(d.name));
    }, 'elenco delle casse');
    if (!list.length) return;
    this.saved.speakers = list.map((d) => ({ id: d.id, name: d.name, muted: d.muted }));
    this.#persist();
    for (const d of list) if (!d.muted) this.#try(() => this.devices.setMuted(d.id, true), `silenzio di ${d.name}`);
    this.log.info?.(`audio: casse silenziate durante la sessione (${list.map((d) => d.name).join(', ')})`);
  }

  #restoreSpeakers() {
    const saved = this.saved.speakers;
    if (!saved) return;
    for (const d of saved) if (!d.muted) this.#try(() => this.devices.setMuted(d.id, false), `ripristino di ${d.name}`);
    this.saved.speakers = null;
    this.#persist();
    this.log.info?.('audio: casse ripristinate');
  }

  // ---- microfono ----

  #useRemoteMic(sinkName) {
    let captures = [];
    if (!this.#try(() => (captures = this.devices.listDevices('capture')), 'elenco dei microfoni')) return;
    const target = pairedCapture(sinkName, captures);
    if (!target) {
      this.log.warn?.(`audio: nessun microfono virtuale abbinato a "${sinkName}"`);
      return;
    }
    const others = captures.filter((c) => c.id !== target.id && !VIRTUAL_DEVICE.test(c.name));
    this.saved.mic = {
      sinkName,
      defaultId: captures.find((c) => c.isDefault)?.id || null,
      commId: captures.find((c) => c.isDefaultComm)?.id || null,
      target: target.id,
      targetName: target.name,
      targetMuted: target.muted,
      others: others.map((c) => ({ id: c.id, name: c.name, muted: c.muted })),
    };
    this.#persist();
    this.#try(() => this.devices.setDefault(target.id), `microfono predefinito ${target.name}`);
    if (target.muted) this.#try(() => this.devices.setMuted(target.id, false), `riattivazione di ${target.name}`);
    for (const c of others) if (!c.muted) this.#try(() => this.devices.setMuted(c.id, true), `silenzio di ${c.name}`);
    this.log.info?.(`audio: microfono di questo PC = ${target.name} (voce di chi controlla); silenziati ${others.map((c) => c.name).join(', ') || 'nessun altro'}`);
  }

  #restoreMic() {
    const s = this.saved.mic;
    if (!s) return;
    for (const c of s.others || []) if (!c.muted) this.#try(() => this.devices.setMuted(c.id, false), `ripristino di ${c.name}`);
    if (s.targetMuted) this.#try(() => this.devices.setMuted(s.target, true), 'ripristino del cavo virtuale');
    if (s.defaultId) this.#try(() => this.devices.setDefault(s.defaultId, ['console', 'multimedia']), 'microfono predefinito');
    if (s.commId) this.#try(() => this.devices.setDefault(s.commId, ['communications']), 'microfono per le comunicazioni');
    this.saved.mic = null;
    this.#persist();
    this.log.info?.('audio: microfoni ripristinati');
  }
}
