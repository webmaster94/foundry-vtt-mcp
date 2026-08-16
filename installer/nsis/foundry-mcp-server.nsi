; Foundry VTT MCP Bridge - guarded per-user Windows installer

Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "Sections.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "0.0.0.0"
!endif
!ifndef ESTIMATED_SIZE_KB
  !define ESTIMATED_SIZE_KB 1
!endif
!ifndef OUTFILE
  !define OUTFILE "FoundryVTT-MCP-Bridge-Setup.exe"
!endif

!define PRODUCT_NAME "Foundry VTT MCP Bridge"
!define PRODUCT_EXE "FoundryVTT MCP Bridge.exe"
!define PRODUCT_PUBLISHER "webmaster94"
!define PRODUCT_URL "https://github.com/webmaster94/foundry-vtt-mcp"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryMCPServer"
!define START_MENU_FOLDER "Foundry VTT MCP Bridge"
!define LEGACY_START_MENU_FOLDER "Foundry MCP Server"
!define STAGE_DIR "${__FILEDIR__}\..\build\installer-files"

Name "${PRODUCT_NAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\Foundry VTT MCP Bridge"
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${PRODUCT_VERSION}"
VIAddVersionKey "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey "CompanyName" "${PRODUCT_PUBLISHER}"
VIAddVersionKey "FileDescription" "${PRODUCT_NAME} Setup"
VIAddVersionKey "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "MIT licensed; Foundry VTT trademarks belong to Foundry Gaming LLC"

