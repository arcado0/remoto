// Finestra principale: questa postazione, connessione a una postazione remota, recenti,
// rubrica, rete locale. Le impostazioni sono in settings.js.
import { h, icon, $, replace } from '../lib/dom.js';
import { bootPage, toast, modal, confirmDialog, promptDialog, openMenu, switchEl, avatar, applyTheme, setSounds } from '../lib/ui.js';
import { formatId, parseTarget, targetLabel } from '../../shared/ids.js';
import { DEFAULT_PORTS } from '../../shared/protocol.js';
import { formatRelativeTime } from '../../shared/format.js';
import { renderSettings } from './settings.js';

const appEl = $('#app');

const H = {
  me: null,
  version: '',
  config: null,
  status: null,
  peers: [],
  presence: {},
  tab: 'recent',
  view: 'main',
  section: 'general',
  query: '',
};

await bootPage();
const init = await remoto.invoke('home:init');
Object.assign(H, { me: init.me, version: init.version, config: init.config, status: init.status, peers: init.peers });
if (H.peers.length && !H.config.recent.length && !H.config.addressBook.length) H.tab = 'lan';

remoto.on('home:status', (s) => {
  H.status = s;
  renderLeft();
  renderStatusbar();
  if (H.view === 'settings') renderView();
});
remoto.on('home:peers', (p) => {
  H.peers = p;
  renderTabs();
  if (H.tab === 'lan') renderGrid();
});
remoto.on('home:config', (c) => {
  H.config = c;
  H.me = { ...H.me, name: c.profile.name };
  applyTheme(c.general.theme);
  setSounds(c.general.sounds !== false);
  render();
});

// ---------------------------------------------------------------- scheletro

const topbarEl = h('header', { class: 'topbar' });
const bodyEl = h('div', { class: 'body' });
const statusbarEl = h('footer', { class: 'statusbar' });
appEl.append(topbarEl, bodyEl, statusbarEl);

let leftEl;
let gridEl;
let tabsEl;

function render() {
  renderTopbar();
  renderView();
  renderStatusbar();
}

function renderView() {
  if (H.view === 'settings') {
    bodyEl.className = 'settings';
    replace(bodyEl, ...renderSettings({ H, api: settingsApi, onSection: (s) => {
      H.section = s;
      renderView();
    } }));
    return;
  }
  bodyEl.className = 'body';
  leftEl = h('aside', { class: 'left' });
  tabsEl = h('div', { class: 'tabs' });
  gridEl = h('div', { class: 'grid' });
  const main = h(
    'section',
    { class: 'main' },
    h('div', { class: 'main-head' }, tabsEl, h('div', { class: 'spacer' }), h('button', { class: 'btn sm', onClick: () => editBookEntry() }, icon('plus', 'sm'), 'Aggiungi alla rubrica')),
    gridEl,
  );
  replace(bodyEl, leftEl, main);
  renderLeft();
  renderTabs();
  renderGrid();
}

// ---------------------------------------------------------------- testata

let suggestEl = null;
let suggestIdx = -1;
let connectInput;

