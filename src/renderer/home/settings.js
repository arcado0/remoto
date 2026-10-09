// Impostazioni: Generale, Sicurezza, Rete, Visualizzazione, Registro accessi, Informazioni.
import { h, icon } from '../lib/dom.js';
import { toast, confirmDialog, switchEl } from '../lib/ui.js';
import { PERMISSIONS } from '../../shared/permissions.js';
import { QUALITY_PRESETS, CODECS } from '../../shared/quality.js';
import { formatId, normalizeId } from '../../shared/ids.js';
import { formatDateTime, formatDuration } from '../../shared/format.js';
import { reasonText } from '../../shared/protocol.js';

const SECTIONS = [
  ['general', 'sliders', 'Generale'],
  ['security', 'shield', 'Sicurezza'],
  ['network', 'globe', 'Rete'],
  ['display', 'monitor', 'Visualizzazione'],
  ['audio', 'headphones', 'Audio'],
  ['log', 'list', 'Registro accessi'],
  ['about', 'info', 'Informazioni'],
];

const row = (title, desc, ctl) => h('div', { class: 'set-row' }, h('div', { class: 'txt' }, h('div', { class: 't' }, title), desc && h('div', { class: 'd' }, desc)), h('div', { class: 'ctl' }, ctl));
const group = (label, ...rows) => h('div', { class: 'set-group' }, label && h('span', { class: 'section-label' }, label), h('div', { class: 'set-list' }, ...rows));