!define MUI_ABORTWARNING
!define MUI_ICON "${STAGE_DIR}\icon.ico"
!define MUI_UNICON "${STAGE_DIR}\icon.ico"
!define MUI_FINISHPAGE_TITLE "${PRODUCT_NAME} is ready"
!define MUI_FINISHPAGE_TEXT "The bridge can stay in the notification area and keep its backend available to MCP clients. Your server profiles are stored separately from the application and survive upgrades and uninstall."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${PRODUCT_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Open ${PRODUCT_NAME}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${STAGE_DIR}\LICENSE.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Var FoundryPath
Var FoundryDataPath
Var PreviousInstallDir
Var UpgradeFromLegacy
Var CanonicalConfigPath
Var MigrationStatePath
Var ClientConfigMigrationSafe
Var un.FoundryPath
Var un.FoundryDataPath
Var un.CanonicalConfigPath

Function .onInit
  StrCpy $CanonicalConfigPath "$APPDATA\FoundryVTT MCP Bridge\foundry-servers.json"
  StrCpy $UpgradeFromLegacy "0"

  ; Remember the exact previous location before this release writes the same
  ; legacy uninstall key. Never execute the old uninstaller.
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "DisplayName"
  StrCmp $0 "Foundry MCP Server" legacy_registration
  StrCmp $0 "${PRODUCT_NAME}" registration_recognized registration_missing

  legacy_registration:
  StrCpy $UpgradeFromLegacy "1"

  registration_recognized:
  ReadRegStr $PreviousInstallDir HKCU "${UNINSTALL_KEY}" "InstallLocation"
  StrCmp $PreviousInstallDir "" derive_previous_location previous_location_ready

  derive_previous_location:
  ReadRegStr $1 HKCU "${UNINSTALL_KEY}" "UninstallString"
  StrCmp $1 "" registration_missing
  StrCpy $2 $1 1
  StrCmp $2 "$\"" 0 previous_command_unquoted
  StrCpy $1 $1 "" 1
  StrLen $2 $1
  IntOp $2 $2 - 1
  StrCpy $1 $1 $2

  previous_command_unquoted:
  ${GetParent} "$1" $PreviousInstallDir

  previous_location_ready:
  GetFullPathName $PreviousInstallDir "$PreviousInstallDir"
  ; Do not let InstallDirRegKey strand a legacy product in its old ad-hoc
  ; folder. Current-product upgrades retain the user's selected location.
  StrCmp $UpgradeFromLegacy "1" 0 previous_location_found
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Foundry VTT MCP Bridge"
  Goto previous_location_found

  registration_missing:
  StrCpy $PreviousInstallDir "$LOCALAPPDATA\FoundryMCPServer"
  IfFileExists "$PreviousInstallDir\node.exe" 0 try_current_default
  IfFileExists "$PreviousInstallDir\Uninstall.exe" 0 try_current_default
  IfFileExists "$PreviousInstallDir\foundry-mcp-server\packages\mcp-server\dist\index.cjs" previous_location_found try_current_default

  try_current_default:
  StrCpy $PreviousInstallDir "$LOCALAPPDATA\Programs\Foundry VTT MCP Bridge"
  IfFileExists "$PreviousInstallDir\foundry-vtt-mcp-bridge.install-id" previous_location_found no_previous_location

  no_previous_location:
  StrCpy $PreviousInstallDir ""

  previous_location_found:
FunctionEnd

Function ExtractInstallerHelpers
  InitPluginsDir
  File /oname=$PLUGINSDIR\stop-bridge.ps1 "${STAGE_DIR}\payload\resources\installer\stop-bridge.ps1"
  File /oname=$PLUGINSDIR\install-migration.ps1 "${STAGE_DIR}\payload\resources\installer\install-migration.ps1"
  File /oname=$PLUGINSDIR\foundry-module-cleanup.ps1 "${STAGE_DIR}\payload\resources\installer\foundry-module-cleanup.ps1"
FunctionEnd

Function StopPreviousBridge
  StrCmp $PreviousInstallDir "" stop_complete

  stop_retry:
  ; The legacy escape hatch is accepted only after the full legacy ownership
  ; fingerprint is present. The helper itself verifies current backend paths.
  StrCpy $3 ""
  IfFileExists "$PreviousInstallDir\node.exe" 0 stop_current_identity
  IfFileExists "$PreviousInstallDir\Uninstall.exe" 0 stop_current_identity
  IfFileExists "$PreviousInstallDir\foundry-mcp-server\packages\mcp-server\dist\index.cjs" 0 stop_current_identity
  StrCpy $3 "-AllowLegacyIdentity"

  stop_current_identity:
  nsExec::ExecToStack 'powershell.exe -InputFormat None -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-bridge.ps1" -InstallDir "$PreviousInstallDir" $3'
  Pop $0
  Pop $1
  StrCmp $0 "0" stop_complete
  DetailPrint "$1"
  MessageBox MB_RETRYCANCEL|MB_ICONSTOP|MB_DEFBUTTON2 "${PRODUCT_NAME} could not be stopped safely.$\r$\n$\r$\nClose the bridge from its notification-area menu, then retry. Setup will not replace running files or terminate unrelated Node.js processes." /SD IDCANCEL IDRETRY stop_retry IDCANCEL stop_cancel

  stop_cancel:
  Abort

  stop_complete:
FunctionEnd

Function RunMigrationPrepare
  StrCpy $MigrationStatePath "$PLUGINSDIR\foundry-mcp-migration-state.json"
  nsExec::ExecToStack 'powershell.exe -InputFormat None -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\install-migration.ps1" -Phase Prepare -NewInstallDir "$INSTDIR" -CanonicalConfigPath "$CanonicalConfigPath" -PreviousInstallDir "$PreviousInstallDir" -StateFile "$MigrationStatePath"'
  Pop $0
  Pop $1
  StrCmp $0 "0" migration_prepare_done
  DetailPrint "$1"
  MessageBox MB_ICONSTOP "Setup refused the selected location or could not preserve the server profile configuration.$\r$\n$\r$\n$1" /SD IDOK
  Abort

  migration_prepare_done:
FunctionEnd

Function RunMigrationFinalize
  StrCmp $ClientConfigMigrationSafe "1" 0 migration_finalize_skipped
  nsExec::ExecToStack 'powershell.exe -InputFormat None -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\installer\install-migration.ps1" -Phase Finalize -NewInstallDir "$INSTDIR" -CanonicalConfigPath "$CanonicalConfigPath" -StateFile "$MigrationStatePath"'
  Pop $0
  Pop $1
  StrCmp $0 "0" migration_finalize_done
  DetailPrint "$1"
  MessageBox MB_ICONSTOP "The new bridge was installed, but guarded cleanup of the previous installation could not finish.$\r$\n$\r$\nNo unknown files were removed.$\r$\n$\r$\n$1" /SD IDOK
  Abort

  migration_finalize_done:
  Return

  migration_finalize_skipped:
  DetailPrint "Previous bridge payload was preserved because an owned MCP client registration could not be migrated safely."
FunctionEnd

Function UpdateClaudeConfig
  StrCpy $ClientConfigMigrationSafe "1"
  DetailPrint "Registering the MCP wrapper with Claude Desktop and Claude Code..."
  nsExec::ExecToStack 'powershell.exe -InputFormat None -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\installer\configure-claude.ps1" -InstallDir "$INSTDIR"'
  Pop $0
  Pop $1
  StrCmp $0 "0" claude_config_done

  DetailPrint "Direct configuration failed; trying the installed wrapper."
  nsExec::ExecToStack '"$INSTDIR\resources\installer\configure-claude-wrapper.bat" "$INSTDIR"'
  Pop $0
  Pop $1
  StrCmp $0 "0" claude_config_done claude_config_failed

  claude_config_failed:
  DetailPrint "$1"
  StrCpy $ClientConfigMigrationSafe "0"

  claude_config_done:
  DetailPrint "Migrating the owned Codex MCP registration..."
  IfFileExists "$INSTDIR\runtime\node.exe" 0 codex_config_failed
  IfFileExists "$INSTDIR\resources\installer\configure-codex.mjs" 0 codex_config_failed
  nsExec::ExecToStack '"$INSTDIR\runtime\node.exe" "$INSTDIR\resources\installer\configure-codex.mjs" --install-dir "$INSTDIR"'
  Pop $0
  Pop $1
  StrCmp $0 "0" client_config_checked
  DetailPrint "$1"

  codex_config_failed:
  StrCpy $ClientConfigMigrationSafe "0"

  client_config_checked:
  StrCmp $ClientConfigMigrationSafe "1" config_done
  MessageBox MB_ICONEXCLAMATION "One or more MCP client registrations could not be migrated automatically. Existing unrelated entries were left unchanged, and the previous bridge payload was preserved so no owned registration points to a deleted executable.$\r$\n$\r$\nSee the project documentation for manual client setup, then remove the previous installation after confirming your clients use the new path." /SD IDOK

  config_done:
FunctionEnd

Function CleanFoundryModulePayload
  StrCpy $7 "0"
  nsExec::ExecToStack 'powershell.exe -InputFormat None -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\foundry-module-cleanup.ps1" -ModuleRoot "$FoundryPath\foundry-mcp-bridge" -Mode Replace'
  Pop $0
  Pop $1
  StrCmp $0 "0" module_cleanup_done
  DetailPrint "$1"
  MessageBox MB_ICONEXCLAMATION "The previous Foundry module payload contains a linked, reparsed, or unexpected owned path. Module replacement was skipped before deleting any module code.$\r$\n$\r$\n$1" /SD IDOK
  Return

  module_cleanup_done:
  StrCpy $7 "1"
FunctionEnd

Function ValidateFoundryModulesPath
  StrCpy $FoundryDataPath ""
  StrCmp $FoundryPath "" invalid_foundry_path
  GetFullPathName $FoundryPath "$FoundryPath"
  IfFileExists "$FoundryPath\." 0 invalid_foundry_path

  ${GetFileName} "$FoundryPath" $0
  StrCmp $0 "modules" 0 invalid_foundry_path
  ${GetParent} "$FoundryPath" $FoundryDataPath
  StrCmp $FoundryDataPath "" invalid_foundry_path
  GetFullPathName $3 "$FoundryDataPath\.."
  StrCmp $3 $FoundryDataPath invalid_foundry_path
  IfFileExists "$FoundryDataPath\modules\." 0 invalid_foundry_path
  GetFullPathName $1 "$FoundryDataPath\modules"
  StrCmp $1 $FoundryPath valid_foundry_path invalid_foundry_path

  invalid_foundry_path:
  StrCpy $FoundryPath ""
  StrCpy $FoundryDataPath ""

  valid_foundry_path:
FunctionEnd

Function DetectFoundryInstallation
  ReadRegStr $FoundryPath HKCU "${UNINSTALL_KEY}" "FoundryModulesPath"
  ReadRegStr $2 HKCU "${UNINSTALL_KEY}" "FoundryDataPath"
  Call ValidateFoundryModulesPath
  StrCmp $FoundryPath "" persisted_path_invalid
  StrCmp $2 "" persisted_path_invalid
  GetFullPathName $2 "$2"
  StrCmp $2 $FoundryDataPath foundry_found

  persisted_path_invalid:
  StrCpy $FoundryPath ""
  StrCpy $FoundryDataPath ""
  StrCpy $FoundryPath "$LOCALAPPDATA\FoundryVTT_Next\Data\modules"
  Call ValidateFoundryModulesPath
  StrCmp $FoundryPath "" 0 foundry_found
  StrCpy $FoundryPath "$APPDATA\FoundryVTT_Next\Data\modules"
  Call ValidateFoundryModulesPath
  StrCmp $FoundryPath "" 0 foundry_found
  StrCpy $FoundryPath "$LOCALAPPDATA\FoundryVTT\Data\modules"
  Call ValidateFoundryModulesPath
  StrCmp $FoundryPath "" 0 foundry_found
  StrCpy $FoundryPath "$APPDATA\FoundryVTT\Data\modules"
  Call ValidateFoundryModulesPath
  StrCmp $FoundryPath "" 0 foundry_found

  ReadEnvStr $2 "FOUNDRY_VTT_DATA_PATH"
  StrCmp $2 "" browse_for_foundry
  StrCpy $FoundryPath "$2\modules"
  Call ValidateFoundryModulesPath
  StrCmp $FoundryPath "" 0 foundry_found
  StrCpy $FoundryPath "$2\Data\modules"
  Call ValidateFoundryModulesPath
  StrCmp $FoundryPath "" 0 foundry_found

  browse_for_foundry:
  MessageBox MB_YESNO "Foundry VTT was not detected automatically.$\r$\n$\r$\nBrowse for the Foundry User Data folder?" /SD IDNO IDYES select_foundry_folder IDNO skip_module
  select_foundry_folder:
  nsDialogs::SelectFolderDialog "Select Foundry VTT User Data Folder" "$LOCALAPPDATA"
  Pop $2
  StrCmp $2 "CANCEL" skip_module
  StrCpy $FoundryPath "$2\modules"
  Call ValidateFoundryModulesPath
  StrCmp $FoundryPath "" 0 foundry_found
  StrCpy $FoundryPath "$2\Data\modules"
  Call ValidateFoundryModulesPath
  StrCmp $FoundryPath "" 0 foundry_found
  StrCpy $FoundryPath "$2"
  Call ValidateFoundryModulesPath
  StrCmp $FoundryPath "" 0 foundry_found
  MessageBox MB_ICONSTOP "The selected folder does not contain a Foundry VTT modules directory. Module installation will be skipped." /SD IDOK

  skip_module:
  StrCpy $FoundryPath ""
  StrCpy $FoundryDataPath ""
  Return

  foundry_found:
  DetailPrint "Foundry VTT data directory: $FoundryDataPath"
  DetailPrint "Foundry VTT modules directory: $FoundryPath"
FunctionEnd

Function RemoveLegacyCreatureIndexCaches
  Call ValidateFoundryModulesPath
  StrCmp $FoundryDataPath "" cleanup_done
  IfFileExists "$FoundryDataPath\worlds\." 0 cleanup_done
  FindFirst $0 $1 "$FoundryDataPath\worlds\*"
  cleanup_loop:
  StrCmp $1 "" cleanup_close
  StrCmp $1 "." cleanup_next
  StrCmp $1 ".." cleanup_next
  IfFileExists "$FoundryDataPath\worlds\$1\." 0 cleanup_next
  StrCpy $3 "$FoundryDataPath\worlds\$1"
  System::Call 'kernel32::GetFileAttributes(t r3) i .r2'
  IntOp $2 $2 & 0x400
  IntCmp $2 0 0 cleanup_next cleanup_next
  Delete "$FoundryDataPath\worlds\$1\enhanced-creature-index.json"
  IfErrors 0 cleanup_removed
  DetailPrint "Could not remove the retired cache from world '$1'; leaving it unchanged."
  Goto cleanup_next
  cleanup_removed:
  DetailPrint "Removed retired Enhanced Creature Index cache from world '$1'."
  cleanup_next:
  FindNext $0 $1
  Goto cleanup_loop
  cleanup_close:
  FindClose $0
  cleanup_done:
FunctionEnd

Function IsFoundryModuleTargetSafe
  StrCpy $4 "$FoundryPath\foundry-mcp-bridge"
  System::Call 'kernel32::GetFileAttributes(t r4) i .r5'
  IntCmp $5 -1 module_target_safe module_target_unsafe module_target_attributes
  module_target_attributes:
  IntOp $6 $5 & 0x400
  IntCmp $6 0 0 module_target_unsafe module_target_unsafe
  IntOp $6 $5 & 0x10
  IntCmp $6 0 module_target_unsafe module_target_unsafe module_target_safe
  module_target_safe:
  StrCpy $6 "1"
  Return
  module_target_unsafe:
  StrCpy $6 "0"
FunctionEnd

Section "${PRODUCT_NAME}" SecMain
  SectionIn RO
  SectionSetSize ${SecMain} ${ESTIMATED_SIZE_KB}
  StrCpy $CanonicalConfigPath "$APPDATA\FoundryVTT MCP Bridge\foundry-servers.json"
  Call ExtractInstallerHelpers
  Call StopPreviousBridge
  Call RunMigrationPrepare

  SetOutPath "$INSTDIR"
  SetOverwrite on
  File /r "${STAGE_DIR}\payload\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  SetShellVarContext current
  Delete "$SMPROGRAMS\${LEGACY_START_MENU_FOLDER}\Uninstall.lnk"
  RMDir "$SMPROGRAMS\${LEGACY_START_MENU_FOLDER}"
  CreateDirectory "$SMPROGRAMS\${START_MENU_FOLDER}"
  CreateShortcut "$SMPROGRAMS\${START_MENU_FOLDER}\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_EXE}" "" "$INSTDIR\${PRODUCT_EXE}" 0
  CreateShortcut "$SMPROGRAMS\${START_MENU_FOLDER}\Uninstall ${PRODUCT_NAME}.lnk" "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" "$\"$INSTDIR\Uninstall.exe$\""
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" "$\"$INSTDIR\Uninstall.exe$\" /S"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$\"$INSTDIR\${PRODUCT_EXE}$\",0"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "URLInfoAbout" "${PRODUCT_URL}"
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" ${ESTIMATED_SIZE_KB}
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1

  Call UpdateClaudeConfig
  Call RunMigrationFinalize
SectionEnd

Section "Foundry VTT module (recommended)" SecFoundryModule
  SectionSetSize ${SecFoundryModule} 5120
  Call DetectFoundryInstallation
  StrCmp $FoundryPath "" module_done
  Call IsFoundryModuleTargetSafe
  StrCmp $6 "1" 0 unsafe_module_target
  Call CleanFoundryModulePayload
  StrCmp $7 "1" 0 module_done

  WriteRegStr HKCU "${UNINSTALL_KEY}" "FoundryDataPath" "$FoundryDataPath"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "FoundryModulesPath" "$FoundryPath"
  Call RemoveLegacyCreatureIndexCaches
  CreateDirectory "$FoundryPath\foundry-mcp-bridge"
  SetOutPath "$FoundryPath\foundry-mcp-bridge"
  SetOverwrite on
  File /r "${STAGE_DIR}\foundry-module\*"
  DetailPrint "Foundry MCP Bridge installed to $FoundryPath\foundry-mcp-bridge"
  Goto module_done

  unsafe_module_target:
  DetailPrint "Refusing to replace a reparse-point or non-directory module target."
  MessageBox MB_ICONEXCLAMATION "The Foundry MCP Bridge module target is a symlink, junction, reparse point, or non-directory. Module installation was skipped to protect target data." /SD IDOK
  module_done:
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} "Desktop dashboard, notification-area host, persistent backend, MCP wrapper, and guarded profile migration (required)."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecFoundryModule} "Foundry VTT bridge module. Existing generated maps and other user-created module content are preserved."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  StrCpy $un.CanonicalConfigPath "$APPDATA\FoundryVTT MCP Bridge\foundry-servers.json"
  Call un.StopInstalledBridge

  ; Client cleanup must finish before any shortcuts, registration, module code,
  ; or executable payload is removed. Otherwise a CAS, permission, or reparse
  ; refusal could leave an owned MCP entry pointing at a deleted wrapper.
  MessageBox MB_YESNO|MB_ICONQUESTION "Remove this installer's bridge entries from Claude Desktop, Claude Code, and Codex before uninstalling?$\r$\n$\r$\nUnrelated and unowned MCP entries are always preserved. Choosing No cancels uninstall so no registered runtime is orphaned." /SD IDYES IDYES client_config_cleanup_retry IDNO client_config_cleanup_abort

  client_config_cleanup_abort:
  DetailPrint "Uninstall cancelled before removing application files because MCP client cleanup was not confirmed."
  SetErrorLevel 2
  ; Abort keeps the interactive uninstaller open, but NSIS normalizes its
  ; silent process exit to zero. Quit preserves the explicit failure code.
  IfSilent client_config_cleanup_quit
  Abort

  client_config_cleanup_quit:
  Quit

  client_config_cleanup_retry:
  Call un.RemoveClaudeConfig
  StrCmp $2 "0" client_config_cleanup_done
  MessageBox MB_RETRYCANCEL|MB_ICONSTOP|MB_DEFBUTTON2 "MCP client cleanup could not finish. The installed wrapper and application payload remain in place so no owned registration points to a deleted executable.$\r$\n$\r$\nClose the affected MCP clients or correct the reported configuration-file problem, then retry." /SD IDCANCEL IDRETRY client_config_cleanup_retry IDCANCEL client_config_cleanup_abort

  client_config_cleanup_done:
  Call un.DetectFoundryInstallation
  StrCmp $un.FoundryPath "" skip_legacy_cache_removal
  Call un.RemoveLegacyCreatureIndexCaches

  skip_legacy_cache_removal:
  MessageBox MB_YESNO "Remove the Foundry MCP Bridge module code from Foundry VTT?$\r$\n$\r$\nGenerated maps, unknown files, and other user-created content remain in place." /SD IDNO IDYES remove_module IDNO skip_module_removal
  remove_module:
  StrCmp $un.FoundryPath "" skip_module_removal
  Call un.IsFoundryModuleTargetSafe
  StrCmp $6 "1" 0 unsafe_uninstall_module_target
  Call un.CleanFoundryModulePayload
  Goto skip_module_removal
  unsafe_uninstall_module_target:
  MessageBox MB_ICONEXCLAMATION "The Foundry MCP Bridge module target is a symlink, junction, reparse point, or non-directory. Module removal was skipped to protect target data." /SD IDOK

  skip_module_removal:
  SetShellVarContext current
  Delete "$SMPROGRAMS\${START_MENU_FOLDER}\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\${START_MENU_FOLDER}\Uninstall ${PRODUCT_NAME}.lnk"
  RMDir "$SMPROGRAMS\${START_MENU_FOLDER}"
  Delete "$SMPROGRAMS\${LEGACY_START_MENU_FOLDER}\Uninstall.lnk"
  RMDir "$SMPROGRAMS\${LEGACY_START_MENU_FOLDER}"

  Call un.RemoveOwnedPayload
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR\resources\installer"
  RMDir "$INSTDIR\resources\server"
  RMDir "$INSTDIR\resources"
  RMDir "$INSTDIR\runtime"
  RMDir "$INSTDIR"
  DetailPrint "Application settings were preserved at $un.CanonicalConfigPath"