function renderTopbar() {
  connectInput = h('input', {
    class: 'input',
    placeholder: 'ID o indirizzo della postazione remota',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'ID o indirizzo della postazione remota',
    value: H.query,
  });
  connectInput.addEventListener('input', () => {
    H.query = connectInput.value;
    showSuggestions();
  });
  connectInput.addEventListener('focus', () => showSuggestions());
  connectInput.addEventListener('blur', () => setTimeout(hideSuggestions, 150));
  connectInput.addEventListener('keydown', (e) => {
    const items = suggestEl ? [...suggestEl.querySelectorAll('.suggest-item')] : [];
    if (e.key === 'ArrowDown' && items.length) {
      suggestIdx = (suggestIdx + 1) % items.length;
      items.forEach((it, i) => it.classList.toggle('active', i === suggestIdx));
      e.preventDefault();
    } else if (e.key === 'ArrowUp' && items.length) {
      suggestIdx = (suggestIdx - 1 + items.length) % items.length;
      items.forEach((it, i) => it.classList.toggle('active', i === suggestIdx));
      e.preventDefault();
    } else if (e.key === 'Enter') {
      if (suggestIdx >= 0 && items[suggestIdx]) items[suggestIdx].click();
      else connect(connectInput.value, 'desktop');
    } else if (e.key === 'Escape') hideSuggestions();
  });

  const bar = h(
    'div',
    { class: 'connect-bar' },
    h('div', { class: 'connect-input' }, icon('search'), connectInput),
    h('button', { class: 'btn primary lg', onClick: () => connect(connectInput.value, 'desktop') }, icon('monitor'), 'Connetti'),
    h('button', { class: 'btn lg', 'data-tip': 'Solo trasferimento file', onClick: () => connect(connectInput.value, 'files') }, icon('folder')),
  );
  replace(
    topbarEl,
    h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, icon('logo')), 'Remoto'),
    bar,
    h(
      'div',
      { class: 'tools' },
      H.view === 'settings'
        ? h('button', { class: 'btn ghost', onClick: () => setView('main') }, icon('arrow-left', 'sm'), 'Indietro')
        : h('button', { class: 'icon-btn', 'data-tip': 'Impostazioni', 'aria-label': 'Impostazioni', onClick: () => setView('settings') }, icon('sliders')),
      h('button', { class: 'icon-btn', 'data-tip': 'Menu', 'aria-label': 'Menu', onClick: (e) => appMenu(e.currentTarget) }, icon('more')),
    ),
  );
}

function setView(v) {
  H.view = v;
  renderTopbar();
  renderView();
}

function appMenu(anchor) {
  openMenu(
    anchor,
    [
      { label: 'Copia il mio ID', icon: 'copy', onClick: () => copyId() },
      { label: 'Impostazioni', icon: 'sliders', onClick: () => setView('settings') },
      { label: 'Registro accessi', icon: 'list', onClick: () => {
        H.section = 'log';
        setView('settings');
      } },
      { label: 'Apri la cartella dei log', icon: 'folder', onClick: () => remoto.invoke('app:open-logs') },
      { divider: true },
      { label: 'Nascondi nella barra delle notifiche', icon: 'minimize', onClick: () => remoto.invoke('app:hide') },
      { label: 'Esci da Remoto', icon: 'power', danger: true, onClick: async () => {
        if (await confirmDialog({ title: 'Uscire da Remoto?', text: 'Le sessioni attive verranno chiuse e questa postazione non sarà più raggiungibile finché non riapri Remoto.', confirm: 'Esci', danger: true })) remoto.invoke('app:quit');
      } },
    ],
    { align: 'right' },
  );
}

function knownTargets() {
  const out = [];
  const seen = new Set();
  const add = (key, label, sub, value, kind) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label, sub, value, kind });
  };
  for (const e of H.config.addressBook) add(e.key, e.alias || targetLabel(e.target), targetLabel(e.target), inputFor(e.target), 'book');
  for (const e of H.config.recent) add(e.key, e.name || targetLabel(e.target), targetLabel(e.target), inputFor(e.target), 'clock');
  for (const p of H.peers) add(`id:${p.id}`, p.name, formatId(p.id), p.id, 'wifi');
  return out;
}

function showSuggestions() {
  hideSuggestions();
  const q = connectInput.value.trim().toLowerCase().replace(/\s/g, '');
  if (!q) return;
  const items = knownTargets()
    .filter((t) => t.label.toLowerCase().includes(q) || t.sub.toLowerCase().replace(/\s/g, '').includes(q))
    .slice(0, 6);
  if (!items.length) return;
  suggestIdx = -1;
  suggestEl = h(
    'div',
    { class: 'suggest' },
    items.map((t) =>
      h(
        'button',
        { class: 'suggest-item', onMousedown: (e) => e.preventDefault(), onClick: () => {
          connectInput.value = t.value;
          H.query = t.value;
          hideSuggestions();
          connect(t.value, 'desktop');
        } },
        icon(t.kind),
        h('span', { class: 'ellipsis' }, t.label),
        h('span', { class: 'mono' }, t.sub),
      ),
    ),
  );
  connectInput.closest('.connect-bar').append(suggestEl);
}

