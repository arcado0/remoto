// File manager a due pannelli (questo computer / computer remoto) ed elenco dei trasferimenti.
import { h, icon, clear } from '../lib/dom.js';
import { openMenu, confirmDialog, promptDialog, toast } from '../lib/ui.js';
import { formatBytes } from '../../shared/format.js';

const DRAG_TYPE = 'application/x-remoto-files';

const cleanError = (err) => String(err?.message || err || 'Errore').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

class FilePane {
  constructor({ side, title, backend, onTransfer, onDropExternal }) {
    this.side = side;
    this.backend = backend;
    this.onTransfer = onTransfer;
    this.onDropExternal = onDropExternal;
    this.path = '';
    this.parent = null;
    this.entries = [];
    this.selected = new Set();
    this.anchor = null;
    this.roots = [];

    this.pathInput = h('input', { class: 'input', spellcheck: 'false', 'aria-label': `Percorso ${title}` });
    this.pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.open(this.pathInput.value.trim());
    });
    this.list = h('div', { class: 'fm-list', tabindex: '0', role: 'listbox', 'aria-multiselectable': 'true' });
    this.status = h('span', { class: 'grow ellipsis' });
    this.list.addEventListener('keydown', (e) => this.#onKey(e));
    this.list.addEventListener('contextmenu', (e) => {
      if (e.target === this.list) {
        e.preventDefault();
        this.selected.clear();
        this.#render();
        this.#menu(e);
      }
    });
    this.list.addEventListener('dragover', (e) => {
      const types = [...e.dataTransfer.types];
      const fromOther = types.includes(DRAG_TYPE) && FilePane.dragSide !== this.side;
      const external = types.includes('Files') && this.side === 'remote';
      if (fromOther || external) {
        e.preventDefault();
        this.list.classList.add('drop-target');
      }
    });
    this.list.addEventListener('dragleave', () => this.list.classList.remove('drop-target'));
    this.list.addEventListener('drop', (e) => {
      this.list.classList.remove('drop-target');
      e.preventDefault();
      if ([...e.dataTransfer.types].includes(DRAG_TYPE)) {
        const paths = JSON.parse(e.dataTransfer.getData(DRAG_TYPE) || '[]');
        if (FilePane.dragSide && FilePane.dragSide !== this.side) this.onTransfer(FilePane.dragSide, paths);
      } else if (e.dataTransfer.files.length && this.side === 'remote') {
        this.onDropExternal([...e.dataTransfer.files]);
      }
    });

    this.el = h(
      'section',
      { class: 'fm-pane' },
      h(
        'div',
        { class: 'fm-pane-head' },
        h('span', { class: 'title' }, title),
        h('button', { class: 'icon-btn', 'data-tip': 'Posizioni', onClick: (e) => this.#rootsMenu(e.currentTarget) }, icon('drive')),
        h('button', { class: 'icon-btn', 'data-tip': 'Cartella superiore', onClick: () => this.up() }, icon('arrow-up')),
        h('button', { class: 'icon-btn', 'data-tip': 'Aggiorna', onClick: () => this.refresh() }, icon('refresh')),
        h('button', { class: 'icon-btn', 'data-tip': 'Nuova cartella', onClick: () => this.mkdir() }, icon('folder-plus')),
      ),
      h('div', { class: 'fm-path' }, this.pathInput),
      this.list,
      h('div', { class: 'fm-foot' }, this.status),
    );
  }

  async init(defaultKind) {
    try {
      this.roots = await this.backend.roots();
      const start = this.roots.find((r) => r.kind === defaultKind) || this.roots.find((r) => r.kind === 'home') || this.roots[0];
      if (start) await this.open(start.path);
    } catch (err) {
      this.#error(err);
    }
  }

  async open(path) {
    if (!path) return;
    this.list.replaceChildren(h('div', { class: 'fm-loading' }, h('div', { class: 'spinner' })));
    try {
      const res = await this.backend.list(path);
      this.path = res.path;
      this.parent = res.parent;
      this.entries = res.entries;
      this.selected.clear();
      this.anchor = null;
      this.pathInput.value = res.path;
      this.#render();
      const files = res.entries.filter((e) => !e.dir).length;
      this.status.textContent = `${res.entries.length - files} cartelle, ${files} file${res.truncated ? ' (elenco troncato)' : ''}`;
    } catch (err) {
      this.#error(err);
    }
  }

  refresh() {
    return this.open(this.path);
  }

  up() {
    if (this.parent) this.open(this.parent);
  }

  #error(err) {
    this.list.replaceChildren(h('div', { class: 'empty' }, icon('alert'), h('h4', null, 'Impossibile aprire la cartella'), h('p', null, cleanError(err))));
    this.status.textContent = '';
  }

  selectedPaths() {
    return this.entries.filter((e) => this.selected.has(e.path)).map((e) => e.path);
  }

  #render() {
    clear(this.list);
    this.list.append(h('div', { class: 'fm-row head' }, h('span'), h('span', null, 'Nome'), h('span', { class: 'size' }, 'Dimensione'), h('span', { class: 'date' }, 'Modificato')));
    if (!this.entries.length) {
      this.list.append(h('div', { class: 'empty' }, icon('folder'), h('p', null, 'Cartella vuota')));
      return;
    }
    this.entries.forEach((e, idx) => {
      const row = h(
        'div',
        {
          class: `fm-row ${e.dir ? 'dir' : ''} ${this.selected.has(e.path) ? 'selected' : ''}`,
          role: 'option',
          'aria-selected': String(this.selected.has(e.path)),
          draggable: 'true',
          title: e.name,
        },
        icon(e.dir ? 'folder' : 'file'),
        h('span', { class: 'ellipsis' }, e.name),
        h('span', { class: 'size' }, e.dir ? '' : formatBytes(e.size)),
        h('span', { class: 'date' }, e.mtime ? new Date(e.mtime).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''),
      );
      row.addEventListener('mousedown', (ev) => this.#select(ev, idx));
      row.addEventListener('dblclick', () => (e.dir ? this.open(e.path) : this.onTransfer(this.side, [e.path])));
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        if (!this.selected.has(e.path)) this.#select({ ctrlKey: false, shiftKey: false, button: 0 }, idx);
        this.#menu(ev);
      });
      row.addEventListener('dragstart', (ev) => {
        if (!this.selected.has(e.path)) this.#select({ ctrlKey: false, shiftKey: false, button: 0 }, idx);
        FilePane.dragSide = this.side;
        ev.dataTransfer.setData(DRAG_TYPE, JSON.stringify(this.selectedPaths()));
        ev.dataTransfer.effectAllowed = 'copy';
      });
      row.addEventListener('dragend', () => (FilePane.dragSide = null));
      this.list.append(row);
    });
  }

  #select(ev, idx) {
    if (ev.button !== undefined && ev.button !== 0 && ev.button !== 2) return;
    const e = this.entries[idx];
    if (ev.shiftKey && this.anchor !== null) {
      const [a, b] = [Math.min(this.anchor, idx), Math.max(this.anchor, idx)];
      if (!ev.ctrlKey) this.selected.clear();
      for (let i = a; i <= b; i++) this.selected.add(this.entries[i].path);
    } else if (ev.ctrlKey) {
      if (this.selected.has(e.path)) this.selected.delete(e.path);
      else this.selected.add(e.path);
      this.anchor = idx;
    } else {
      if (ev.button === 2 && this.selected.has(e.path)) return;
      this.selected.clear();
      this.selected.add(e.path);
      this.anchor = idx;
    }
    this.#render();
  }

  #onKey(e) {
    const paths = this.selectedPaths();
    if (e.key === 'Delete' && paths.length) this.remove();
    else if (e.key === 'F2' && paths.length === 1) this.rename();
    else if (e.key === 'Backspace') this.up();
    else if (e.key === 'F5') this.refresh();
    else if (e.key === 'Enter' && paths.length === 1) {
      const entry = this.entries.find((x) => x.path === paths[0]);
      if (entry?.dir) this.open(entry.path);
      else this.onTransfer(this.side, paths);
    } else if (e.key === 'a' && e.ctrlKey) {
      e.preventDefault();
      this.entries.forEach((x) => this.selected.add(x.path));
      this.#render();
    } else return;
    e.preventDefault();
  }

  #menu(ev) {
    const paths = this.selectedPaths();
    const single = paths.length === 1 ? this.entries.find((x) => x.path === paths[0]) : null;
    const anchor = { getBoundingClientRect: () => ({ left: ev.clientX, right: ev.clientX, top: ev.clientY, bottom: ev.clientY }) };
    openMenu(anchor, [
      single?.dir && { label: 'Apri', icon: 'folder', onClick: () => this.open(single.path) },
      paths.length && { label: this.side === 'local' ? 'Invia al computer remoto' : 'Scarica su questo computer', icon: this.side === 'local' ? 'upload' : 'download', onClick: () => this.onTransfer(this.side, paths) },
      paths.length && { divider: true },
      single && { label: 'Rinomina', icon: 'edit', shortcut: 'F2', onClick: () => this.rename() },
      paths.length && { label: 'Elimina', icon: 'trash', danger: true, shortcut: 'Canc', onClick: () => this.remove() },
      { label: 'Nuova cartella', icon: 'folder-plus', onClick: () => this.mkdir() },
      { label: 'Aggiorna', icon: 'refresh', shortcut: 'F5', onClick: () => this.refresh() },
    ]);
  }

  #rootsMenu(anchor) {
    openMenu(
      anchor,
      this.roots.map((r) => ({ label: r.name, sub: r.path, icon: r.kind === 'drive' ? 'drive' : r.kind === 'home' ? 'home' : 'folder', onClick: () => this.open(r.path) })),
    );
  }

  async mkdir() {
    const name = await promptDialog({ title: 'Nuova cartella', label: 'Nome', value: 'Nuova cartella', confirm: 'Crea' });
    if (!name) return;
    try {
      await this.backend.mkdir(this.path, name);
      await this.refresh();
    } catch (err) {
      toast({ kind: 'bad', title: 'Cartella non creata', text: cleanError(err) });
    }
  }

  async rename() {
    const [p] = this.selectedPaths();
    const entry = this.entries.find((x) => x.path === p);
    if (!entry) return;
    const name = await promptDialog({ title: 'Rinomina', label: 'Nuovo nome', value: entry.name, confirm: 'Rinomina' });
    if (!name || name === entry.name) return;
    try {
      await this.backend.rename(p, name);
      await this.refresh();
    } catch (err) {
      toast({ kind: 'bad', title: 'Rinomina non riuscita', text: cleanError(err) });
    }
  }

  async remove() {
    const paths = this.selectedPaths();
    if (!paths.length) return;
    const where = this.side === 'remote' ? ' sul computer remoto' : '';
    const ok = await confirmDialog({
      title: paths.length === 1 ? 'Eliminare l’elemento?' : `Eliminare ${paths.length} elementi?`,
      text: `L’eliminazione${where} è definitiva: gli elementi non vanno nel Cestino.`,
      confirm: 'Elimina',
      danger: true,
    });
    if (!ok) return;
    for (const p of paths) {
      try {
        await this.backend.remove(p);
      } catch (err) {
        toast({ kind: 'bad', title: 'Eliminazione non riuscita', text: cleanError(err) });
        break;
      }
    }
    await this.refresh();
  }
}
FilePane.dragSide = null;

