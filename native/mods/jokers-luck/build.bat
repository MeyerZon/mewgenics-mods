@echo off
REM Build jokers_luck.dll with w64devkit GCC against the framework's public header.
setlocal
if not defined GCC set "GCC=C:\raylib\w64devkit\bin\gcc.exe"
set "HERE=%~dp0"
set "NATIVE=%HERE%..\.."
set "OUT=%HERE%build"
if not exist "%OUT%" mkdir "%OUT%"
"%GCC%" -std=c11 -O2 -Wall -Wextra -Wno-cast-function-type -shared -static -static-libgcc ^
  -I"%NATIVE%\framework\src" -I"%NATIVE%\third_party\mewjector" ^
  "%HERE%src\jokers_luck.c" ^
  -o "%OUT%\jokers_luck.dll"
if errorlevel 1 ( echo BUILD FAILED & exit /b 1 )
echo built %OUT%\jokers_luck.dll
endlocal