function hideSuggestions() {
  suggestEl?.remove();
  suggestEl = null;
}

async function connect(input, mode) {
  const value = String(input || '').trim();
  if (!value) {
    connectInput?.focus();
    toast({ kind: 'info', title: 'Inserisci l’ID della postazione remota', text: 'Oppure un indirizzo IP o un nome host della rete locale.' });
    return;
  }
  const res = await remoto.invoke('connect', { input: value, mode });
  if (!res.ok) toast({ kind: 'bad', title: 'Impossibile connettersi', text: res.error });
  else {
    H.query = '';
    if (connectInput) connectInput.value = '';
  }
}

const inputFor = (target) => (target.kind === 'id' ? target.id : targetLabel(target));

// ---------------------------------------------------------------- colonna sinistra

function copyId() {
  remoto.invoke('app:copy', H.me.id);
  toast({ kind: 'ok', title: 'ID copiato negli appunti', text: formatId(H.me.id) });
}

function serverLine() {
  const s = H.status.server;
  const map = {
    online: ['ok', 'Server ID connesso', s.url],
    connecting: ['warn pulse', 'Connessione al server ID…', s.detail || s.url],
    offline: ['bad', 'Server ID non raggiungibile', s.detail || s.url],
    error: ['bad', 'Errore del server ID', s.detail],
    disabled: ['', 'Nessun server ID', 'Solo rete locale: configura un server in Impostazioni › Rete'],
  };
  const [cls, k, v] = map[s.state] || map.disabled;
  return h('div', { class: 'status-line' }, h('span', { class: `dot ${cls}` }), h('div', null, h('div', { class: 'k' }, k), v && h('div', { class: 'v' }, v)));
}

function lanLine() {
  const d = H.status.direct;
  // l'indirizzo da comunicare è quello della rete principale; le schede virtuali (Hyper-V, VPN...) in fondo
  const list = H.status.addresses || [];
  const main = list.find((a) => !a.virtual) || list[0];
  const addrs = main ? `${main.address}${list.length > 1 ? ` (+${list.length - 1})` : ''}` : '';
  if (!d.enabled) return h('div', { class: 'status-line' }, h('span', { class: 'dot' }), h('div', null, h('div', { class: 'k' }, 'Connessioni dirette disattivate')));
  if (!d.listening) return h('div', { class: 'status-line' }, h('span', { class: 'dot bad' }), h('div', null, h('div', { class: 'k' }, 'Connessioni dirette non attive'), h('div', { class: 'v' }, d.error || '')));
  return h('div', { class: 'status-line' }, h('span', { class: 'dot ok' }), h('div', null, h('div', { class: 'k' }, 'Raggiungibile in rete locale'), h('div', { class: 'v' }, `${addrs || 'nessuna rete'} · porta ${d.port}`)));
}

