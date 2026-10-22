@echo off
REM Host-side unit tests for mewframework's pure parts (no game, no windows.h): the signature
REM scanner (test_sig), the build gate + GENERATED per-build tables (test_build), the status
REM definition rules / name aliasing (test_status_rules), the custom-status vtable clone + thunks
REM (test_vtable), the entity/component walks + apply/merge writes (test_walk) and the load-time
REM policy: symbol resolution, the launch gate, API bounds and the hook plan (test_resolve).
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
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_status_rules.c" "%HERE%src\fw_status_rules.c" ^
  -o "%OUT%\test_status_rules.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_status_rules.exe"
if errorlevel 1 ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_vtable.c" "%HERE%src\fw_vtable.c" "%HERE%src\fw_status_rules.c" ^
  -o "%OUT%\test_vtable.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_vtable.exe"
if errorlevel 1 ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_walk.c" "%HERE%src\fw_walk.c" ^
  -o "%OUT%\test_walk.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_walk.exe"
if errorlevel 1 ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_resolve.c" "%HERE%src\fw_resolve.c" "%HERE%src\fw_sig.c" ^
  -o "%OUT%\test_resolve.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_resolve.exe"
if errorlevel 1 ( echo TESTS FAILED & exit /b 1 )
endlocal
