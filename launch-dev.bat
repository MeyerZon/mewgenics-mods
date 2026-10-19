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
REM Extra mod dirs may be passed as arguments, relative to the repo or absolute, e.g. `launch-dev.bat mods\swf-gate`.
set "EXTRA_MODS="
:args
if "%~1"=="" goto launch
if exist "%~1\" (
  set "EXTRA_MODS=%EXTRA_MODS% "%~f1""
) else if exist "%REPO%\%~1\" (
  set "EXTRA_MODS=%EXTRA_MODS% "%REPO%\%~1""
) else (
  echo mod dir not found: %~1
  exit /b 1
)
shift
goto args
:launch
echo Launching with -savesuffix %SAVE_SUFFIX% and mods from %REPO%\mods%EXTRA_MODS%
cd /d "%GAME_DIR%"
start "" "%GAME_DIR%\Mewgenics.exe" -savesuffix %SAVE_SUFFIX% -enable_debugconsole true -dev_mode true -modpaths "%REPO%\mods\dev-sandbox" "%REPO%\mods\jokers-luck"%EXTRA_MODS%
endlocal