function renderLeft() {
  if (!leftEl) return;
  const sec = H.config.security;
  const sessions = H.status.hostSessions.filter((s) => s.state === 'active' || s.state === 'connecting');
  const pending = H.status.hostSessions.filter((s) => s.state === 'pending');

  replace(
    leftEl,
    h(
      'div',
      { class: 'card desk-card' },
      h('div', { class: 'section-label' }, 'Questa postazione'),
      h(
        'div',
        { class: 'desk-id' },
        h('span', { class: 'id', 'data-testid': 'my-id' }, formatId(H.me.id)),
        h('button', { class: 'icon-btn', 'data-tip': 'Copia ID', 'aria-label': 'Copia ID', onClick: copyId }, icon('copy')),
      ),
      h(
        'div',
        { class: 'desk-name' },
        icon('laptop', 'sm'),
        h('span', { class: 'ellipsis grow' }, H.me.name),
        h('button', { class: 'icon-btn', style: { width: '28px', height: '28px' }, 'data-tip': 'Rinomina', 'aria-label': 'Rinomina questa postazione', onClick: renameDesk }, icon('edit', 'sm')),
      ),
      h('div', { class: 'status-list' }, serverLine(), lanLine()),
    ),
    pending.length
      ? h(
          'div',
          { class: 'card access-card request-card', role: 'alert' },
          h('div', { class: 'section-label' }, pending.length > 1 ? `${pending.length} richieste di connessione` : 'Richiesta di connessione'),
          pending.map((s) =>
            h(
              'div',
              { class: 'col', style: { gap: '10px' } },
              h('div', { class: 'row' }, avatar(s.viewerName, 'sm'), h('div', { class: 'grow' }, h('div', { class: 'ellipsis', style: { fontWeight: 600 } }, s.viewerName), h('div', { class: 'faint mono', style: { fontSize: '12px' } }, s.viewerId ? formatId(s.viewerId) : s.address || '')), h('span', { class: 'badge warn' }, s.mode === 'files' ? 'File' : 'Controllo')),
              h(
                'div',
                { class: 'row' },
                h('button', { class: 'btn sm', style: { flex: '1' }, onClick: () => remoto.invoke('host:answer', s.id, false) }, icon('x', 'sm'), 'Rifiuta'),
                h('button', { class: 'btn primary sm', style: { flex: '1' }, onClick: () => remoto.invoke('host:answer', s.id, true) }, icon('check', 'sm'), 'Accetta'),
              ),
              h('a', { style: { fontSize: '12.5px' }, onClick: () => remoto.invoke('host:show-prompt', s.id) }, 'Scegli i permessi nella finestra di richiesta'),
            ),
          ),
        )
      : null,
    sessions.length
      ? h(
          'div',
          { class: 'card access-card', style: { borderColor: 'var(--accent)' } },
          h('div', { class: 'section-label' }, 'Sessioni in arrivo'),
          sessions.map((s) =>
            h('div', { class: 'row' }, avatar(s.viewerName, 'sm'), h('div', { class: 'grow' }, h('div', { class: 'ellipsis', style: { fontWeight: 600 } }, s.viewerName), h('div', { class: 'faint mono', style: { fontSize: '12px' } }, s.viewerId ? formatId(s.viewerId) : s.address || '')), h('span', { class: `badge ${s.state === 'active' ? 'ok' : 'warn'}` }, s.state === 'active' ? 'Attiva' : 'Avvio')),
          ),
        )
      : null,
    h(
      'div',
      { class: 'card access-card' },
      h('div', { class: 'section-label' }, 'Accesso a questa postazione'),
      h('div', { class: 'access-row' }, h('span', null, 'Consenti connessioni in arrivo'), switchEl({ checked: sec.allowIncoming, ariaLabel: 'Consenti connessioni in arrivo', onChange: (v) => remoto.invoke('config:update', { security: { allowIncoming: v } }) })),
      h('p', { class: 'hint' }, 'Ogni connessione compare in una finestra su questo PC e parte solo se qualcuno la accetta.'),
      H.status.fullControl && !H.status.fullControl.running && h(
        'p',
        { class: 'hint' },
        'Per controllare anche richieste UAC, finestre di amministratore e schermata di blocco, installa il “controllo completo” in ',
        h('a', { onClick: () => { H.section = 'security'; setView('settings'); } }, 'Impostazioni → Sicurezza'),
        '.',
      ),
    ),
  );
}

async function renameDesk() {
  const name = await promptDialog({ title: 'Nome di questa postazione', label: 'Nome mostrato a chi si collega', value: H.me.name, confirm: 'Salva' });
  if (name && name.trim()) remoto.invoke('config:update', { profile: { name: name.trim() } });
}

