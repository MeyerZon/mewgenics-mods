@echo off
REM Host-side unit tests for jokers_luck.dll's pure part: the reroll rule over the framework's random stream
REM (src\jl_roll.c + ..\..\framework\src\fw_rng.c). Builds build\test_roll.exe with w64devkit GCC; exit code = failures.
setlocal
if not defined GCC set "GCC=C:\raylib\w64devkit\bin\gcc.exe"
set "HERE=%~dp0"
set "FW=%HERE%..\..\framework"
set "OUT=%HERE%build"
if not exist "%OUT%" mkdir "%OUT%"
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" -I"%FW%\src" ^
  "%HERE%test\test_roll.c" "%HERE%src\jl_roll.c" "%FW%\src\fw_rng.c" ^
  -o "%OUT%\test_roll.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_roll.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
endlocal
