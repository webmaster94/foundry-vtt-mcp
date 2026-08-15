; Foundry MCP Server Windows installer

!include "MUI2.nsh"
!include "Sections.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"

Name "Foundry MCP Server"
!ifndef OUTFILE
  !define OUTFILE "FoundryMCPServer-Setup.exe"
!endif
OutFile "${OUTFILE}"
Unicode True
InstallDir "$LOCALAPPDATA\FoundryMCPServer"
RequestExecutionLevel user

!ifndef VERSION
  !define VERSION "v0.5.5"
!endif
!searchparse /noerrors "${VERSION}" "v" STRIPPED_VERSION
!ifndef STRIPPED_VERSION
  !define STRIPPED_VERSION "${VERSION}"
!endif
!searchparse /noerrors "${STRIPPED_VERSION}" "" VERSION_BASE "-"
!ifndef VERSION_BASE
  !define VERSION_BASE "${STRIPPED_VERSION}"
!endif

VIProductVersion "${VERSION_BASE}.0"
VIAddVersionKey "ProductName" "Foundry MCP Server"
VIAddVersionKey "CompanyName" "Foundry MCP Bridge"
VIAddVersionKey "FileDescription" "MCP bridge for Foundry VTT"
VIAddVersionKey "FileVersion" "${VERSION_BASE}.0"
VIAddVersionKey "LegalCopyright" "© 2024 Foundry MCP Bridge"

!define MUI_ABORTWARNING
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_WELCOMEPAGE_TITLE "Foundry MCP Server Setup"
!define MUI_WELCOMEPAGE_TEXT "This wizard installs the Foundry MCP Server and can also install the Foundry MCP Bridge module.$\r$\n$\r$\nThe server connects MCP clients with Foundry VTT. Click Next to continue."
!define MUI_COMPONENTSPAGE_TEXT_TOP "Select the components you want to install:"
!define MUI_FINISHPAGE_TITLE "Installation Complete"
!define MUI_FINISHPAGE_TEXT_NOREBOOTSUPPORT
!define MUI_FINISHPAGE_TEXT "Foundry MCP Server is installed.$\r$\n$\r$\nRestart Claude Desktop, launch Foundry VTT, enable Foundry MCP Bridge, and configure the module connection.$\r$\n$\r$\nFor support and documentation, visit the GitHub repository."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open Foundry VTT MCP GitHub"
!define MUI_FINISHPAGE_RUN_FUNCTION "OpenGitHub"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "LICENSE.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Var FoundryPath
Var FoundryDataPath
Var un.FoundryPath
Var un.FoundryDataPath

Function .onInit
  !insertmacro SelectSection SecFoundryModule
FunctionEnd

Function OpenGitHub
  ExecShell "open" "https://github.com/webmaster94/foundry-vtt-mcp"
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
  ; Prefer the exact path selected by a previous installer run.
  ReadRegStr $FoundryPath HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryMCPServer" "FoundryModulesPath"
  ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryMCPServer" "FoundryDataPath"
  Call ValidateFoundryModulesPath
  StrCmp $FoundryPath "" persisted_path_invalid
  StrCmp $2 "" persisted_path_invalid
  GetFullPathName $2 "$2"
  StrCmp $2 $FoundryDataPath foundry_found

  persisted_path_invalid:
  StrCpy $FoundryPath ""
  StrCpy $FoundryDataPath ""

  ; Foundry development/preview installs use a separate data root.
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
  MessageBox MB_YESNO "Foundry VTT was not detected automatically.$\r$\n$\r$\nBrowse for the Foundry User Data folder?" IDYES select_foundry_folder IDNO skip_module

  select_foundry_folder:
  nsDialogs::SelectFolderDialog "Select Foundry VTT User Data Folder" "$LOCALAPPDATA"
  Pop $2
  StrCmp $2 "CANCEL" skip_module

  ; Accept the Data folder, its parent, or the modules folder itself.
  StrCpy $FoundryPath "$2\modules"
  Call ValidateFoundryModulesPath
  StrCmp $FoundryPath "" 0 foundry_found
  StrCpy $FoundryPath "$2\Data\modules"
  Call ValidateFoundryModulesPath
  StrCmp $FoundryPath "" 0 foundry_found
  StrCpy $FoundryPath "$2"
  Call ValidateFoundryModulesPath
  StrCmp $FoundryPath "" 0 foundry_found
  MessageBox MB_ICONSTOP "The selected folder does not contain a Foundry VTT modules directory. Module installation will be skipped."

  skip_module:
  StrCpy $FoundryPath ""
  StrCpy $FoundryDataPath ""
  Return

  foundry_found:
  DetailPrint "Foundry VTT data directory: $FoundryDataPath"
  DetailPrint "Foundry VTT modules directory: $FoundryPath"
