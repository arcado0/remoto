// Pannello sempre in primo piano sul PC controllato: chi è collegato, permessi modificabili
// al volo, chat e disconnessione (come la finestrella di sessione di AnyDesk).
import { h, icon, $, replace } from '../lib/dom.js';
import { installCable } from '../lib/cable.js';
import { bootPage, avatar, playSound, openMenu } from '../lib/ui.js';
import { PERMISSIONS } from '../../shared/permissions.js';
import { formatId } from '../../shared/ids.js';
import { formatDuration } from '../../shared/format.js';

await bootPage();
const appEl = $('#app');
const P = { sessions: [], chat: [], chatOpen: false, target: null };
const durations = new Map();

const init = await remoto.invoke('panel:init');
P.sessions = init.sessions;
P.chat = init.chat;
P.chatOpen = P.chat.length > 0;

remoto.on('panel:sessions', (list) => {
  P.sessions = list;
  render();
});
remoto.on('panel:chat', (msg) => {
  P.chat.push(msg);
  if (msg.from === 'viewer') {
    P.chatOpen = true;
    playSound('msg');
  }
  render();
});

const CONN = { lan: 'LAN', p2p: 'P2P', relay: 'Relay' };

function sessionBlock(s) {
  const dur = h('span', { class: 'dur' });
  durations.set(s.id, { el: dur, since: s.connectedAt || s.acceptedAt });
  const perms = s.perms || {};
  return h(
    'div',
    { class: 'sess' },
    h(
      'div',
      { class: 'sess-top' },
      avatar(s.viewerName, 'sm'),
      h('div', { class: 'grow', style: { minWidth: 0 } }, h('div', { class: 'n ellipsis' }, s.viewerName), h('div', { class: 'i ellipsis' }, `${s.viewerId ? formatId(s.viewerId) : s.address || ''}${s.connType ? ` · ${CONN[s.connType] || s.connType}` : ''}${s.mode === 'files' ? ' · solo file' : ''}`)),
      s.state === 'active' ? dur : h('span', { class: 'badge warn' }, 'Avvio…'),
    ),
    s.mic?.active
      ? h(
          'div',
          { class: `mic-line ${s.mic.routed ? 'ok' : 'warn'}` },
          icon('mic', 'sm'),
          s.mic.routed ? `Parla nelle app di questo PC tramite ${s.mic.device}` : s.mic.reason === 'no-virtual-device' ? 'Microfono ricevuto, ma manca un cavo audio virtuale' : 'Microfono ricevuto, non usato',
          !s.mic.routed && s.mic.reason === 'no-virtual-device' ? h('button', { class: 'btn sm', style: { marginLeft: 'auto' }, onClick: (e) => installCable(e.currentTarget) }, 'Installa') : null,
        )
      : null,
    s.audio?.speakersMuted || s.audio?.micRedirected
      ? h(
          'div',
          { class: 'mic-line ok' },
          icon('headphones', 'sm'),
          `${[s.audio.speakersMuted ? 'Casse silenziate' : '', s.audio.micRedirected ? `microfono: ${s.audio.micDevice}` : ''].filter(Boolean).join(' · ')} fino a fine sessione`,
        )
      : null,
    h(
      'div',
      { class: 'perm-bar' },
      PERMISSIONS.filter((p) => s.mode !== 'files' || ['files', 'clipboard'].includes(p.key)).map((p) =>
        h('button', {
          class: `icon-btn ${perms[p.key] ? 'on' : 'off'}`,
          'data-tip': `${p.label}: ${perms[p.key] ? 'consentito' : 'negato'}`,
          'aria-pressed': String(Boolean(perms[p.key])),
          onClick: () => remoto.send('panel:perms', s.id, { ...perms, [p.key]: !perms[p.key] }),
        }, icon(p.icon, 'sm')),
      ),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn danger sm', onClick: () => remoto.send('panel:disconnect', s.id) }, icon('plug', 'sm'), 'Disconnetti'),
    ),
  );
}

function chatBlock() {
  const target = P.sessions.find((s) => s.id === P.target) || P.sessions[0];
  if (!target) return null;
  P.target = target.id;
  const list = h(
    'div',
    { class: 'chat-list' },
    P.chat.length
      ? P.chat.map((m) => {
          const s = P.sessions.find((x) => x.id === m.id);
          return h('div', { class: `bubble ${m.from === 'me' ? 'me' : ''}` }, m.from !== 'me' && P.sessions.length > 1 ? h('span', { class: 'who' }, s?.viewerName || '') : null, m.text);
        })
      : h('div', { class: 'faint', style: { fontSize: '12.5px', textAlign: 'center', padding: '8px' } }, 'Scrivi un messaggio a chi è collegato'),
  );
  const input = h('input', { class: 'input', placeholder: P.sessions.length > 1 ? `Messaggio a ${target.viewerName}…` : 'Scrivi un messaggio…', maxlength: 4000 });
  const form = h('form', { class: 'chat-form', onSubmit: (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    remoto.send('panel:chat', P.target, input.value);
    input.value = '';
  } }, input, h('button', { class: 'btn primary sm', type: 'submit', 'aria-label': 'Invia' }, icon('send', 'sm')));
  setTimeout(() => (list.scrollTop = list.scrollHeight));
  return h('div', { class: 'chat' }, list, form);
}

function render() {
  durations.clear();
  const live = P.sessions.filter((s) => s.state === 'active').length;
  replace(
    appEl,
    h(
      'div',
      { class: 'titlebar' },
      h('span', { class: 'live' }, h('span', { class: `dot ${live ? 'ok pulse' : 'warn'}` }), live ? (P.sessions.length > 1 ? `${P.sessions.length} sessioni attive` : 'Sessione remota attiva') : 'Avvio della sessione…'),
      h('div', { class: 'spacer' }),
      h('button', { class: `icon-btn ${P.chatOpen ? 'active' : ''}`, 'data-tip': 'Chat', 'aria-label': 'Chat', onClick: () => {
        P.chatOpen = !P.chatOpen;
        render();
      } }, icon('chat', 'sm')),
      P.sessions.length > 1 && P.chatOpen
        ? h('button', { class: 'icon-btn', 'data-tip': 'Destinatario della chat', onClick: (e) => openMenu(e.currentTarget, P.sessions.map((s) => ({ label: s.viewerName, checked: s.id === P.target, onClick: () => {
            P.target = s.id;
            render();
          } })), { align: 'right' }) }, icon('users', 'sm'))
        : null,
      h('button', { class: 'icon-btn', 'data-tip': 'Apri Remoto', 'aria-label': 'Apri Remoto', onClick: () => remoto.send('panel:open-home') }, icon('home', 'sm')),
      h('button', { class: 'icon-btn', 'data-tip': 'Riduci', 'aria-label': 'Riduci', onClick: () => remoto.send('panel:minimize') }, icon('minus', 'sm')),
    ),
    ...P.sessions.map(sessionBlock),
    P.chatOpen ? chatBlock() : null,
  );
  tickDurations();
  requestAnimationFrame(() => remoto.send('panel:resize', appEl.scrollHeight + 2));
}

function tickDurations() {
  for (const { el, since } of durations.values()) el.textContent = since ? formatDuration(Date.now() - since) : '';
}
setInterval(tickDurations, 1000);
render();
