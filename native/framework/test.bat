@echo off
REM Host-side unit tests for mewframework's pure parts (no game, no windows.h): the signature
REM scanner (test_sig), the build gate + GENERATED per-build tables (test_build), the status
REM definition rules / name aliasing (test_status_rules), the custom-status vtable clone + thunks
REM (test_vtable), the entity/component walks + apply/merge writes (test_walk), the load-time
REM policy: symbol resolution, the launch gate, API bounds and the hook plan (test_resolve) and the
REM per-unit glow rules: registry, pruning, layer vector, pass lookup and writes (test_glow_rules) and the
REM FW_Random stream: splitmix64, seeding, the bounded draw (test_rng).
REM game-speed rules: clamp, default, no compounding, restore on disable (test_speed_rules).
REM cat rig redirect rules: registry, entry lookup, _CatRig_ export parser, SymbolClass list scan (test_catrig_rules).
REM phase-0 3D observer: budget, camera/layer/item accessors, log line formats (test_obs3d_rules).
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
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_build.c" "%HERE%src\fw_build.c" "%HERE%src\fw_sig.c" ^
  -o "%OUT%\test_build.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_build.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_status_rules.c" "%HERE%src\fw_status_rules.c" "%HERE%src\fw_glow_rules.c" ^
  -o "%OUT%\test_status_rules.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_status_rules.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_vtable.c" "%HERE%src\fw_vtable.c" "%HERE%src\fw_status_rules.c" "%HERE%src\fw_glow_rules.c" ^
  -o "%OUT%\test_vtable.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_vtable.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_walk.c" "%HERE%src\fw_walk.c" ^
  -o "%OUT%\test_walk.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_walk.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_resolve.c" "%HERE%src\fw_resolve.c" "%HERE%src\fw_sig.c" ^
  -o "%OUT%\test_resolve.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_resolve.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_glow_rules.c" "%HERE%src\fw_glow_rules.c" ^
  -o "%OUT%\test_glow_rules.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_glow_rules.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_rng.c" "%HERE%src\fw_rng.c" ^
  -o "%OUT%\test_rng.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_rng.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_speed_rules.c" "%HERE%src\fw_speed_rules.c" ^
  -o "%OUT%\test_speed_rules.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_speed_rules.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_catrig_rules.c" "%HERE%src\fw_catrig_rules.c" ^
  -o "%OUT%\test_catrig_rules.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_catrig_rules.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_obs3d_rules.c" "%HERE%src\fw_obs3d_rules.c" ^
  -o "%OUT%\test_obs3d_rules.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_obs3d_rules.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
endlocal