// ---------------------------------------------------------------- schede

function renderTabs() {
  if (!tabsEl) return;
  const tabs = [
    ['recent', 'clock', 'Recenti', H.config.recent.length],
    ['book', 'book', 'Rubrica', H.config.addressBook.length],
    ['lan', 'wifi', 'Rete locale', H.peers.length],
  ];
  replace(
    tabsEl,
    tabs.map(([key, ic, label, count]) =>
      h('button', { class: `tab ${H.tab === key ? 'active' : ''}`, onClick: () => {
        H.tab = key;
        renderTabs();
        renderGrid();
      } }, icon(ic, 'sm'), label, h('span', { class: 'count' }, String(count))),
    ),
  );
}

function presenceDot(id) {
  if (!id || H.status.server.state !== 'online') return null;
  const p = H.presence[id];
  if (p === undefined) return null;
  return h('span', { class: `dot ${p ? 'ok' : ''}`, title: p ? 'Online' : 'Offline' });
}

function deskCard({ name, sub, id, meta, value, mac, menu }) {
  const online = id && H.status.server.state === 'online' ? H.presence[id] : undefined;
  return h(
    'div',
    { class: 'card desk', onDblclick: () => connect(value, 'desktop') },
    h(
      'div',
      { class: 'top' },
      h('div', { class: 'avatar-wrap' }, avatar(name), online !== undefined ? h('span', { class: `dot ${online ? 'ok' : ''}` }) : null),
      h('div', { class: 'who' }, h('div', { class: 'n ellipsis' }, name), h('div', { class: 'i ellipsis' }, sub)),
      h('button', { class: 'icon-btn', 'aria-label': 'Altre azioni', onClick: (e) => openMenu(e.currentTarget, menu(), { align: 'right' }) }, icon('more')),
    ),
    h('div', { class: 'meta' }, meta),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn primary sm', onClick: () => connect(value, 'desktop') }, icon('monitor', 'sm'), 'Connetti'),
      h('button', { class: 'btn sm', 'data-tip': 'Trasferimento file', onClick: () => connect(value, 'files') }, icon('folder', 'sm')),
      mac ? h('button', { class: 'btn sm', 'data-tip': 'Accendi (Wake-on-LAN)', onClick: () => wake(mac, name) }, icon('power', 'sm')) : null,
    ),
  );
}

