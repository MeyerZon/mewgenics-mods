@echo off
REM Installs the Mewjector v3.5 proxy loader (built from audited source, see
REM native\third_party\mewjector\built-from-source\BUILD.md) into the Mewgenics folder.
REM Re-run after Steam verifies or updates the game files (they may remove version.dll).
REM
REM Remove with:  del "<game dir>\version.dll" "<game dir>\chainloader.ini"
setlocal
set "GAME_DIR=C:\Program Files (x86)\Steam\steamapps\common\Mewgenics"
for %%I in ("%~dp0..") do set "REPO=%%~fI"
if not exist "%REPO%\native\third_party\mewjector\built-from-source\version.dll" (
  echo version.dll not found; rebuild with tools\mewjector-build\build.sh in Docker (see BUILD.md).
  exit /b 1
)
copy /y "%REPO%\native\third_party\mewjector\built-from-source\version.dll" "%GAME_DIR%\version.dll"
REM Write chainloader.ini with this repo's absolute native\dist path resolved from the __REPO__ placeholder.
powershell -NoProfile -Command "(Get-Content -Raw '%REPO%\native\chainloader.ini').Replace('__REPO__','%REPO%') | Set-Content -NoNewline '%GAME_DIR%\chainloader.ini'"
echo Installed. Launch with launch-dev.bat and check "%GAME_DIR%\mod_logs\chainloader.log" and mewframework.log.
endlocal
