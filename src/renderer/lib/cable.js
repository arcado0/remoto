// Pulsante "Installa VB-CABLE" (impostazioni e pannello della sessione): il main scarica il pacchetto
// ufficiale, ne verifica la firma e chiede la conferma di amministratore (UAC) a chi è davanti al PC.
import { toast } from './ui.js';

const STEPS = {
  download: 'Download dal sito di VB-Audio…',
  verify: 'Verifica della firma…',
  install: 'Conferma la richiesta di Windows…',
};

export async function installCable(btn, { onDone } = {}) {
  const prev = btn.textContent;
  btn.disabled = true;
  const off = remoto.on('audio:cable-step', (step) => {
    if (STEPS[step]) btn.textContent = STEPS[step];
  });
  try {
    const r = await remoto.invoke('audio:install-cable');
    if (r?.ok) {
      toast({ kind: 'ok', title: 'Cavo audio virtuale installato', text: 'La voce di chi si collega diventa il microfono di questo PC.', timeout: 8000 });
      onDone?.();
    } else if (r?.cancelled) {
      toast({ kind: 'info', title: 'Installazione annullata', text: 'Serve la conferma di amministratore di Windows.' });
    } else {
      toast({
        kind: 'bad',
        title: 'Installazione non riuscita',
        text: r?.error || '',
        timeout: 12000,
        actions: [{ label: 'Apri la pagina di VB-CABLE', onClick: () => remoto.invoke('audio:cable-page') }],
      });
    }
  } catch (err) {
    toast({ kind: 'bad', title: 'Installazione non riuscita', text: String(err?.message || err) });
  } finally {
    off();
    btn.disabled = false;
    btn.textContent = prev;
  }
}
