@echo off
setlocal
set "BRIDGE_INSTALL_DIR=%~1"
set "BRIDGE_HELPER_DIR=%~dp0"

if "%BRIDGE_INSTALL_DIR%"=="" exit /b 2
if not exist "%BRIDGE_HELPER_DIR%configure-claude.ps1" exit /b 3

powershell.exe -InputFormat None -NoProfile -NonInteractive -ExecutionPolicy Bypass ^
  -File "%BRIDGE_HELPER_DIR%configure-claude.ps1" -InstallDir "%BRIDGE_INSTALL_DIR%"
exit /b %errorlevel%
