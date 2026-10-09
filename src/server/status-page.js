// Pagina di stato minimale servita su "/" (nessuna risorsa esterna).

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderStatusPage({ name, version, online, registered, relayed, startedAt, turn }) {
  const since = new Date(startedAt).toLocaleString('it-IT');
  const row = (label, value) => `<div class="row"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f4f5fb; --card:#fff; --fg:#1b1d2a; --mut:#666a80; --acc:#4f46e5; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1020; --card:#1a1b2e; --fg:#eceefe; --mut:#9a9cb8; --acc:#8b85ff; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg);
         font:15px/1.5 "Segoe UI Variable","Segoe UI",system-ui,sans-serif; }
  .card { background:var(--card); border-radius:16px; padding:28px 32px; width:min(420px, calc(100vw - 32px));
          box-shadow:0 10px 40px rgba(0,0,0,.08); }
  h1 { margin:0 0 4px; font-size:20px; } p { margin:0 0 20px; color:var(--mut); }
  .dot { display:inline-block; width:10px; height:10px; border-radius:50%; background:#22c55e; margin-right:8px; }
  .row { display:flex; justify-content:space-between; padding:10px 0; border-top:1px solid rgba(128,128,128,.18); }
  .row span { color:var(--mut); }
</style></head>
<body><main class="card">
  <h1><span class="dot"></span>${esc(name)}</h1>
  <p>Server ID di Remoto attivo · versione ${esc(version)}</p>
  ${row('Postazioni online', online)}
  ${row('ID registrati', registered)}
  ${row('Messaggi inoltrati', relayed)}
  ${row('TURN', turn ? 'configurato' : 'non configurato')}
  ${row('Attivo dal', since)}
</main></body></html>`;
}
