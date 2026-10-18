@echo off
REM Launch Mewgenics with the dev sandbox mods and an isolated save suffix.
REM Never put these arguments in Steam launch options: plain Steam launches must stay vanilla.
REM SteamAppId/SteamGameId identify the game to Steamworks when the exe is started directly
REM (same approach as Mewtator). Steam must be running.
setlocal
set "GAME_DIR=C:\Program Files (x86)\Steam\steamapps\common\Mewgenics"
set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"
set "SAVE_SUFFIX=dev"
set "SteamAppId=686060"
set "SteamGameId=686060"
if not exist "%GAME_DIR%\Mewgenics.exe" (
  echo Mewgenics.exe not found in "%GAME_DIR%"
  exit /b 1
)
echo Launching with -savesuffix %SAVE_SUFFIX% and mods from %REPO%\mods
cd /d "%GAME_DIR%"
start "" "%GAME_DIR%\Mewgenics.exe" -savesuffix %SAVE_SUFFIX% -enable_debugconsole true -dev_mode true -modpaths "%REPO%\mods\dev-sandbox" "%REPO%\mods\jokers-luck"
endlocal