/** Elenco dei trasferimenti (condiviso tra file manager e trascinamento sulla sessione). */
export class TransferList {
  constructor() {
    this.rows = new Map();
    this.body = h('div', { class: 'col', style: { gap: '0' } });
    this.el = h('div', { class: 'fm-transfers hidden' }, h('h4', null, 'Trasferimenti'), this.body);
  }

  bind(engine) {
    this.engine = engine;
    engine.addEventListener('start', (e) => this.#start(e.detail));
    engine.addEventListener('progress', (e) => this.#progress(e.detail));
    engine.addEventListener('done', (e) => this.#done(e.detail, engine));
  }

  #start(d) {
    this.el.classList.remove('hidden');
    let r = this.rows.get(d.x);
    if (!r) {
      const bar = h('span', { style: { width: '0%' } });
      const info = h('div', { class: 'xfer-info' }, 'In preparazione…');
      const name = h('div', { class: 'xfer-name ellipsis' }, d.name || '…');
      const action = h('button', { class: 'icon-btn', 'data-tip': 'Annulla', 'aria-label': 'Annulla', onClick: () => this.engine?.cancel(d.x) }, icon('x'));
      const el = h('div', { class: 'xfer' }, icon(d.dir === 'out' ? 'upload' : 'download'), name, action, info, h('div', { class: 'progress' }, bar));
      r = { el, bar, info, name, action, started: performance.now(), dir: d.dir };
      this.rows.set(d.x, r);
      this.body.prepend(el);
    }
    r.total = d.total;
    r.count = d.count;
    if (d.name) r.name.textContent = d.name;
  }

  #progress(d) {
    const r = this.rows.get(d.x);
    if (!r) return;
    const pct = d.total ? Math.min(100, (d.done / d.total) * 100) : 0;
    r.bar.style.width = `${pct.toFixed(1)}%`;
    const secs = (performance.now() - r.started) / 1000;
    const speed = secs > 0.5 ? `${formatBytes(d.done / secs)}/s` : '';
    r.info.textContent = `${formatBytes(d.done)} di ${formatBytes(d.total)}${speed ? ` · ${speed}` : ''}${d.count > 1 ? ` · ${d.count} file` : ''}${d.file ? ` · ${d.file}` : ''}`;
  }

  #done(d) {
    const r = this.rows.get(d.x);
    if (!r) return;
    r.el.classList.add(d.ok ? 'ok' : 'bad');
    r.bar.style.width = '100%';
    const secs = (performance.now() - r.started) / 1000;
    r.info.textContent = d.ok ? `Completato · ${formatBytes(d.total || r.total || 0)} in ${secs.toFixed(1)} s` : `Non riuscito: ${d.error || 'errore'}`;
    r.action.replaceChildren(icon(d.ok ? (d.dir === 'in' ? 'folder' : 'check') : 'alert'));
    r.action.removeAttribute('data-tip');
    r.action.onclick = d.ok && d.dir === 'in' && d.paths?.length ? () => remoto.invoke('viewer:show-item', d.paths[0]) : null;
    if (d.ok && d.dir === 'in' && d.paths?.length) r.action.setAttribute('data-tip', 'Mostra nella cartella');
  }
}