SectionEnd

Function un.StopInstalledBridge
  IfFileExists "$INSTDIR\resources\installer\stop-bridge.ps1" 0 stop_helper_missing
  stop_retry:
  nsExec::ExecToStack 'powershell.exe -InputFormat None -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\installer\stop-bridge.ps1" -InstallDir "$INSTDIR"'
  Pop $0
  Pop $1
  StrCmp $0 "0" stop_done
  DetailPrint "$1"
  MessageBox MB_RETRYCANCEL|MB_ICONSTOP|MB_DEFBUTTON2 "${PRODUCT_NAME} could not be stopped safely. Close it from the notification-area menu, then retry." /SD IDCANCEL IDRETRY stop_retry IDCANCEL stop_abort
  stop_abort:
  Abort
  stop_helper_missing:
  MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "The guarded shutdown helper is missing. Close ${PRODUCT_NAME} from the notification area before continuing." /SD IDCANCEL IDOK stop_done IDCANCEL stop_abort
  stop_done:
FunctionEnd

Function un.RemoveOwnedPayload
  IfFileExists "$INSTDIR\resources\installer\install-migration.ps1" 0 migration_helper_missing
  nsExec::ExecToStack 'powershell.exe -InputFormat None -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\installer\install-migration.ps1" -Phase Uninstall -NewInstallDir "$INSTDIR" -CanonicalConfigPath "$un.CanonicalConfigPath"'
  Pop $0
  Pop $1
  StrCmp $0 "0" migration_done
  DetailPrint "$1"
  MessageBox MB_ICONSTOP "Uninstall refused to remove an unrecognized, linked, or malformed payload. Unknown files and settings were left untouched.$\r$\n$\r$\n$1" /SD IDOK
  Abort
  migration_helper_missing:
  MessageBox MB_ICONSTOP "The owned-file cleanup helper is missing. Uninstall stopped without recursively deleting the application directory." /SD IDOK
  Abort
  migration_done:
FunctionEnd

Function un.RemoveClaudeConfig
  StrCpy $2 "0"
  IfFileExists "$INSTDIR\resources\installer\configure-claude.ps1" 0 claude_config_script_missing
  nsExec::ExecToStack 'powershell.exe -InputFormat None -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\installer\configure-claude.ps1" -InstallDir "$INSTDIR" -Remove'
  Pop $0
  Pop $1
  StrCmp $0 "0" codex_config_cleanup
  DetailPrint "$1"
  StrCpy $2 "1"
  Goto codex_config_cleanup

  claude_config_script_missing:
  StrCpy $2 "1"

  codex_config_cleanup:
  IfFileExists "$INSTDIR\runtime\node.exe" 0 codex_config_script_missing
  IfFileExists "$INSTDIR\resources\installer\configure-codex.mjs" 0 codex_config_script_missing
  nsExec::ExecToStack '"$INSTDIR\runtime\node.exe" "$INSTDIR\resources\installer\configure-codex.mjs" --install-dir "$INSTDIR" --remove'
  Pop $0
  Pop $1
  StrCmp $0 "0" config_cleanup_checked
  DetailPrint "$1"
  StrCpy $2 "1"
  Goto config_cleanup_checked

  codex_config_script_missing:
  StrCpy $2 "1"

  config_cleanup_checked:
  ; Return $2 to the uninstall section. It gates all subsequent mutation and
  ; offers an interactive retry; silent mode conservatively aborts.
