@echo off
REM Build mewtest.dll (the in-game test harness) with w64devkit GCC against the framework's public header.
REM Copy build\mewtest.dll to native\dist\ to deploy (Mewjector's ScanPath loads it after mewframework.dll).
setlocal
if not defined GCC set "GCC=C:\raylib\w64devkit\bin\gcc.exe"
set "HERE=%~dp0"
set "NATIVE=%HERE%..\.."
set "OUT=%HERE%build"
if not exist "%OUT%" mkdir "%OUT%"
"%GCC%" -std=c11 -O2 -Wall -Wextra -Wno-cast-function-type -shared -static -static-libgcc ^
  -I"%HERE%src" -I"%NATIVE%\framework\src" -I"%NATIVE%\third_party\mewjector" ^
  "%HERE%src\mewtest.c" ^
  "%HERE%src\mt_jsonl.c" "%HERE%src\mt_args.c" "%HERE%src\mt_msvcstr.c" "%HERE%src\mt_script.c" "%HERE%src\mt_console.c" "%HERE%src\mt_runner.c" "%HERE%src\mt_exit.c" ^
  -o "%OUT%\mewtest.dll"
if errorlevel 1 ( echo BUILD FAILED & exit /b 1 )
echo built %OUT%\mewtest.dll
endlocal
