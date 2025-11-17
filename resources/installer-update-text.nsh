; Custom NSIS installer text to indicate this is an update
; This file is included by electron-builder during NSIS installer creation
; When using electron-updater, this installer is always used for updates

!macro customInit
  ; Set up GUI initialization to customize window title for updates
  !define MUI_CUSTOMFUNCTION_GUIINIT onGUIInit
!macroend

Function onGUIInit
  ; Check if app is already installed (update scenario)
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "UninstallString"
  StrCmp $R0 "" done
  
  ; This is an update - set window title
  SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:Updating DoneThat"
  done:
FunctionEnd

!macro customWelcomePage
  ; Customize welcome page - check at runtime if this is an update
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW onWelcomePageShow
!macroend

Function onWelcomePageShow
  ; Check if this is an update
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "UninstallString"
  StrCmp $R0 "" done
  
  ; Update welcome page text for updates
  FindWindow $R1 "#32770" "" $HWNDPARENT
  GetDlgItem $R2 $R1 1006  ; MUI_WELCOMEPAGE_TITLE control
  SendMessage $R2 ${WM_SETTEXT} 0 "STR:Updating DoneThat"
  
  GetDlgItem $R2 $R1 1020  ; MUI_WELCOMEPAGE_TEXT control
  SendMessage $R2 ${WM_SETTEXT} 0 "STR:This wizard will update DoneThat to the latest version.$\r$\n$\r$\nYour settings and data will be preserved.$\r$\n$\r$\nClick Next to continue."
  done:
FunctionEnd

!macro customFinishPage
  ; Customize finish page for updates
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW onFinishPageShow
!macroend

Function onFinishPageShow
  ; Check if this was an update
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "UninstallString"
  StrCmp $R0 "" done
  
  ; Update finish page text
  FindWindow $R1 "#32770" "" $HWNDPARENT
  GetDlgItem $R2 $R1 1006  ; MUI_FINISHPAGE_TITLE control
  SendMessage $R2 ${WM_SETTEXT} 0 "STR:DoneThat Update Complete"
  
  GetDlgItem $R2 $R1 1020  ; MUI_FINISHPAGE_TEXT control
  SendMessage $R2 ${WM_SETTEXT} 0 "STR:DoneThat has been successfully updated to the latest version.$\r$\n$\r$\nThe application will start automatically."
  done:
FunctionEnd