FunctionEnd

Function un.CleanFoundryModulePayload
  IfFileExists "$INSTDIR\resources\installer\foundry-module-cleanup.ps1" 0 module_cleanup_missing
  nsExec::ExecToStack 'powershell.exe -InputFormat None -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\installer\foundry-module-cleanup.ps1" -ModuleRoot "$un.FoundryPath\foundry-mcp-bridge" -Mode Uninstall'
  Pop $0
  Pop $1
  StrCmp $0 "0" module_cleanup_done
  DetailPrint "$1"
  MessageBox MB_ICONEXCLAMATION "Foundry module cleanup was skipped before deleting any module code because an owned path is linked, reparsed, or unexpected.$\r$\n$\r$\n$1" /SD IDOK
  Return

  module_cleanup_missing:
  MessageBox MB_ICONEXCLAMATION "The guarded Foundry module cleanup helper is missing. No module code was removed." /SD IDOK

  module_cleanup_done:
FunctionEnd

Function un.ValidateFoundryModulesPath
  StrCpy $un.FoundryDataPath ""
  StrCmp $un.FoundryPath "" invalid_foundry_path
  GetFullPathName $un.FoundryPath "$un.FoundryPath"
  IfFileExists "$un.FoundryPath\." 0 invalid_foundry_path
  ${GetFileName} "$un.FoundryPath" $0
  StrCmp $0 "modules" 0 invalid_foundry_path
  ${GetParent} "$un.FoundryPath" $un.FoundryDataPath
  StrCmp $un.FoundryDataPath "" invalid_foundry_path
  GetFullPathName $3 "$un.FoundryDataPath\.."
  StrCmp $3 $un.FoundryDataPath invalid_foundry_path
  IfFileExists "$un.FoundryDataPath\modules\." 0 invalid_foundry_path
  GetFullPathName $1 "$un.FoundryDataPath\modules"
  StrCmp $1 $un.FoundryPath valid_foundry_path invalid_foundry_path
  invalid_foundry_path:
  StrCpy $un.FoundryPath ""
  StrCpy $un.FoundryDataPath ""
  valid_foundry_path:
FunctionEnd

Function un.DetectFoundryInstallation
  ReadRegStr $un.FoundryPath HKCU "${UNINSTALL_KEY}" "FoundryModulesPath"
  ReadRegStr $2 HKCU "${UNINSTALL_KEY}" "FoundryDataPath"
  Call un.ValidateFoundryModulesPath
  StrCmp $un.FoundryPath "" persisted_path_invalid
  StrCmp $2 "" persisted_path_invalid
  GetFullPathName $2 "$2"
  StrCmp $2 $un.FoundryDataPath foundry_installation_found
  persisted_path_invalid:
  StrCpy $un.FoundryPath "$LOCALAPPDATA\FoundryVTT_Next\Data\modules"
  Call un.ValidateFoundryModulesPath
  StrCmp $un.FoundryPath "" next_appdata_preview
  IfFileExists "$un.FoundryPath\foundry-mcp-bridge\module.json" foundry_installation_found
  next_appdata_preview:
  StrCpy $un.FoundryPath "$APPDATA\FoundryVTT_Next\Data\modules"
  Call un.ValidateFoundryModulesPath
  StrCmp $un.FoundryPath "" next_local_stable
  IfFileExists "$un.FoundryPath\foundry-mcp-bridge\module.json" foundry_installation_found
  next_local_stable:
  StrCpy $un.FoundryPath "$LOCALAPPDATA\FoundryVTT\Data\modules"
  Call un.ValidateFoundryModulesPath
  StrCmp $un.FoundryPath "" next_appdata_stable
  IfFileExists "$un.FoundryPath\foundry-mcp-bridge\module.json" foundry_installation_found
  next_appdata_stable:
  StrCpy $un.FoundryPath "$APPDATA\FoundryVTT\Data\modules"
  Call un.ValidateFoundryModulesPath
  StrCmp $un.FoundryPath "" next_environment_path
  IfFileExists "$un.FoundryPath\foundry-mcp-bridge\module.json" foundry_installation_found
  next_environment_path:
  ReadEnvStr $2 "FOUNDRY_VTT_DATA_PATH"
  StrCmp $2 "" foundry_installation_missing
  StrCpy $un.FoundryPath "$2\modules"
  Call un.ValidateFoundryModulesPath
  StrCmp $un.FoundryPath "" next_environment_parent
  IfFileExists "$un.FoundryPath\foundry-mcp-bridge\module.json" foundry_installation_found
  next_environment_parent:
  StrCpy $un.FoundryPath "$2\Data\modules"
  Call un.ValidateFoundryModulesPath
  StrCmp $un.FoundryPath "" foundry_installation_missing
  IfFileExists "$un.FoundryPath\foundry-mcp-bridge\module.json" foundry_installation_found
  foundry_installation_missing:
  StrCpy $un.FoundryPath ""
  StrCpy $un.FoundryDataPath ""
  Return
  foundry_installation_found:
  DetailPrint "Using validated Foundry VTT data directory: $un.FoundryDataPath"