FunctionEnd

Function RemoveLegacyCreatureIndexCaches
  ; Validate again immediately before touching world data. Only the retired,
  ; exact cache filename is deleted; generated maps and all other files remain.
  Call ValidateFoundryModulesPath
  StrCmp $FoundryDataPath "" cleanup_done
  IfFileExists "$FoundryDataPath\worlds\." 0 cleanup_done

  FindFirst $0 $1 "$FoundryDataPath\worlds\*"
  cleanup_loop:
  StrCmp $1 "" cleanup_close
  StrCmp $1 "." cleanup_next
  StrCmp $1 ".." cleanup_next
  IfFileExists "$FoundryDataPath\worlds\$1\." 0 cleanup_next
  ; Skip junctions and directory symlinks so cleanup cannot leave the worlds directory.
  StrCpy $3 "$FoundryDataPath\worlds\$1"
  System::Call 'kernel32::GetFileAttributes(t r3) i .r2'
  IntOp $2 $2 & 0x400
  IntCmp $2 0 0 cleanup_next cleanup_next
  IfFileExists "$FoundryDataPath\worlds\$1\enhanced-creature-index.json" 0 cleanup_next
  Delete "$FoundryDataPath\worlds\$1\enhanced-creature-index.json"
  IfErrors 0 cleanup_removed
  DetailPrint "Could not remove legacy cache from world '$1'; leaving it unchanged."
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
  ; A missing target is safe to create. Existing targets must be ordinary
  ; directories; files, junctions, and symlinks are never followed or replaced.
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

Function UpdateClaudeConfig
  DetailPrint "Configuring Claude Desktop..."
  nsExec::ExecToStack 'powershell.exe -inputformat none -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\configure-claude.ps1" -InstallDir "$INSTDIR"'
  Pop $0
  Pop $1
  StrCmp $0 "0" config_done

  DetailPrint "Direct configuration failed; trying the batch wrapper."
  nsExec::ExecToStack '"$INSTDIR\configure-claude-wrapper.bat" "$INSTDIR"'
  Pop $0
  Pop $1
  StrCmp $0 "0" config_done config_failed

  config_failed:
  DetailPrint "Claude Desktop configuration failed: $1"
  MessageBox MB_ICONEXCLAMATION "The server was installed, but Claude Desktop could not be configured automatically.$\r$\n$\r$\nSee README.txt for manual setup instructions."

  config_done:
FunctionEnd

Section "Foundry MCP Server" SecMain
  SectionIn RO
  SectionSetSize ${SecMain} 32768

  SetOutPath "$INSTDIR"
  File /r "node\"
  File "node.exe"

  SetOutPath "$INSTDIR\foundry-mcp-server"
  File /r "foundry-mcp-server\*"
  SetOutPath "$INSTDIR"
  File "README.txt"
  File "LICENSE.txt"
  File "icon.ico"
  File "configure-claude.ps1"
  File "configure-claude-wrapper.bat"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Foundry MCP Server"
  CreateShortcut "$SMPROGRAMS\Foundry MCP Server\Uninstall.lnk" "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryMCPServer" "DisplayName" "Foundry MCP Server"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryMCPServer" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryMCPServer" "DisplayIcon" "$INSTDIR\icon.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryMCPServer" "Publisher" "Foundry MCP Bridge"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryMCPServer" "DisplayVersion" "0.5.5"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryMCPServer" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryMCPServer" "NoRepair" 1

  FileOpen $0 "$INSTDIR\start-server.bat" w
  FileWrite $0 '@echo off$\r$\n'
  FileWrite $0 'cd /d "$INSTDIR"$\r$\n'
  FileWrite $0 '"$INSTDIR\node.exe" "$INSTDIR\foundry-mcp-server\packages\mcp-server\dist\index.cjs"$\r$\n'
  FileWrite $0 'pause$\r$\n'
  FileClose $0

  FileOpen $0 "$INSTDIR\test-connection.bat" w
  FileWrite $0 '@echo off$\r$\n'
  FileWrite $0 '"$INSTDIR\node.exe" --version$\r$\n'
  FileWrite $0 'if exist "$INSTDIR\foundry-mcp-server\packages\mcp-server\dist\index.cjs" (echo MCP server files found) else (echo MCP server files missing)$\r$\n'
  FileWrite $0 'pause$\r$\n'
  FileClose $0

  Call UpdateClaudeConfig
