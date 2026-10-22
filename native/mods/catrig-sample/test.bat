@echo off
REM Host-side unit tests for catrig_sample.dll's pure part (no game, no windows.h): the pairs, the checks, the bind
REM loop against the framework's own registry rules (fw_catrig_rules.c). Exit code = failures.
setlocal
if not defined GCC set "GCC=C:\raylib\w64devkit\bin\gcc.exe"
set "HERE=%~dp0"
set "FW=%HERE%..\..\framework\src"
set "OUT=%HERE%build"
if not exist "%OUT%" mkdir "%OUT%"
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" -I"%FW%" ^
  "%HERE%test\test_catrig_sample.c" "%HERE%src\catrig_sample_rules.c" "%FW%\fw_catrig_rules.c" ^
  -o "%OUT%\test_catrig_sample.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_catrig_sample.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
endlocal
