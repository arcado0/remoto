// Finestre sovrapposte allo schermo del PC controllato:
// - privacy: nere, a tutto schermo, escluse dalla cattura (WDA_EXCLUDEFROMCAPTURE) e
//   trasparenti ai click, così chi controlla vede il desktop e chi è davanti vede nero;
// - lavagna: trasparenti, per i disegni di chi controlla; anch'esse escluse dalla cattura
//   (chi disegna vede già i tratti in locale, senza ritardo).

export class PrivacyOverlay {
  constructor({ windows, screen }) {
    this.windows = windows;
    this.screen = screen;
    this.owners = new Set();
    this.wins = [];
    this.keepTop = null;
  }

  get active() {
    return this.wins.length > 0;
  }

  set(owner, on) {
    if (on) this.owners.add(owner);
    else this.owners.delete(owner);
    this.#sync();
    return this.active;
  }

  releaseAll() {
    this.owners.clear();
    this.#sync();
  }

  /** Monitor aggiunti o rimossi: si ricreano le finestre. */
  refresh() {
    if (!this.active) return;
    this.#destroy();
    this.#sync();
  }

  #sync() {
    if (this.owners.size && !this.active) this.#create();
    else if (!this.owners.size && this.active) this.#destroy();
  }

  #create() {
    for (const d of this.screen.getAllDisplays()) {
      const win = this.windows.create('overlay', {
        page: 'overlay/privacy.html',
        bounds: d.bounds,
        frame: false,
        transparent: false,
        backgroundColor: '#000000',
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        focusable: false,
        alwaysOnTop: true,
        hasShadow: false,
        enableLargerThanScreen: true,
        show: false,
      });
      win.setContentProtection(true);
      win.setIgnoreMouseEvents(true);
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setBounds(d.bounds);
      win.once('ready-to-show', () => win.showInactive());
      this.wins.push(win);
    }
    // la barra delle applicazioni o un menu Start potrebbero salire sopra: si riafferma
    this.keepTop = setInterval(() => {
      for (const w of this.wins) if (!w.isDestroyed()) w.moveTop();
    }, 1500);
  }

  #destroy() {
    clearInterval(this.keepTop);
    this.keepTop = null;
    for (const w of this.wins) if (!w.isDestroyed()) w.destroy();
    this.wins = [];
  }
}

export class WhiteboardOverlay {
  constructor({ windows, screen }) {
    this.windows = windows;
    this.screen = screen;
    this.byDisplay = new Map(); // displayId → { win, ready, queue, owners:Set }
  }

  #ensure(displayId) {
    let e = this.byDisplay.get(displayId);
    if (e && !e.win.isDestroyed()) return e;
    const d = this.screen.getAllDisplays().find((x) => String(x.id) === String(displayId)) || this.screen.getPrimaryDisplay();
    const win = this.windows.create('overlay', {
      page: 'overlay/whiteboard.html',
      bounds: d.bounds,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      hasShadow: false,
      enableLargerThanScreen: true,
      show: false,
    });
    win.setContentProtection(true);
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    e = { win, ready: false, queue: [], owners: new Set() };
    win.webContents.once('did-finish-load', () => {
      e.ready = true;
      for (const op of e.queue) win.webContents.send('wb:op', op);
      e.queue = [];
      win.showInactive();
    });
    this.byDisplay.set(displayId, e);
    return e;
  }

  op(owner, displayId, op) {
    const e = this.#ensure(String(displayId));
    e.owners.add(owner);
    const payload = { ...op, owner };
    if (e.ready) e.win.webContents.send('wb:op', payload);
    else e.queue.push(payload);
  }

  /** Cancella i tratti di una sessione; chiude le lavagne rimaste senza sessioni. */
  release(owner) {
    for (const [id, e] of this.byDisplay) {
      if (!e.owners.has(owner)) continue;
      e.owners.delete(owner);
      if (e.owners.size === 0) {
        if (!e.win.isDestroyed()) e.win.destroy();
        this.byDisplay.delete(id);
      } else if (e.ready) e.win.webContents.send('wb:op', { op: 'clear', owner });
    }
  }

  releaseAll() {
    for (const e of this.byDisplay.values()) if (!e.win.isDestroyed()) e.win.destroy();
    this.byDisplay.clear();
  }
}
