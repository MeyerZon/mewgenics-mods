@echo off
REM Host-side unit tests for mewtest's pure modules (no game, no windows.h).
REM Builds build\test_mewtest.exe with w64devkit GCC and runs it; exit code = failures.
REM The framework's generated offsets.h is on the include path: mt_gon.c and the fake GON nodes are laid out by it.
setlocal
if not defined GCC set "GCC=C:\raylib\w64devkit\bin\gcc.exe"
set "HERE=%~dp0"
set "OUT=%HERE%build"
if not exist "%OUT%" mkdir "%OUT%"
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -DMT_HOST_TEST -I"%HERE%src" -I"%HERE%..\..\framework\src" ^
  "%HERE%test\test_mewtest.c" ^
  "%HERE%src\mt_jsonl.c" "%HERE%src\mt_args.c" "%HERE%src\mt_msvcstr.c" "%HERE%src\mt_script.c" "%HERE%src\mt_console.c" "%HERE%src\mt_runner.c" "%HERE%src\mt_exit.c" "%HERE%src\mt_queue.c" "%HERE%src\mt_gon.c" "%HERE%src\mt_walk.c" ^
  -o "%OUT%\test_mewtest.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_mewtest.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
endlocal
