# Remoto — specifica di progetto

Data: 2026-10-09 · Stato: approvata implicitamente ("completa dalla A alla Z, con le funzionalità di AnyDesk")

Revisione 2026-10-09 (2ª iterazione, da feedback d'uso): **rimosso del tutto l'accesso non
presidiato e le password** (solo conferma a video, per non dare falsi positivi ad antivirus/VPN);
aggiunta la **scelta del microfono** host/client (con cavo audio virtuale per Teams & co.);
aggiunto un **servizio di sistema facoltativo** per il controllo completo (finestre di
amministratore, UAC, schermata di blocco, Ctrl+Alt+Canc); **portable in .zip** (dati accanto
all'eseguibile) e modalità `--server` senza Node. Le sezioni sotto sono aggiornate di conseguenza.

## 1. Obiettivo

Un'applicazione di desktop remoto in stile AnyDesk, completa e installabile su Windows:
ogni postazione ha un **ID a 9 cifre**, può **controllare** altre postazioni e **farsi
controllare**. Ogni connessione parte **solo con conferma a video** sul PC controllato (niente
accesso non presidiato, niente password memorizzate). Funziona subito in rete locale (senza
server e senza Node) e su Internet tramite un **server ID** self-hosted (standalone, Docker,
oppure integrato nell'app stessa).

## 2. Funzionalità (parità con AnyDesk)

| Area | Funzionalità |
|---|---|
| Identità | ID a 9 cifre generato in locale e registrato sul server con un segreto; alias (nome postazione) |
| Connessione | per ID (via server o LAN), per IP/hostname (connessione diretta), rilevamento automatico in LAN |
| Accesso | **solo con conferma**: finestra Accetta/Rifiuta con permessi; ACL di ID ammessi. Nessun accesso non presidiato né password |
| Schermo | streaming WebRTC P2P (fallback TURN), multi-monitor, qualità Ottimale/Bilanciata/Velocità, codec preferito, adatta/originale, schermo intero, statistiche (FPS, bitrate, RTT, tipo di connessione) |
| Input | mouse (tasti, rotella orizzontale e verticale), tastiera per scancode (layout del remoto), combinazioni speciali (Win, Alt+Tab, Ctrl+Maiusc+Esc, Alt+F4, Win+R, Win+D, Win+E, Stamp, **Ctrl+Alt+Canc** col servizio), "digita il testo degli appunti", sola visualizzazione |
| Audio | audio di sistema del remoto e **microfono di chi si collega** riprodotto sul remoto (scelta del dispositivo di uscita; con cavo audio virtuale le app del remoto lo vedono come microfono) |
| Controllo completo | servizio di sistema facoltativo (LocalSystem + helper di sessione): finestre di amministratore, UAC, schermata di blocco, Ctrl+Alt+Canc; input via servizio e cattura del desktop protetto |
| Appunti | sincronizzazione bidirezionale di testo e immagini |
| File | file manager a due pannelli (locale/remoto), upload e download anche di cartelle, nuova cartella, rinomina, elimina, drag & drop sulla sessione, modalità "Solo trasferimento file" |
| Collaborazione | chat; lavagna (penna ed evidenziatore che sfuma) disegnata sullo schermo del remoto |
| Privacy | modalità privacy (schermo nero per chi sta davanti al PC remoto, invisibile alla cattura); blocco dell'input locale del remoto (richiede amministratore) |
| Sessione | registrazione video (WebM), screenshot (PNG), audio di sistema, riavvio del PC remoto con riconnessione automatica, blocco della sessione Windows al termine |
| Rubrica | sessioni recenti, rubrica con alias e note, stato online, Wake-on-LAN |
| Lato remoto | pannello sessione sempre in primo piano (chi è connesso, permessi modificabili al volo, chat, disconnetti), icona nella tray, registro accessi |
| Sistema | avvio con Windows in tray, tema chiaro/scuro, più profili (per test), installer NSIS + **portable .zip** (dati accanto all'exe), `--server` senza Node |
| Server | registrazione ID, inoltro della segnalazione, presenza, rate limiting, credenziali TURN temporanee, pagina di stato, Docker + coturn |

## 3. Architettura

```
            Postazione A (chi controlla)                     Postazione B (controllata)
  ┌──────────────────────────────────────┐        ┌──────────────────────────────────────┐
  │ Main (Node)                          │        │ Main (Node)                          │
  │  ViewerManager ── Transport ─────────┼─ WS ───┼─ Transport ── HostManager            │
  │  FileService, Clipboard              │ server │  InputInjector (koffi → SendInput)   │
  │                                      │  o LAN │  Privacy/Lavagna overlay, Clipboard  │
  │ Finestra sessione (renderer)         │        │ Engine nascosto (renderer)           │
  │  RTCPeerConnection (answerer) ◄──────┼─ P2P ──┼─► RTCPeerConnection (offerer)        │
  │  <video>, input, file manager, chat  │ DTLS   │  cattura schermo/audio, canali dati  │
  └──────────────────────────────────────┘        └──────────────────────────────────────┘
```

- **Electron 44** (un'unica app che è sia "viewer" sia "host"), **Node** per il server.
- **Media e dati**: WebRTC. La cattura avviene in una finestra *engine* nascosta
  (`getUserMedia` con `chromeMediaSource: 'desktop'`, audio di sistema incluso). Il cambio di
  monitor usa `replaceTrack` (nessuna rinegoziazione); la qualità usa `setParameters`.
- **Canali dati**: `ctrl` (affidabile, ordinato: tasti, click, appunti, chat, comandi),
  `move` (non affidabile, `maxRetransmits: 0`: movimenti del mouse), `file` (affidabile:
  trasferimenti e payload grandi).
- **Segnalazione**: astratta dietro un `Transport` con due implementazioni:
  `RelayTransport` (messaggi inoltrati dal server per ID) e `DirectTransport` (WebSocket
  diretto verso la porta LAN della postazione). Host e viewer non sanno quale stanno usando.
- **Iniezione input** (solo Windows): `SendInput` via koffi, coordinate assolute sul desktop
  virtuale; il processo main è DPI-aware per monitor, quindi pixel fisici ovunque.
- **Controllo completo** (facoltativo): un servizio Windows LocalSystem (`RemotoService.exe`,
  C# .NET 10 self-contained) avvia un *helper* nella sessione interattiva (desktop corrente o
  protetto); l'app vi parla su una named pipe con ACL (`\\.\pipe\remoto-input-<sessione>`,
  framing `[len][tipo][dati]`). Quando il servizio è collegato, `InputInjector` instrada l'input
  lì (supera UAC/finestre elevate) e, su desktop protetto, l'helper cattura via GDI e l'host
  ricostruisce i fotogrammi (JPEG) sostituendo la traccia video con `replaceTrack`.
- **Privacy**: finestre nere a schermo intero con `setContentProtection(true)`
  (WDA_EXCLUDEFROMCAPTURE, verificato: escluse dalla cattura) e click-through.

### Porte predefinite

| Porta | Uso |
|---|---|
| 47800/tcp | server ID (WebSocket, `/ws`; `/health` per il monitoraggio) |
| 47801/tcp | connessioni dirette LAN (WebSocket) |
| 47802/udp | rilevamento LAN (broadcast) |
| 3478 udp/tcp | TURN (coturn, opzionale) |

## 4. Componenti

```
src/shared/     moduli puri usati da main, renderer e server
  ids.js           genera/valida/formatta ID, interpreta "ID o indirizzo"
  protocol.js      versione, porte, limiti, validazione messaggi
  permissions.js   elenco permessi, default, sanificazione
  geometry.js      letterbox del video, normalizzazione, coordinate SendInput
  quality.js       preset di qualità
  ratelimit.js     token bucket e finestre scorrevoli
  transfer.js      framing binario dei chunk, sanificazione percorsi relativi
  format.js        byte, durate, date
src/server/     core.js (embeddable), registry.js, turn.js, cli.js
src/main/       main.js, paths.js, server-mode.js, config.js, logger.js, ipc.js, tray.js
  net/             server-link.js, direct.js, discovery.js, transports.js, wol.js
  sessions/        host-manager.js, viewer-manager.js
  native/          win32.js (koffi), input.js, keymap.js, service-client.js (named pipe)
  features/        clipboard.js, files.js, privacy.js, whiteboard.js, system.js, service-manager.js
  windows/         window-manager.js
src/preload/    bridge.cjs (invoke/send/on; i permessi per ruolo li applica il main)
src/renderer/   home, prompt, panel, session, engine, overlay + lib e css comuni
service/        RemotoService (C# .NET 10): ServiceHost, Helper (pipe), Installer, cattura GDI, SendSAS
```

Le classi di logica (`HostManager`, `ViewerManager`, `FileService`, server, trasporti,
discovery) non importano Electron: ricevono le dipendenze dall'esterno e sono testabili in Node.

## 5. Protocolli

### Client ↔ server (JSON su WebSocket)
- `hello {v, id, secret, name, ver}` → `welcome {id, iceServers}` oppure
  `error {code: bad-hello|id-taken|version|rate-limited}`.
  Primo `hello` con un ID sconosciuto: il server lo registra con `sha256(secret)`; un ID
  già registrato richiede lo stesso segreto (`id-taken` → il client genera un nuovo ID).
- `relay {to, sid, data}` → al destinatario `relay {from, sid, data}`;
  destinatario offline → `relay-fail {to, sid, code}`. Il `from` lo mette il server.
- `query {rid, ids[]}` → `query-result {rid, online{}}`; `ping` → `pong`.

### Peer ↔ peer (dentro `relay.data` oppure `{t:'p', data}` sul WebSocket diretto)
- viewer → host: `req {name, mode: desktop|files, ver}`, `sdp`, `ice`, `bye`
- host → viewer: `pending {name, prompt}`, `accept {perms, name}`, `reject {reason}`,
  `sdp` (offerta), `ice`, `bye`

La connessione parte **solo con conferma**: alla `req` l'host apre una finestra Accetta/Rifiuta.
Nessuno scambio di password/challenge: non esiste accesso non presidiato.

### Canali dati (JSON, tranne i chunk binari)
- `move`: `mm {x,y}` (0..65535)
- viewer → host su `ctrl`: `mb {b,d,x,y}`, `mw {dx,dy,x,y}`, `k {c,d,key}`, `text {s}`,
  `combo {name}` (incluso `ctrl-alt-del`, che richiede il servizio), `release`, `display {id}`,
  `quality {preset}`, `audio {on}`, `clip {kind,data}`, `chat`, `wb {op,...}`, `privacy {on}`,
  `block {on}`, `sys {op: restart|lock}`, `fs {id, op, ...}`
- viewer → host (microfono): l'offerta dell'host contiene un transceiver audio `recvonly`; il
  viewer lo porta a `sendonly` e vi attacca la traccia del proprio microfono (nessuna rinegoziazione)
- host → viewer su `ctrl`: `hello {displays, active, perms, name, os, admin, caps, audio}`,
  `perms`, `caps {fullControl, sas}`, `secure {on}` (desktop protetto attivo/chiuso),
  `displays`, `clip`, `chat`, `mic-status`, `fs-res {id, ok, result|error}`, `notice`
- `file`: `up`/`up-ok`/`up-err` (avvio upload), `fb` (inizio file), chunk binari
  `[xid u32][idx u32][dati]`, `fe` (fine file), `fdone`, `fack`, `fcancel`; percorsi relativi
  sanificati (niente `..`, niente percorsi assoluti), nomi in conflitto rinominati in "nome (1).ext".

## 6. Sicurezza

- Media e dati cifrati end-to-end da WebRTC (DTLS-SRTP); il server vede solo la segnalazione.
- **Solo con conferma**: nessun accesso non presidiato, nessuna password sul disco. Ogni sessione
  richiede un clic di accettazione sul PC controllato (evita anche i falsi positivi di antivirus/VPN).
- Modello di fiducia: server self-hosted e fidato. Un server malevolo potrebbe tentare un
  MITM sulla segnalazione (limite documentato; contromisura futura: impronte DTLS verificate fuori banda).
- Electron: `contextIsolation`, `sandbox`, nessun `nodeIntegration`, CSP restrittiva,
  navigazione e nuove finestre bloccate, ogni canale IPC ammesso solo per il ruolo della finestra.
- In LAN l'ID dichiarato non è verificabile: ACL e registro lo riportano come "dichiarato".
- Permessi applicati dal main (non dal renderer) e modificabili al volo dal lato remoto.
- **Servizio di controllo completo**: LocalSystem, ma la pipe ha un ACL che ammette solo la sessione
  interattiva; l'helper verifica che il client sia `Remoto.exe` sotto *Programmi* (cartella non
  scrivibile dagli utenti) e nella stessa sessione; i comandi valgono solo durante una connessione
  accettata; la disinstallazione ripristina il criterio `SoftwareSASGeneration`.

## 7. Interfaccia (italiano)

- **Finestra principale**: barra "ID o indirizzo remoto" + Connetti / Trasferisci file;
  scheda "Questa postazione" (ID grande, copia, stato server/LAN, accesso solo con conferma);
  schede Recenti / Rubrica / Rete locale; Impostazioni (Generale, Sicurezza — con *Controllo
  completo*, Rete, Visualizzazione, Audio, Registro accessi, Informazioni).
- **Richiesta in arrivo**: finestra sempre in primo piano con permessi e conto alla rovescia.
- **Pannello sessione (lato remoto)**: chi è connesso, durata, permessi, chat, stato microfono, disconnetti.
- **Finestra sessione (lato chi controlla)**: video a tutta finestra, barra strumenti in alto
  (incluso audio/microfono e Ctrl+Alt+Canc tra i tasti speciali), pannelli laterali Chat e File,
  sovrapposizione statistiche, stati di connessione e avviso di desktop protetto.
- Tema chiaro/scuro con variabili CSS, icone SVG proprie, nessuna risorsa esterna.

## 8. Errori e robustezza

- Riconnessione automatica al server con backoff (1 s → 30 s); stato visibile in UI.
- Timeout: richiesta in attesa 90 s, prompt 60 s, negoziazione WebRTC 30 s.
- `iceConnectionState = failed` → un tentativo di ICE restart, poi chiusura con messaggio.
- Perdita del focus nel viewer → rilascio di tutti i tasti e pulsanti premuti sul remoto.
- Chiusura dell'ultima sessione → privacy, blocco input e lavagna disattivati sempre.
- Trasferimenti: file temporaneo `.part`, rinomina solo a completamento, pulizia su errore.

## 9. Test

- **Unità** (`node --test`, 72): ID, keymap, geometria, rate limit, framing, permessi, config,
  paths/portable, FileService, server (client WebSocket reali), trasporto diretto, HostManager e
  ViewerManager con trasporti finti, **client del servizio** (framing + pipe reale) e instradamento
  dell'injector verso il servizio.
- **End-to-end** (Playwright + Electron, 16): server su porta casuale, due istanze con profili
  separati: connessione con conferma in primo piano, frame video decodificati, chat, file avanti e
  indietro con hash, input (cursore spostato e poi rimesso), microfono del client, cambio permessi,
  privacy, cambio monitor/qualità, riconnessione, IP diretto, solo file, rifiuto, server integrato.
- **Collaudo manuale del servizio** (`test/e2e/dev/service-helper.mjs`): helper in "modalità di
  prova" (utente normale), verifica handshake, iniezione mouse via servizio, cattura e SAS.

## 10. Packaging e distribuzione

- `npm run dist`: compila il servizio C# (`build:service`, serve .NET SDK 10), poi `electron-builder`
  produce l'**installer NSIS** (per macchina, regole firewall, stop/uninstall del servizio) e uno
  script crea lo **zip portatile** da `win-unpacked` (cartella `Remoto` + `Remoto-dati`, niente
  autoestrazione). Il servizio è incluso come `extraResources` (`resources/service/RemotoService.exe`).
- Portable: i dati vanno in `Remoto-dati` accanto all'eseguibile; `Remoto.exe --server` avvia il
  solo server ID (con icona nel tray) senza Node.
- Server: `node src/server/cli.js`, immagine Docker, `server/docker-compose.yml` con coturn,
  esempio Caddy per TLS (`wss://`).

## 11. Limiti noti

- **Senza** il servizio *Controllo completo*: niente Ctrl+Alt+Canc reale né controllo del desktop
  protetto (UAC/blocco); le finestre elevate si controllano solo se Remoto è avviato come amministratore.
- Il servizio emula tastiera/mouse con `SendInput` da SYSTEM, non è un driver HID kernel: copre
  UAC/blocco/finestre elevate, non eventuali protezioni anti-cheat. Richiede la versione installata in Programmi.
- Il microfono del client è visto come microfono dalle app del remoto solo con un cavo audio virtuale installato lì.
- Dopo un riavvio remoto la riconnessione richiede che Windows esegua l'accesso
  (accesso automatico) e che Remoto parta all'avvio.
- Host completo solo su Windows; altrove l'app funziona da viewer (e da host in sola visione).

## 12. Versione 1.1 (9/10/2026): latenza e LAN senza firewall

### Latenza del video

Misure con `test/e2e/dev/latency-probe.mjs` (due istanze sullo stesso PC, riquadro che cambia colore
ogni 100 ms letto dai fotogrammi ricevuti): schermo→video da ~184 ms (p90 223) a ~49 ms (p90 60).

| Causa | Prima | Correzione |
|---|---|---|
| Buffer anti-jitter del ricevitore | 35-60 ms anche in LAN senza jitter | field trial `WebRTC-ForcePlayoutDelay` (ricezione) e `WebRTC-ForceSendPlayoutDelay` (invio, così vale anche con un viewer di versione precedente), `min_ms:0,max_ms:0`, in `src/main/chromium-flags.js` |
| Cattura a 30 fps con Windows Graphics Capture | l'immagine catturata ha ~90 ms | `CAPTURE_FRAMERATE = 60` per tutti i preset (~32 ms); l'encoder usa poi `maxFramerate` del preset |
| Contenuto "detail" (screenshare) in *Bilanciata* | coda di invio (pacer) 15-190 ms con contenuto in movimento | *Bilanciata* usa `motion`; `detail` resta in *Qualità ottimale* |

Note: su Windows Chromium sceglie WGC per lo schermo (DXGI non si inizializza su alcune schede),
WGC consegna fotogrammi vecchi di circa due periodi di cattura; l'opzione
`--webrtc-max-cpu-consumption-percentage` non esiste più. L'input (mouse e tastiera) arriva in < 1 ms.

### Segnalazione UDP in LAN (`src/main/net/lan-udp.js`)

Il TCP diretto richiede che il PC controllato accetti connessioni in entrata; con il Windows Firewall
che blocca Remoto (prompt annullato, rete *Pubblica*) la connessione A→B falliva mentre B→A
funzionava. Ora il viewer prova in parallelo TCP verso ogni indirizzo e, dopo 300 ms (o subito se il
TCP è già fallito), UDP verso la porta del rilevamento (`src/main/net/connect.js`, `firstConnection`).

- B annuncia la presenza in broadcast ogni 2,5 s dalla porta 47802: Windows ammette per 3 s le risposte
  unicast a un broadcast, quindi la porta resta raggiungibile; dopo la prima risposta di B il traffico
  è "di ritorno" per entrambi i firewall.
- Messaggi (JSON, `app:'remoto'`, `sid`): `hi` {v,id,name} ripetuto ogni 200 ms finché arriva `ok`
  {v,id,name} oppure `no` {code:'version'}; `d` {n,data} numerati per verso; `a` {n} conferma cumulativa;
  `k` keepalive ogni 2 s; `x` {why} chiusura. Ritrasmissione dopo 250 ms, rinuncia dopo 10 s senza
  conferma o 15 s senza traffico; alla chiusura si attendono fino a 2 s le conferme dei messaggi in volo
  (così un `reject` arriva prima della chiusura).
- Il trasporto ha `kind: 'direct'` e `verified: false` come il TCP: stesse regole (conferma a video,
  limiti per IP, identità solo dichiarata in LAN). Un `ok` tardivo o di un'altra postazione riceve `x`.
- Le versioni precedenti ignorano i datagrammi `u` (non hanno una porta valida per il rilevamento).
- Se la postazione si vede in LAN ma nessuna strada risponde, il motivo è `lan-blocked`.

### Indirizzi e distribuzione

- `src/main/net/addresses.js`: l'indirizzo mostrato è quello della scheda usata per uscire
  (UDP `connect` senza traffico), poi le schede fisiche, in fondo quelle virtuali.
- Build: electron-builder scrive in `out/`; `scripts/collect-dist.mjs` mette in `dist/` solo lo zip
  portable e l'installer.
