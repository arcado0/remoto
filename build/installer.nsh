; Regole del Windows Firewall per Remoto: connessioni dirette in LAN (TCP 47801),
; rilevamento (UDP 47802), server integrato (TCP 47800) e media WebRTC (UDP del programma).
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Remoto"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Remoto" dir=in action=allow program="$INSTDIR\Remoto.exe" enable=yes profile=any'
!macroend

; Prima di sovrascrivere i file: se il servizio "controllo completo" è installato va fermato,
; altrimenti l'eseguibile è in uso e l'aggiornamento fallisce. Lo si ferma soltanto (senza rimuoverlo):
; al successivo utilizzo riparte, già aggiornato.
!macro customInit
  nsExec::Exec 'sc stop RemotoService'
!macroend

; Alla disinstallazione il servizio va rimosso del tutto (ripristina anche il criterio Ctrl+Alt+Canc).
!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Remoto"'
  nsExec::ExecToLog '"$INSTDIR\resources\service\RemotoService.exe" uninstall'
!macroend