SectionEnd

Section "Foundry MCP Bridge" SecFoundryModule
  SectionSetSize ${SecFoundryModule} 5120
  Call DetectFoundryInstallation
  StrCmp $FoundryPath "" module_done
  Call IsFoundryModuleTargetSafe
  StrCmp $6 "1" 0 unsafe_module_target

  ; Persist the validated, exact paths for upgrades and the uninstaller. This
  ; avoids guessing between stable, preview (FoundryVTT_Next), and custom roots.
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryMCPServer" "FoundryDataPath" "$FoundryDataPath"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryMCPServer" "FoundryModulesPath" "$FoundryPath"
  Call RemoveLegacyCreatureIndexCaches

  CreateDirectory "$FoundryPath\foundry-mcp-bridge"
  ; Replace module-owned code and assets, preserving user-created content from
  ; older releases (including generated maps).
  RMDir /r "$FoundryPath\foundry-mcp-bridge\dist"
  RMDir /r "$FoundryPath\foundry-mcp-bridge\lang"
  RMDir /r "$FoundryPath\foundry-mcp-bridge\scripts"
  RMDir /r "$FoundryPath\foundry-mcp-bridge\styles"
  RMDir /r "$FoundryPath\foundry-mcp-bridge\templates"
  Delete "$FoundryPath\foundry-mcp-bridge\module.json"
  SetOutPath "$FoundryPath\foundry-mcp-bridge"
  SetOverwrite on
  File /r "foundry-module\*"
  DetailPrint "Foundry MCP Bridge installed to $FoundryPath\foundry-mcp-bridge"
  Goto module_done

  unsafe_module_target:
  DetailPrint "Refusing to replace reparse-point or non-directory module target: $FoundryPath\foundry-mcp-bridge"
  MessageBox MB_ICONEXCLAMATION "The Foundry MCP Bridge module target is a symlink, junction, reparse point, or non-directory. Module installation was skipped to protect the target data."

  module_done:
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} "Core MCP server, bundled Node.js runtime, and Claude Desktop configuration (required)."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecFoundryModule} "Foundry VTT bridge module (recommended)."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  ; Resolve and validate the exact persisted Foundry path before any removal.
  Call un.DetectFoundryInstallation
  StrCmp $un.FoundryPath "" skip_legacy_cache_removal
  Call un.RemoveLegacyCreatureIndexCaches

  skip_legacy_cache_removal:
  MessageBox MB_YESNO "Remove the Foundry MCP Bridge module code from Foundry VTT? User-created module content and generated maps are preserved; only the retired Enhanced Creature Index cache is removed from worlds." IDYES remove_module IDNO skip_module_removal

  remove_module:
  StrCmp $un.FoundryPath "" skip_module_removal
  Call un.IsFoundryModuleTargetSafe
  StrCmp $6 "1" 0 unsafe_uninstall_module_target
  RMDir /r "$un.FoundryPath\foundry-mcp-bridge\dist"
  RMDir /r "$un.FoundryPath\foundry-mcp-bridge\lang"
  RMDir /r "$un.FoundryPath\foundry-mcp-bridge\scripts"
  RMDir /r "$un.FoundryPath\foundry-mcp-bridge\styles"
  RMDir /r "$un.FoundryPath\foundry-mcp-bridge\templates"
  Delete "$un.FoundryPath\foundry-mcp-bridge\module.json"
  RMDir "$un.FoundryPath\foundry-mcp-bridge"
  Goto skip_module_removal

  unsafe_uninstall_module_target:
  DetailPrint "Refusing to remove reparse-point or non-directory module target: $un.FoundryPath\foundry-mcp-bridge"
  MessageBox MB_ICONEXCLAMATION "The Foundry MCP Bridge module target is a symlink, junction, reparse point, or non-directory. Module removal was skipped to protect the target data."

  skip_module_removal:
  MessageBox MB_YESNO "Remove the Foundry MCP Server entry from Claude Desktop configuration? Other MCP server entries will be preserved." IDYES remove_claude_config IDNO skip_claude_config

  remove_claude_config:
  Call un.RemoveClaudeConfig

  skip_claude_config:
  RMDir /r "$SMPROGRAMS\Foundry MCP Server"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryMCPServer"

  ; Remove only payloads owned by this installer. Do not recursively delete the
  ; user-selectable installation directory itself.
  Delete "$INSTDIR\node.exe"
  RMDir /r "$INSTDIR\node"
  RMDir /r "$INSTDIR\foundry-mcp-server"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\LICENSE.txt"
  Delete "$INSTDIR\icon.ico"
  Delete "$INSTDIR\configure-claude.ps1"
  Delete "$INSTDIR\configure-claude-wrapper.bat"
  Delete "$INSTDIR\start-server.bat"
  Delete "$INSTDIR\test-connection.bat"

  ; Remove uniquely named legacy bridge launchers/notices. Legacy model folders
  ; are deliberately left alone because a custom $INSTDIR makes ownership
  ; ambiguous; uninstalling must never remove a user's separate installation.
  Delete "$INSTDIR\start-comfyui.bat"
  Delete "$INSTDIR\test-comfyui.bat"
  Delete "$INSTDIR\THIRD_PARTY_NOTICES.txt"

  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd

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
  ; New installations persist the user's exact, validated choice.
  ReadRegStr $un.FoundryPath HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryMCPServer" "FoundryModulesPath"
  ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryMCPServer" "FoundryDataPath"
  Call un.ValidateFoundryModulesPath
  StrCmp $un.FoundryPath "" persisted_path_invalid
  StrCmp $2 "" persisted_path_invalid
  GetFullPathName $2 "$2"
  StrCmp $2 $un.FoundryDataPath foundry_installation_found

  persisted_path_invalid:
  StrCpy $un.FoundryPath ""
  StrCpy $un.FoundryDataPath ""

  ; Safe fallbacks support uninstalling releases that predate path persistence.
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
  ; Revalidate immediately before removing the exact retired cache filename.
  Call un.ValidateFoundryModulesPath
  StrCmp $un.FoundryDataPath "" cleanup_done
  IfFileExists "$un.FoundryDataPath\worlds\." 0 cleanup_done

  FindFirst $0 $1 "$un.FoundryDataPath\worlds\*"
  cleanup_loop:
  StrCmp $1 "" cleanup_close
  StrCmp $1 "." cleanup_next
  StrCmp $1 ".." cleanup_next
  IfFileExists "$un.FoundryDataPath\worlds\$1\." 0 cleanup_next
  ; Skip junctions and directory symlinks so cleanup cannot leave the worlds directory.
  StrCpy $3 "$un.FoundryDataPath\worlds\$1"
  System::Call 'kernel32::GetFileAttributes(t r3) i .r2'
  IntOp $2 $2 & 0x400
  IntCmp $2 0 0 cleanup_next cleanup_next
  IfFileExists "$un.FoundryDataPath\worlds\$1\enhanced-creature-index.json" 0 cleanup_next
  Delete "$un.FoundryDataPath\worlds\$1\enhanced-creature-index.json"
  IfErrors 0 cleanup_removed
  DetailPrint "Could not remove legacy cache from world '$1'; leaving it unchanged."
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
  ; A missing target needs no removal. Existing targets must be ordinary
  ; directories; files, junctions, and symlinks are never followed or removed.
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

Function un.RemoveClaudeConfig
  IfFileExists "$INSTDIR\configure-claude.ps1" 0 config_script_missing
  nsExec::ExecToStack 'powershell.exe -inputformat none -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\configure-claude.ps1" -Remove'
  Pop $0
  Pop $1
  StrCmp $0 "0" config_done
  DetailPrint "Claude Desktop configuration cleanup failed: $1"
  MessageBox MB_ICONEXCLAMATION "One or more Claude Desktop configuration files could not be updated. They were left unchanged; any successfully updated file has a timestamped backup beside it.$\r$\n$\r$\nSee $TEMP\foundry-mcp-claude-config.log for details."
  Return

  config_script_missing:
  MessageBox MB_ICONEXCLAMATION "The configuration helper is missing. Remove only the 'foundry-mcp' or legacy 'foundry-vtt-mcp' entry from Claude Desktop manually."

  config_done:
FunctionEnd
