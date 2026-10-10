// Appunti con file tra i due PC: chi copia file in Esplora risorse li annuncia (quanti e quanto pesano),
// l'altro lato li scarica col trasferimento file in una cartella temporanea e li mette nei suoi appunti
// di Windows: con Ctrl+V si incollano come se fossero stati copiati lì. Stesso codice su host e viewer.
//   clipf {token, count, total, names, more}  annuncio di chi ha copiato
//   clipf-get {token, x}                        richiesta di chi riceve (dopo expectDownload(x))
//   … trasferimento "download" con quell'x (un rifiuto arriva come fcancel {x, reason}) …
//   clipf-ready {token, count}                  i file sono negli appunti dell'altro PC
//   clipf-skip {token, reason, total}           non trasferiti (troppo grandi)
import { newXid, cleanError } from './transfers.js';

/** Oltre questa dimensione i file copiati non partono da soli: si usa il pannello File. */
export const CLIP_FILES_MAX_BYTES = 1024 * 1024 * 1024;

const baseName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);

export class ClipFiles {
  /**
   * @param {object} o
   * @param {RTCDataChannel} o.channel      canale "file"
   * @param {object} o.transfers           TransferEngine dello stesso canale
   * @param {object} o.backend             expand(paths) → {files, total}
   * @param {() => Promise<string>} o.prepare        cartella temporanea nuova (creata dal main)
   * @param {(dir: string) => Promise<{count: number, names: string[]}>} o.apply  file ricevuti → appunti
   * @param {() => boolean} o.allowed      appunti e file consentiti in questa sessione
   * @param {(event: string, detail: object) => void} [o.notify]
   */
  constructor({ channel, transfers, backend, prepare, apply, allowed, notify = () => {}, maxBytes = CLIP_FILES_MAX_BYTES }) {
    Object.assign(this, { channel, transfers, backend, prepare, apply, allowed, notify, maxBytes });
    this.offers = new Map(); // token → percorsi locali copiati
    this.pending = null; // copia in arrivo
  }

  #send(msg) {
    if (this.channel.readyState === 'open') this.channel.send(JSON.stringify(msg));
  }

  /** Su questo PC sono stati copiati dei file: si annunciano all'altro. */
  async offer(paths) {
    if (!this.allowed() || !Array.isArray(paths) || !paths.length || this.channel.readyState !== 'open') return;
    let info;
    try {
      info = await this.backend.expand(paths);
    } catch (err) {
      this.notify('failed', { error: cleanError(err) });
      return;
    }
    const token = Math.random().toString(36).slice(2, 12);
    this.offers.set(token, paths.slice());
    if (this.offers.size > 3) this.offers.delete(this.offers.keys().next().value);
    const count = info.files.filter((f) => !f.dir).length;
    this.#send({ t: 'clipf', token, count, total: info.total, names: paths.slice(0, 3).map(baseName), more: Math.max(0, paths.length - 3) });
  }

  /** Messaggi "clipf*" arrivati sul canale dei file; true se erano per gli appunti. */
  handle(msg) {
    switch (msg?.t) {
      case 'clipf':
        this.#onOffer(msg);
        return true;
      case 'clipf-get':
        this.#onGet(msg);
        return true;
      case 'clipf-ready':
        this.notify('sent', { count: Number(msg.count) || 0 });
        return true;
      case 'clipf-skip':
        this.notify('skipped', { reason: String(msg.reason || ''), total: Number(msg.total) || 0 });
        return true;
      default:
        return false;
    }
  }

  async #onOffer(msg) {
    if (!this.allowed() || typeof msg.token !== 'string') return;
    const total = Number(msg.total) || 0;
    if (total > this.maxBytes) {
      this.#send({ t: 'clipf-skip', token: msg.token, reason: 'too-big', total });
      this.notify('too-big', { total });
      return;
    }
    // una copia più recente prende il posto di quella ancora in arrivo
    if (this.pending) this.transfers.cancel(this.pending.x, 'Sostituita da una copia più recente');
    const pending = { x: newXid() };
    this.pending = pending;
    try {
      pending.dir = await this.prepare();
      await this.transfers.expectDownload(pending.x, pending.dir, 'Appunti');
    } catch (err) {
      if (this.pending === pending) this.pending = null;
      this.notify('failed', { error: cleanError(err) });
      return;
    }
    const onDone = async (e) => {
      if (e.detail.x !== pending.x) return;
      this.transfers.removeEventListener('done', onDone);
      if (this.pending === pending) this.pending = null;
      if (!e.detail.ok) {
        if (!/più recente/.test(e.detail.error || '')) this.notify('failed', { error: e.detail.error });
        return;
      }
      try {
        const res = await this.apply(pending.dir);
        this.notify('ready', res);
        this.#send({ t: 'clipf-ready', token: msg.token, count: res.count });
      } catch (err) {
        this.notify('failed', { error: cleanError(err) });
      }
    };
    this.transfers.addEventListener('done', onDone);
    this.#send({ t: 'clipf-get', token: msg.token, x: pending.x });
  }

  #onGet(msg) {
    const x = Number(msg.x);
    if (!Number.isInteger(x) || x <= 0) return;
    const paths = this.offers.get(msg.token);
    if (!paths || !this.allowed()) {
      this.#send({ t: 'fcancel', x, reason: 'Appunti non più disponibili' });
      return;
    }
    this.transfers.send(x, paths, { mode: 'download' });
  }
}
