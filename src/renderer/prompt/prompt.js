// Richiesta di connessione in arrivo: chi è, cosa chiede, quali permessi concedere.
import { h, icon, $, replace } from '../lib/dom.js';
import { bootPage, avatar, playSound } from '../lib/ui.js';
import { PERMISSIONS } from '../../shared/permissions.js';
import { formatId } from '../../shared/ids.js';

await bootPage();
const req = await remoto.invoke('prompt:init');
const perms = { ...req.perms };
const files = req.mode === 'files';
const relevant = files ? PERMISSIONS.filter((p) => ['files', 'clipboard'].includes(p.key)) : PERMISSIONS;
const deadline = Date.now() + req.timeoutMs;
let answered = false;

function answer(accepted) {
  if (answered) return;
  answered = true;
  remoto.send('prompt:answer', { accepted, perms });
}

const permsEl = h('div', { class: 'perms' });
function renderPerms() {
  replace(
    permsEl,
    relevant.map((p) => {
      const disabled = p.key === 'blockInput' && !req.admin;
      return h(
        'button',
        {
          class: `perm ${perms[p.key] && !disabled ? 'on' : ''} ${disabled ? 'disabled' : ''}`,
          title: disabled ? 'Richiede Remoto avviato come amministratore' : p.hint,
          'aria-pressed': String(Boolean(perms[p.key])),
          onClick: () => {
            if (disabled) return;
            perms[p.key] = !perms[p.key];
            renderPerms();
          },
        },
        icon(p.icon),
        h('span', { class: 'grow ellipsis' }, p.label),
        icon(perms[p.key] && !disabled ? 'check' : 'x', 'sm'),
      );
    }),
  );
}
renderPerms();

const timerEl = h('span', { class: 'timer' });
const tick = () => {
  const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  timerEl.textContent = `Rifiuto automatico tra ${left} s`;
};
tick();
setInterval(tick, 500);

const idText = req.viewerId ? `ID ${formatId(req.viewerId)}` : 'ID sconosciuto';
const origin = req.kind === 'direct' ? `${idText} · dalla rete locale (${req.address})` : `${idText} · verificato dal server`;

replace(
  $('#app'),
  h('div', { class: 'titlebar' }, h('div', { class: 'brand-mark' }, icon('logo')), h('strong', null, 'Remoto'), timerEl),
  h(
    'div',
    { class: 'prompt-body' },
    h('div', { class: 'who' }, avatar(req.viewerName, 'lg'), h('div', { class: 'grow' }, h('div', { class: 'n ellipsis' }, req.viewerName), h('div', { class: 'i ellipsis', title: origin }, origin))),
    h('p', { class: 'ask' }, h('strong', null, req.viewerName), files ? ' vuole trasferire file con questo computer.' : ' vuole vedere e controllare questo computer.'),
    req.kind === 'direct' && req.viewerId
      ? h('div', { class: 'warning' }, icon('alert', 'sm'), 'In rete locale l’ID è dichiarato da chi si collega: accetta solo se aspettavi questa richiesta.')
      : null,
    h('div', { class: 'section-label', style: { fontSize: '11.5px', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-3)' } }, 'Permessi da concedere'),
    permsEl,
  ),
  h(
    'div',
    { class: 'prompt-foot' },
    h('button', { class: 'btn', onClick: () => answer(false) }, icon('x', 'sm'), 'Rifiuta'),
    h('button', { class: 'btn primary', onClick: () => answer(true) }, icon('check', 'sm'), 'Accetta'),
  ),
);

// la finestra prende l'altezza del contenuto: i pulsanti restano sempre visibili e cliccabili
requestAnimationFrame(() => {
  const app = $('#app');
  const natural = [...app.children].reduce((sum, el) => sum + (el.classList.contains('prompt-body') ? el.scrollHeight : el.offsetHeight), 0);
  remoto.send('prompt:fit', natural + 2);
});

playSound('ding');
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') answer(false);
});