export class FileManager {
  /**
   * @param {object} o
   * @param {object} o.localBackend / o.remoteBackend  { roots, list, mkdir, rename, remove }
   * @param {(paths:string[], dest:string) => void} o.upload
   * @param {(paths:string[], dest:string) => void} o.download
   */
  constructor({ localBackend, remoteBackend, upload, download, transferList, onClose, full = false }) {
    this.local = new FilePane({ side: 'local', title: 'Questo computer', backend: localBackend, onTransfer: (side, paths) => this.#transfer(side, paths), onDropExternal: () => {} });
    this.remote = new FilePane({
      side: 'remote',
      title: 'Computer remoto',
      backend: remoteBackend,
      onTransfer: (side, paths) => this.#transfer(side, paths),
      onDropExternal: (files) => {
        const paths = files.map((f) => remoto.pathForFile(f)).filter(Boolean);
        if (paths.length) upload(paths, this.remote.path, () => this.remote.refresh());
      },
    });
    this.upload = upload;
    this.download = download;
    const mid = h(
      'div',
      { class: 'fm-mid' },
      h('button', { class: 'btn soft sm', 'data-tip': 'Invia la selezione al computer remoto', onClick: () => this.#transfer('local', this.local.selectedPaths()) }, icon('arrow-right')),
      h('button', { class: 'btn soft sm', 'data-tip': 'Scarica la selezione su questo computer', onClick: () => this.#transfer('remote', this.remote.selectedPaths()) }, icon('arrow-left')),
    );
    this.el = h(
      'div',
      { class: 'fm' },
      h(
        'div',
        { class: 'side-head' },
        h('h3', null, 'Trasferimento file'),
        !full && h('button', { class: 'icon-btn', 'aria-label': 'Chiudi', onClick: onClose }, icon('x')),
      ),
      h('div', { class: 'fm-panes' }, this.local.el, mid, this.remote.el),
      transferList.el,
    );
  }

  async init() {
    await Promise.all([this.local.init('downloads'), this.remote.init('desktop')]);
  }

  #transfer(fromSide, paths) {
    if (!paths.length) {
      toast({ kind: 'info', title: 'Seleziona almeno un file o una cartella' });
      return;
    }
    if (fromSide === 'local') this.upload(paths, this.remote.path, () => this.remote.refresh());
    else this.download(paths, this.local.path, () => this.local.refresh());
  }

  refreshRemote() {
    return this.remote.refresh();
  }
}
