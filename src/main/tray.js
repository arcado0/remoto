// Icona nell'area di notifica: Remoto resta raggiungibile anche con la finestra chiusa.
import { Tray, Menu, nativeImage } from 'electron';
import { formatId } from '../shared/ids.js';

export function createTray(ctl) {
  let tray;
  try {
    tray = new Tray(nativeImage.createFromPath(ctl.assets.tray));
  } catch (err) {
    ctl.log.warn(`tray non disponibile: ${err.message}`);
    return { update() {}, destroy() {} };
  }
  const update = () => {
    const me = ctl.identity();
    const sessions = ctl.host.list().filter((s) => s.state === 'active' || s.state === 'connecting');
    const allow = ctl.config.get().security.allowIncoming;
    tray.setToolTip(`Remoto · ID ${formatId(me.id)}${sessions.length ? ` · ${sessions.length} sessione/i attiva/e` : ''}`);
    tray.setImage(nativeImage.createFromPath(sessions.length ? ctl.assets.trayActive : ctl.assets.tray));
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `ID ${formatId(me.id)}`, enabled: false },
        { label: 'Apri Remoto', click: () => ctl.showHome() },
        { label: 'Copia ID', click: () => ctl.copyText(me.id) },
        { type: 'separator' },
        ...(sessions.length
          ? [
              ...sessions.map((s) => ({ label: `Disconnetti ${s.viewerName}`, click: () => ctl.host.disconnect(s.id) })),
              { type: 'separator' },
            ]
          : []),
        { label: 'Consenti connessioni in arrivo', type: 'checkbox', checked: allow, click: (item) => ctl.updateConfig({ security: { allowIncoming: item.checked } }) },
        { type: 'separator' },
        { label: 'Esci da Remoto', click: () => ctl.quit() },
      ]),
    );
  };
  // con una richiesta in attesa il clic porta alla richiesta, altrimenti alla finestra principale
  tray.on('click', () => ctl.hostSide.showPrompt() || ctl.showHome());
  update();
  return { update, destroy: () => tray.destroy() };
}