function renderGrid() {
  if (!gridEl) return;
  const c = H.config;
  let cards = [];
  if (H.tab === 'recent') {
    cards = c.recent.map((r) =>
      deskCard({
        name: r.name || targetLabel(r.target),
        sub: targetLabel(r.target),
        id: r.target.kind === 'id' ? r.target.id : r.hostId,
        value: inputFor(r.target),
        mac: r.mac,
        meta: [presenceDot(r.target.kind === 'id' ? r.target.id : r.hostId), `Ultima connessione ${formatRelativeTime(r.lastConnected)}`, r.count > 1 ? ` · ${r.count} volte` : ''],
        menu: () => [
          { label: 'Aggiungi alla rubrica', icon: 'star', onClick: () => editBookEntry({ input: inputFor(r.target), alias: r.name, mac: r.mac }) },
          r.mac && { label: 'Accendi con Wake-on-LAN', icon: 'power', onClick: () => wake(r.mac, r.name) },
          { label: 'Copia ID o indirizzo', icon: 'copy', onClick: () => remoto.invoke('app:copy', inputFor(r.target)) },
          { divider: true },
          { label: 'Rimuovi dai recenti', icon: 'trash', danger: true, onClick: () => remoto.invoke('recent:remove', r.key) },
        ],
      }),
    );
    if (!cards.length) {
      cards = [emptyState('clock', 'Nessuna connessione recente', 'Inserisci l’ID di una postazione nella barra in alto e premi Connetti. Le connessioni riuscite compaiono qui.')];
    }
  } else if (H.tab === 'book') {
    cards = c.addressBook.map((e) =>
      deskCard({
        name: e.alias || targetLabel(e.target),
        sub: targetLabel(e.target),
        id: e.target.kind === 'id' ? e.target.id : null,
        value: inputFor(e.target),
        mac: e.mac,
        meta: [presenceDot(e.target.kind === 'id' ? e.target.id : null), e.notes ? h('span', { class: 'ellipsis' }, e.notes) : 'Nessuna nota'],
        menu: () => [
          { label: 'Modifica', icon: 'edit', onClick: () => editBookEntry({ input: inputFor(e.target), alias: e.alias, notes: e.notes, mac: e.mac, oldKey: e.key }) },
          e.mac && { label: 'Accendi con Wake-on-LAN', icon: 'power', onClick: () => wake(e.mac, e.alias) },
          { label: 'Copia ID o indirizzo', icon: 'copy', onClick: () => remoto.invoke('app:copy', inputFor(e.target)) },
          { divider: true },
          { label: 'Elimina dalla rubrica', icon: 'trash', danger: true, onClick: async () => {
            if (await confirmDialog({ title: 'Eliminare dalla rubrica?', text: `${e.alias || targetLabel(e.target)} verrà rimosso dalla rubrica.`, confirm: 'Elimina', danger: true })) remoto.invoke('book:remove', e.key);
          } },
        ],
      }),
    );
    if (!cards.length) cards = [emptyState('book', 'La rubrica è vuota', 'Salva le postazioni che usi spesso con un nome, delle note e il MAC per accenderle da remoto.', h('button', { class: 'btn primary sm', onClick: () => editBookEntry() }, icon('plus', 'sm'), 'Aggiungi postazione'))];
  } else {
    cards = H.peers.map((p) =>
      deskCard({
        name: p.name,
        sub: formatId(p.id),
        id: null,
        value: p.id,
        mac: null,
        meta: [h('span', { class: 'dot ok' }), `${p.address} · ${p.os || 'rete locale'}`],
        menu: () => [
          { label: 'Aggiungi alla rubrica', icon: 'star', onClick: () => editBookEntry({ input: p.id, alias: p.name, mac: p.macs?.[0] || '' }) },
          { label: 'Connetti per indirizzo IP', icon: 'link', onClick: () => connect(`${p.address}:${p.port}`, 'desktop') },
          { label: 'Copia ID', icon: 'copy', onClick: () => remoto.invoke('app:copy', p.id) },
        ],
      }),
    );
    if (!cards.length) {
      const disc = H.status.discovery;
      cards = [emptyState('wifi', 'Nessuna postazione trovata in rete locale', disc.enabled ? 'Le postazioni con Remoto aperto nella stessa rete compaiono qui automaticamente.' : 'Il rilevamento in rete locale è disattivato (Impostazioni › Rete).')];
    }
  }
  replace(gridEl, ...cards);
}

function emptyState(ic, title, text, action) {
  return h('div', { class: 'empty', style: { gridColumn: '1 / -1', paddingTop: '60px' } }, icon(ic), h('h4', null, title), h('p', { style: { maxWidth: '420px' } }, text), action || null);
}

async function wake(mac, name) {
  try {
    await remoto.invoke('wol', mac);
    toast({ kind: 'ok', title: 'Pacchetto di accensione inviato', text: `${name || mac}: se il computer supporta il Wake-on-LAN si accenderà tra poco.` });
  } catch (err) {
    toast({ kind: 'bad', title: 'Wake-on-LAN non riuscito', text: String(err.message || err) });
  }
}

