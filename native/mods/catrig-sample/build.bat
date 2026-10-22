@echo off
REM Build catrig_sample.dll with w64devkit GCC against the framework's public header.
REM Copy build\catrig_sample.dll to native\dist\ to deploy (loaded after mewframework.dll, which chainloader.ini pins first).
setlocal
if not defined GCC set "GCC=C:\raylib\w64devkit\bin\gcc.exe"
set "HERE=%~dp0"
set "NATIVE=%HERE%..\.."
set "OUT=%HERE%build"
if not exist "%OUT%" mkdir "%OUT%"
"%GCC%" -std=c11 -O2 -Wall -Wextra -Wno-cast-function-type -shared -static -static-libgcc ^
  -I"%HERE%src" -I"%NATIVE%\framework\src" -I"%NATIVE%\third_party\mewjector" ^
  "%HERE%src\catrig_sample.c" "%HERE%src\catrig_sample_rules.c" ^
  -o "%OUT%\catrig_sample.dll"
if errorlevel 1 ( echo BUILD FAILED & exit /b 1 )
echo built %OUT%\catrig_sample.dll
endlocal
