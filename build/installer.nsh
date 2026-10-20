; Convite clicável (telao://). O instalador registra o link para quem instalou
; (o próprio app também registra ao abrir). O desinstalador apaga o registro só
; se ele ainda apontar para esta instalação, para não estragar o de uma cópia
; portátil. O comando tem o mesmo formato que o app.setAsDefaultProtocolClient grava.

!macro customInstall
  WriteRegStr HKCU "Software\Classes\telao" "" "URL:telao"
  WriteRegStr HKCU "Software\Classes\telao" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\telao\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  Push $0
  ReadRegStr $0 HKCU "Software\Classes\telao\shell\open\command" ""
  ${If} $0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
    DeleteRegKey HKCU "Software\Classes\telao"
  ${EndIf}
  Pop $0
!macroend