async function editBookEntry(prefill = {}) {
  const input = h('input', { class: 'input', value: prefill.input || '', placeholder: '123 456 789 oppure 192.168.1.20', spellcheck: 'false' });
  const alias = h('input', { class: 'input', value: prefill.alias || '', placeholder: 'Es. PC ufficio Mario' });
  const notes = h('textarea', { class: 'input', placeholder: 'Note (facoltative)' }, prefill.notes || '');
  const mac = h('input', { class: 'input', value: prefill.mac || '', placeholder: 'aa:bb:cc:dd:ee:ff (per il Wake-on-LAN)', spellcheck: 'false' });
  const err = h('div', { class: 'error-text' });
  const result = await modal({
    title: prefill.oldKey ? 'Modifica postazione' : 'Aggiungi alla rubrica',
    body: h(
      'div',
      { class: 'col', style: { gap: '12px' } },
      h('div', { class: 'field' }, h('label', null, 'ID o indirizzo'), input),
      h('div', { class: 'field' }, h('label', null, 'Nome'), alias),
      h('div', { class: 'field' }, h('label', null, 'Note'), notes),
      h('div', { class: 'field' }, h('label', null, 'Indirizzo MAC'), mac),
      err,
    ),
    actions: [
      { label: 'Annulla', value: null },
      {
        label: 'Salva',
        kind: 'primary',
        value: async () => {
          if (!parseTarget(input.value, DEFAULT_PORTS.direct)) {
            err.textContent = 'Inserisci un ID di 9 cifre oppure un indirizzo IP o un nome host.';
            input.classList.add('invalid');
            return undefined;
          }
          if (mac.value && !/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(mac.value.trim())) {
            err.textContent = 'Indirizzo MAC non valido.';
            return undefined;
          }
          return { input: input.value, alias: alias.value, notes: notes.value, mac: mac.value.trim().toLowerCase().replace(/-/g, ':'), oldKey: prefill.oldKey };
        },
      },
    ],
  });
  if (!result) return;
  const res = await remoto.invoke('book:save', result);
  if (!res.ok) toast({ kind: 'bad', title: 'Non salvato', text: res.error });
  else {
    H.tab = 'book';
    toast({ kind: 'ok', title: 'Postazione salvata in rubrica' });
  }
}

// ---------------------------------------------------------------- barra di stato e presenza

function renderStatusbar() {
  const s = H.status;
  const srv = { online: ['ok', 'Server ID connesso'], connecting: ['warn pulse', 'Connessione al server…'], offline: ['bad', 'Server non raggiungibile'], error: ['bad', 'Errore server'], disabled: ['', 'Nessun server ID'] }[s.server.state] || ['', ''];
  replace(
    statusbarEl,
    h('span', { class: 'item' }, h('span', { class: `dot ${srv[0]}` }), srv[1]),
    h('span', { class: 'item' }, icon('wifi', 'sm'), s.discovery.enabled ? `${s.discovery.count} in rete locale` : 'Rilevamento LAN disattivato'),
    s.embedded.enabled && h('span', { class: 'item' }, icon('server', 'sm'), s.embedded.running ? `Server integrato attivo (porta ${s.embedded.port})` : `Server integrato: ${s.embedded.error || 'non attivo'}`),
    h('span', { class: 'spacer' }),
    h('span', { class: 'item' }, `Remoto ${H.version}`),
  );
}

async function refreshPresence() {
  if (H.status.server.state !== 'online' || H.view !== 'main') return;
  const ids = new Set();
  for (const r of H.config.recent) {
    if (r.target.kind === 'id') ids.add(r.target.id);
    else if (r.hostId) ids.add(r.hostId);
  }
  for (const e of H.config.addressBook) if (e.target.kind === 'id') ids.add(e.target.id);
  if (!ids.size) return;
  const res = await remoto.invoke('presence', [...ids]).catch(() => ({}));
  const changed = Object.entries(res).some(([k, v]) => H.presence[k] !== v);
  H.presence = { ...H.presence, ...res };
  if (changed && H.tab !== 'lan') renderGrid();
}
setInterval(refreshPresence, 20_000);
setTimeout(refreshPresence, 1500);

// ---------------------------------------------------------------- API per le impostazioni

const settingsApi = {
  update: (patch) => remoto.invoke('config:update', patch),
  rerender: () => renderView(),
};

render();
window.addEventListener('focus', () => refreshPresence());
