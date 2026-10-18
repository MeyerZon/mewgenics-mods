@echo off
REM Host-side unit tests for mewframework's pure parts (no game, no windows.h): the signature
REM scanner (test_sig) and the build gate + GENERATED per-build tables (test_build).
REM Builds build\test_*.exe with w64devkit GCC and runs them; exit code = failures.
setlocal
if not defined GCC set "GCC=C:\raylib\w64devkit\bin\gcc.exe"
set "HERE=%~dp0"
set "OUT=%HERE%build"
if not exist "%OUT%" mkdir "%OUT%"
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_sig.c" "%HERE%src\fw_sig.c" ^
  -o "%OUT%\test_sig.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_sig.exe"
if errorlevel 1 ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_build.c" "%HERE%src\fw_build.c" "%HERE%src\fw_sig.c" ^
  -o "%OUT%\test_build.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_build.exe"
if errorlevel 1 ( echo TESTS FAILED & exit /b 1 )
endlocal
