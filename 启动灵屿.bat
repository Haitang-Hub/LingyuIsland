@echo off
rem LingYu Privacy Island - launcher (start the Electron app without npm overhead)
set "APP_DIR=%~dp0"
if not exist "%APP_DIR%node_modules\electron\dist\electron.exe" (
  echo [LingYu] Electron runtime not found. Run "npm install" in %APP_DIR% first.
  pause
  exit /b 1
)
start "" "%APP_DIR%node_modules\electron\dist\electron.exe" "%APP_DIR%."
exit /b 0