FunctionEnd

Function un.RemoveLegacyCreatureIndexCaches
  Call un.ValidateFoundryModulesPath
  StrCmp $un.FoundryDataPath "" cleanup_done
  IfFileExists "$un.FoundryDataPath\worlds\." 0 cleanup_done
  FindFirst $0 $1 "$un.FoundryDataPath\worlds\*"
  cleanup_loop:
  StrCmp $1 "" cleanup_close
  StrCmp $1 "." cleanup_next
  StrCmp $1 ".." cleanup_next
  IfFileExists "$un.FoundryDataPath\worlds\$1\." 0 cleanup_next
  StrCpy $3 "$un.FoundryDataPath\worlds\$1"
  System::Call 'kernel32::GetFileAttributes(t r3) i .r2'
  IntOp $2 $2 & 0x400
  IntCmp $2 0 0 cleanup_next cleanup_next
  Delete "$un.FoundryDataPath\worlds\$1\enhanced-creature-index.json"
  IfErrors 0 cleanup_removed
  DetailPrint "Could not remove the retired cache from world '$1'; leaving it unchanged."
  Goto cleanup_next
  cleanup_removed:
  DetailPrint "Removed retired Enhanced Creature Index cache from world '$1'."
  cleanup_next:
  FindNext $0 $1
  Goto cleanup_loop
  cleanup_close:
  FindClose $0
  cleanup_done:
FunctionEnd

Function un.IsFoundryModuleTargetSafe
  StrCpy $4 "$un.FoundryPath\foundry-mcp-bridge"
  System::Call 'kernel32::GetFileAttributes(t r4) i .r5'
  IntCmp $5 -1 module_target_safe module_target_unsafe module_target_attributes
  module_target_attributes:
  IntOp $6 $5 & 0x400
  IntCmp $6 0 0 module_target_unsafe module_target_unsafe
  IntOp $6 $5 & 0x10
  IntCmp $6 0 module_target_unsafe module_target_unsafe module_target_safe
  module_target_safe:
  StrCpy $6 "1"
  Return
  module_target_unsafe:
  StrCpy $6 "0"
FunctionEnd