function select(value, options, onChange, label) {
  const el = h('select', { class: 'select', 'aria-label': label }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

/** Campo che salva quando perde il focus o con Invio. */
function lazyInput({ value, placeholder = '', onSave, type = 'text', width, validate }) {
  const el = h('input', { class: 'input', type, value, placeholder, spellcheck: 'false', style: width ? { width } : null });
  const save = () => {
    if (el.value === String(value)) return;
    const err = validate?.(el.value);
    if (err) {
      el.classList.add('invalid');
      toast({ kind: 'bad', title: err });
      return;
    }
    el.classList.remove('invalid');
    onSave(el.value);
    value = el.value;
  };
  el.addEventListener('blur', save);
  el.addEventListener('keydown', (e) => e.key === 'Enter' && el.blur());
  return el;
}

const portCheck = (v) => (/^\d+$/.test(v) && +v >= 1024 && +v <= 65535 ? null : 'Porta non valida (1024-65535)');

export function renderSettings({ H, api, onSection }) {
  const nav = h(
    'nav',
    { class: 'settings-nav' },
    SECTIONS.map(([key, ic, label]) => h('button', { class: `nav-item ${H.section === key ? 'active' : ''}`, onClick: () => onSection(key) }, icon(ic), label)),
  );
  const body = h('div', { class: 'settings-body' });
  const builders = { general, security, network, display, audio, log, about };
  (builders[H.section] || general)(body, H, api);
  return [nav, body];
}

// ---------------------------------------------------------------- sezioni

function general(body, H, api) {
  const c = H.config;
  body.append(
    h('h2', null, 'Generale'),
    h('p', { class: 'lead' }, 'Nome della postazione, aspetto e avvio.'),
    group(
      null,
      row('Nome della postazione', 'Lo vede chi si collega e chi ti trova in rete locale.', lazyInput({ value: c.profile.name, onSave: (v) => api.update({ profile: { name: v } }) })),
      row('Tema', null, select(c.general.theme, [['system', 'Come il sistema'], ['light', 'Chiaro'], ['dark', 'Scuro']], (v) => api.update({ general: { theme: v } }), 'Tema')),
      row('Avvia con Windows', 'Parte nascosto nell’area di notifica, pronto a mostrare le richieste di connessione.', switchEl({ checked: c.general.startWithWindows, ariaLabel: 'Avvia con Windows', onChange: (v) => api.update({ general: { startWithWindows: v } }) })),
      row('Chiudi nell’area di notifica', 'Chiudendo la finestra Remoto resta raggiungibile.', switchEl({ checked: c.general.closeToTray, ariaLabel: 'Chiudi nell’area di notifica', onChange: (v) => api.update({ general: { closeToTray: v } }) })),
      row('Suoni', 'Avvisi sonori per richieste, connessioni e messaggi.', switchEl({ checked: c.general.sounds !== false, ariaLabel: 'Suoni', onChange: (v) => api.update({ general: { sounds: v } }) })),
    ),
  );
}

function security(body, H, api) {
  const sec = H.config.security;
  const aclArea = h('textarea', { class: 'input', placeholder: 'Un ID per riga, es. 123 456 789', rows: 4 }, sec.acl.map(formatId).join('\n'));
  aclArea.addEventListener('blur', () => {
    const ids = aclArea.value.split(/[\n,;]+/).map((x) => normalizeId(x)).filter(Boolean);
    const bad = aclArea.value.split(/[\n,;]+/).filter((x) => x.trim() && !normalizeId(x));
    if (bad.length) toast({ kind: 'bad', title: 'ID non validi ignorati', text: bad.join(', ') });
    api.update({ security: { acl: [...new Set(ids)] } });
  });

  body.append(
    h('h2', null, 'Sicurezza'),
    h('p', { class: 'lead' }, 'Chi può collegarsi a questa postazione e cosa può fare.'),
    group(
      'Connessioni in arrivo',
      row('Consenti connessioni in arrivo', 'Se disattivato nessuno può collegarsi a questa postazione.', switchEl({ checked: sec.allowIncoming, ariaLabel: 'Consenti connessioni in arrivo', onChange: (v) => api.update({ security: { allowIncoming: v } }) })),
      row(h('span', { class: 'row' }, icon('shield-check', 'sm'), 'Solo con conferma'), 'Ogni connessione compare in una finestra su questo PC e parte solo se qualcuno la accetta. Remoto non ha accesso non presidiato né password di accesso.', null),
    ),
    h(
      'div',
      { class: 'set-group' },
      h('span', { class: 'section-label' }, 'Permessi predefiniti'),
      h(
        'div',
        { class: 'set-list perm-grid' },
        PERMISSIONS.map((p) =>
          row(
            h('span', { class: 'row' }, icon(p.icon, 'sm'), p.label),
            p.hint,
            switchEl({ checked: sec.permissions[p.key], ariaLabel: p.label, onChange: (v) => api.update({ security: { permissions: { ...sec.permissions, [p.key]: v } } }) }),
          ),
        ),
      ),
    ),
    group(
      'Regole',
      row('Sessioni contemporanee', 'Quante persone possono essere collegate insieme.', select(String(sec.maxSessions), [1, 2, 3, 4, 5, 8, 10].map((n) => [String(n), String(n)]), (v) => api.update({ security: { maxSessions: Number(v) } }), 'Sessioni contemporanee')),
      row('Blocca Windows a fine sessione', 'Quando l’ultima sessione termina viene mostrata la schermata di blocco.', switchEl({ checked: sec.lockOnEnd, ariaLabel: 'Blocca Windows a fine sessione', onChange: (v) => api.update({ security: { lockOnEnd: v } }) })),
      h(
        'div',
        { class: 'set-row stack' },
        h('div', { class: 'txt' }, h('div', { class: 't' }, 'ID autorizzati'), h('div', { class: 'd' }, 'Se l’elenco non è vuoto, solo questi ID possono collegarsi. In rete locale l’ID è dichiarato dal mittente: per una garanzia piena usa il server ID.')),
        aclArea,
      ),
    ),
    controlGroup(H),
  );
}

/** Servizio "controllo completo": permette di controllare finestre di amministratore, UAC e schermata di blocco. */
function controlGroup(H) {
  const fc = H.status?.fullControl || {};
  const desc = h(
    'div',
    { class: 'd' },
    h('p', null, 'Senza questo servizio Remoto controlla le app normali. Con il servizio puoi usare anche le richieste UAC, le finestre di amministratore e la schermata di blocco, e inviare Ctrl+Alt+Canc. Il servizio accetta comandi solo da Remoto installato in “Programmi” e solo durante una connessione che hai accettato.'),
    h('p', { class: 'hint' }, 'Richiede i diritti di amministratore per installarlo (comparirà la richiesta UAC). Alcuni antivirus possono segnalare un servizio che simula tastiera e mouse: è previsto.'),
  );

  let state;
  let action = null;
  if (!fc.supported) state = 'Non disponibile su questo sistema.';
  else if (fc.running) {
    state = fc.connected ? 'Attivo e in uso nella sessione corrente.' : 'Installato e attivo.';
    action = h('button', { class: 'btn sm', onClick: (e) => doService(e, 'uninstall') }, icon('trash', 'sm'), 'Disinstalla');
  } else if (fc.installed) {
    state = 'Installato ma non in esecuzione.';
    action = h('button', { class: 'btn sm', onClick: (e) => doService(e, 'uninstall') }, icon('trash', 'sm'), 'Disinstalla');
  } else if (fc.canInstall) {
    state = 'Non installato.';
    action = h('button', { class: 'btn primary sm', onClick: (e) => doService(e, 'install') }, icon('shield', 'sm'), 'Installa');
  } else {
    state = fc.reason || 'Non installabile in questa versione.';
  }

  return group(
    'Controllo completo (avanzato)',
    h(
      'div',
      { class: 'set-row stack' },
      h('div', { class: 'txt' }, h('div', { class: 't' }, h('span', { class: 'row' }, icon('shield', 'sm'), 'Controllo completo del sistema'), h('div', { class: 'd', style: { marginTop: '2px' } }, state)), desc),
      action && h('div', { class: 'ctl' }, action),
    ),
  );
}

async function doService(ev, verb) {
  const btn = ev.currentTarget;
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = verb === 'install' ? 'Installazione…' : 'Rimozione…';
  try {
    const res = await remoto.invoke(verb === 'install' ? 'service:install' : 'service:uninstall');
    if (res?.ok) toast({ kind: 'ok', title: verb === 'install' ? 'Controllo completo installato' : 'Controllo completo rimosso' });
    else toast({ kind: 'bad', title: 'Operazione non riuscita', text: res?.error || '' });
  } catch (err) {
    toast({ kind: 'bad', title: 'Operazione non riuscita', text: err.message });
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

function network(body, H, api) {
  const n = H.config.network;
  const es = H.config.embeddedServer;
  const s = H.status;
  const stateText = { online: 'Connesso', connecting: 'Connessione…', offline: 'Non raggiungibile', error: 'Errore', disabled: 'Non configurato' }[s.server.state];
  const iceArea = h('textarea', { class: 'input', rows: 5, spellcheck: 'false', style: { fontFamily: 'var(--mono)', fontSize: '12.5px' } }, JSON.stringify(n.iceServers || [], null, 2));
  iceArea.addEventListener('blur', () => {
    try {
      const v = JSON.parse(iceArea.value || '[]');
      if (!Array.isArray(v)) throw new Error('serve un array');
      api.update({ network: { iceServers: v } });
    } catch (err) {
      toast({ kind: 'bad', title: 'JSON non valido', text: err.message });
    }
  });
  body.append(
    h('h2', null, 'Rete'),
    h('p', { class: 'lead' }, 'Come questa postazione trova le altre e si fa trovare.'),
    group(
      'Server ID',
      row(
        'Indirizzo del server',
        h('span', null, 'Serve per collegarsi via Internet con l’ID. Esempi: ', h('span', { class: 'mono' }, 'remoto.miodominio.it'), ', ', h('span', { class: 'mono' }, '192.168.1.5:47800'), ', ', h('span', { class: 'mono' }, 'wss://server/ws')),
        lazyInput({ value: n.serverUrl, placeholder: 'Nessun server (solo LAN)', onSave: (v) => api.update({ network: { serverUrl: v.trim() } }) }),
      ),
      row('Stato', s.server.detail || s.server.url || '', h('span', { class: `badge ${s.server.state === 'online' ? 'ok' : s.server.state === 'disabled' ? '' : 'warn'}` }, stateText)),
    ),
    group(
      'Rete locale',
      row('Connessioni dirette', s.direct.listening ? `In ascolto sulla porta ${s.direct.port}: ci si può collegare a questo PC con il suo indirizzo IP anche senza server.` : s.direct.error || 'Ci si può collegare a questo PC con il suo indirizzo IP anche senza server.', switchEl({ checked: n.direct.enabled, ariaLabel: 'Connessioni dirette', onChange: (v) => api.update({ network: { direct: { enabled: v } } }) })),
      row('Porta per le connessioni dirette', 'TCP; da aprire nel firewall se serve.', lazyInput({ value: String(n.direct.port), width: '120px', validate: portCheck, onSave: (v) => api.update({ network: { direct: { port: Number(v) } } }) })),
      row('Rilevamento in rete locale', 'Mostra questa postazione alle altre della stessa rete (e viceversa).', switchEl({ checked: n.discovery.enabled, ariaLabel: 'Rilevamento in rete locale', onChange: (v) => api.update({ network: { discovery: { enabled: v } } }) })),
      row(
        'Indirizzi di questa postazione',
        'Il primo è quello della rete principale. Le schede virtuali (Hyper-V/WSL, VirtualBox, VPN…) di solito non sono raggiungibili dagli altri PC.',
        h('span', { class: 'mono selectable' }, s.addresses.map((a) => `${a.address}${a.primary ? ' (principale)' : a.virtual ? ` (virtuale: ${a.name})` : ''}`).join(', ') || '—'),
      ),
    ),
    group(
      'Server integrato',
      row('Usa questa postazione come server ID', 'Le altre postazioni possono usarla come server inserendo il suo indirizzo. Serve una porta raggiungibile dall’esterno per l’uso via Internet.', switchEl({ checked: es.enabled, ariaLabel: 'Server integrato', onChange: (v) => api.update({ embeddedServer: { enabled: v } }) })),
      row('Porta del server integrato', s.embedded.running ? `Attivo. Indirizzo da comunicare: ${(s.addresses.filter((a) => !a.virtual).length ? s.addresses.filter((a) => !a.virtual) : s.addresses).map((a) => `${a.address}:${s.embedded.port}`).join(' oppure ')}` : s.embedded.error || 'Non attivo', lazyInput({ value: String(es.port), width: '120px', validate: portCheck, onSave: (v) => api.update({ embeddedServer: { port: Number(v) } }) })),
      es.enabled && s.embedded.running && !n.serverUrl
        ? row('Collega anche questa postazione', 'Imposta questo server come server ID di questa postazione.', h('button', { class: 'btn sm soft', onClick: () => api.update({ network: { serverUrl: `127.0.0.1:${s.embedded.port}` } }) }, 'Usa questo server'))
        : null,
    ),
    group(
      'Avanzate',
      h(
        'div',
        { class: 'set-row stack' },
        h('div', { class: 'txt' }, h('div', { class: 't' }, 'Server ICE aggiuntivi (STUN/TURN)'), h('div', { class: 'd' }, 'Array JSON nel formato WebRTC, es. [{"urls":"turn:turn.esempio.it:3478","username":"u","credential":"p"}]. Il server ID fornisce già STUN e, se configurato, TURN.')),
        iceArea,
      ),
    ),
  );
}

function display(body, H, api) {
  const v = H.config.viewer;
  body.append(
    h('h2', null, 'Visualizzazione'),
    h('p', { class: 'lead' }, 'Valori predefiniti delle sessioni che apri verso altre postazioni.'),
    group(
      null,
      row('Qualità predefinita', 'Modificabile anche durante la sessione.', select(v.quality, Object.entries(QUALITY_PRESETS).map(([k, p]) => [k, p.label]), (x) => api.update({ viewer: { quality: x } }), 'Qualità predefinita')),
      row('Codec video preferito', 'Automatico usa H.264 (accelerato in hardware quando possibile).', select(v.codec, CODECS.map((c) => [c.key, c.label]), (x) => api.update({ viewer: { codec: x } }), 'Codec')),
      row('Adattamento', null, select(v.scaleMode, [['fit', 'Adatta alla finestra'], ['original', 'Dimensione originale']], (x) => api.update({ viewer: { scaleMode: x } }), 'Adattamento')),
      row('Audio del computer remoto', 'Riproduce l’audio della postazione remota.', switchEl({ checked: v.audio, ariaLabel: 'Audio', onChange: (x) => api.update({ viewer: { audio: x } }) })),
      row('Sincronizza gli appunti', 'Copia su un computer, incolla sull’altro.', switchEl({ checked: v.clipboardSync, ariaLabel: 'Appunti', onChange: (x) => api.update({ viewer: { clipboardSync: x } }) })),
      row('Mostra le statistiche', 'FPS, banda, latenza e tipo di collegamento sopra il video.', switchEl({ checked: v.showStats, ariaLabel: 'Statistiche', onChange: (x) => api.update({ viewer: { showStats: x } }) })),
    ),
    group(
      'Scorciatoie nella sessione',
      row('Schermo intero', null, h('span', null, h('kbd', null, 'Ctrl'), ' + ', h('kbd', null, 'Alt'), ' + ', h('kbd', null, 'Maiusc'), ' + ', h('kbd', null, 'F'))),
      row('Sola visualizzazione', null, h('span', null, h('kbd', null, 'Ctrl'), ' + ', h('kbd', null, 'Alt'), ' + ', h('kbd', null, 'Maiusc'), ' + ', h('kbd', null, 'V'))),
      row('Screenshot', null, h('span', null, h('kbd', null, 'Ctrl'), ' + ', h('kbd', null, 'Alt'), ' + ', h('kbd', null, 'Maiusc'), ' + ', h('kbd', null, 'S'))),
    ),
  );
}

/** Cavi audio virtuali riconosciuti (stessa regola dell'engine). */
const VIRTUAL_CABLE = /(CABLE[- ]?(A |B )?Input|VB-Audio|Virtual Audio Cable|Voicemeeter.*(Input|VAIO)|Hi-Fi Cable|Virtual Cable)/i;

async function audio(body, H, api) {
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    /* nessun accesso ai dispositivi */
  }
  const outputs = devices.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'communications');
  const inputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
  const cable = outputs.find((d) => d.deviceId !== 'default' && VIRTUAL_CABLE.test(d.label));
  const a = H.config.audio;
  const v = H.config.viewer;
  const sinkOptions = [
    ['auto', cable ? `Automatico: ${cable.label}` : 'Automatico (cavo audio virtuale, se installato)'],
    ['none', 'Non usare il microfono di chi si collega'],
    ['default', 'Altoparlanti predefiniti (per prova)'],
    ...outputs.filter((d) => d.deviceId !== 'default').map((d) => [d.deviceId, d.label || 'Uscita audio']),
  ];
  body.append(
    h('h2', null, 'Audio'),
    h('p', { class: 'lead' }, 'Audio e microfono delle sessioni, nei due sensi.'),
    group(
      'Quando ti colleghi a un altro PC',
      row('Microfono', 'Per parlare nelle app del PC remoto (Teams, Zoom…) con le cuffie collegate a questo PC. Si cambia anche durante la sessione.', select(v.micDevice || '', [['', 'Microfono del PC remoto (non inviare il mio)'], ...inputs.map((d) => [d.deviceId, d.label || 'Microfono'])], (x) => api.update({ viewer: { micDevice: x, micLabel: inputs.find((d) => d.deviceId === x)?.label || '' } }), 'Microfono')),
      row('Uscita audio', 'Dove ascoltare l’audio del PC remoto.', select(v.speakerDevice || 'default', outputs.map((d) => [d.deviceId, d.label || 'Uscita audio']), (x) => api.update({ viewer: { speakerDevice: x } }), 'Uscita audio')),
    ),
    group(
      'Quando qualcuno si collega a questo PC',
      row('Microfono di chi si collega', 'Dove Remoto riproduce la voce di chi è collegato. Con un cavo audio virtuale le app di questo PC la ricevono come microfono.', select(a.micSink || 'auto', sinkOptions, (x) => api.update({ audio: { micSink: x, micSinkLabel: outputs.find((d) => d.deviceId === x)?.label || '' } }), 'Microfono di chi si collega')),
      row(
        h('span', { class: 'row' }, icon(cable ? 'check' : 'info', 'sm'), cable ? 'Cavo audio virtuale presente' : 'Nessun cavo audio virtuale'),
        cable
          ? h('span', null, `Nelle app di questo PC scegli come microfono il lato "Output" di "${cable.label.replace(/ ?\(.*\)$/, '')}" (con VB-CABLE: "CABLE Output").`)
          : h('span', null, 'Windows non permette a un programma di creare un microfono senza driver: installa una volta un cavo audio virtuale, ad esempio ', h('a', { onClick: () => remoto.invoke('app:open-external', 'https://vb-audio.com/Cable/') }, 'VB-CABLE (gratuito)'), ', poi in Teams scegli "CABLE Output" come microfono.'),
        null,
      ),
    ),
  );
}

async function log(body) {
  const entries = await remoto.invoke('log:get');
  const label = {
    request: ['Richiesta', ''],
    accepted: ['Accettata', 'ok'],
    rejected: ['Rifiutata', 'bad'],
    ended: ['Terminata', ''],
  };
  body.append(
    h('div', { class: 'row', style: { marginBottom: '4px' } }, h('h2', { class: 'grow' }, 'Registro accessi'), entries.length ? h('button', { class: 'btn sm', onClick: async () => {
      if (await confirmDialog({ title: 'Svuotare il registro?', text: 'Le voci verranno eliminate.', confirm: 'Svuota', danger: true })) {
        await remoto.invoke('log:clear');
        body.replaceChildren();
        log(body);
      }
    } }, icon('trash', 'sm'), 'Svuota') : null),
    h('p', { class: 'lead' }, 'Chi ha chiesto di collegarsi a questa postazione e com’è andata.'),
    entries.length
      ? h(
          'div',
          { class: 'set-list' },
          h(
            'table',
            { class: 'log-table' },
            h('thead', null, h('tr', null, ['Data', 'Evento', 'Chi', 'Dettagli'].map((t) => h('th', null, t)))),
            h(
              'tbody',
              null,
              entries.map((e) => {
                const [l, cls] = label[e.event] || [e.event, ''];
                const who = `${e.viewerName || 'Sconosciuto'}${e.viewerId ? ` · ${formatId(e.viewerId)}` : ''}${e.verified === false && e.viewerId ? ' (dichiarato)' : ''}`;
                const det = [e.address && e.kind === 'direct' ? `LAN ${e.address}` : e.kind === 'relay' ? 'via server' : '', e.reason ? reasonText(e.reason).split('. ')[0].replace(/\.$/, '') : '', e.detail ? `[${e.detail}]` : '', e.durationMs ? `durata ${formatDuration(e.durationMs)}` : '', e.mode === 'files' ? 'solo file' : '']
                  .filter(Boolean)
                  .join(' · ');
                return h('tr', null, h('td', { class: 'faint', style: { whiteSpace: 'nowrap' } }, formatDateTime(e.ts)), h('td', null, h('span', { class: `badge ${cls}` }, l)), h('td', null, who), h('td', { class: 'muted' }, det));
              }),
            ),
          ),
        )
      : h('div', { class: 'empty' }, icon('list'), h('h4', null, 'Nessun accesso registrato')),
  );
}

function about(body, H) {
  body.append(
    h('div', { class: 'row', style: { gap: '14px', marginBottom: '18px' } }, h('div', { class: 'brand-mark big' }, icon('logo')), h('div', null, h('h2', null, 'Remoto'), h('p', { class: 'muted' }, `Versione ${H.version} · desktop remoto P2P cifrato`))),
    group(
      null,
      row('ID di questa postazione', null, h('span', { class: 'mono selectable' }, formatId(H.me.id))),
      row('Cartella dei log', 'Utile per diagnosticare problemi di connessione.', h('button', { class: 'btn sm', onClick: () => remoto.invoke('app:open-logs') }, icon('folder', 'sm'), 'Apri')),
    ),
    group(
      'Come funziona',
      h(
        'div',
        { class: 'set-row stack' },
        h(
          'div',
          { class: 'muted', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          h('p', null, 'Schermo, audio, input, file e chat viaggiano direttamente tra le due postazioni (WebRTC), cifrati end-to-end con DTLS-SRTP. Il server ID serve solo a trovarsi e a scambiare i parametri di connessione.'),
          h('p', null, 'Ogni connessione deve essere accettata da chi è davanti al computer: Remoto non prevede accesso non presidiato né password di accesso.'),
          h('p', null, 'Limiti: senza un servizio di sistema Windows non è possibile inviare Ctrl+Alt+Canc né controllare la schermata di blocco o le richieste UAC. Le finestre avviate come amministratore si controllano solo se anche Remoto è avviato come amministratore.'),
        ),
      ),
    ),
  );
}
