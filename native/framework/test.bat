@echo off
REM Host-side unit tests for mewframework's pure parts (no game, no windows.h): the signature
REM scanner (test_sig), the build gate + GENERATED per-build tables (test_build), the status
REM definition rules / name aliasing (test_status_rules), the custom-status vtable clone + thunks
REM (test_vtable), the entity/component walks + apply/merge writes (test_walk), the load-time
REM policy: symbol resolution, the launch gate, API bounds and the hook plan (test_resolve) and the
REM per-unit glow rules: registry, pruning, layer vector, pass lookup and writes (test_glow_rules) and the
REM phase-0 3D observer: budget, camera/layer/item accessors, log line formats (test_obs3d_rules), the
REM M1 mesh draw: 4x4 maths vs the observed matrices, the std::function functor, GL save/restore, probe rules (test_mesh_draw), the 3D-object
REM registry + model matrix + the API v6 layout (test_obj3d_rules) and the GON walker / graphics.model seam (test_gon).
REM phase-M mesh rules: OBJ parser, game axes, unit cube, model registry, model paths (test_mesh_rules), the
REM JSON tokenizer (test_json), the glTF 2.0 loader (test_mesh_gltf) and the mesh texture / palette rules (test_mesh_tex).
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
  "%HERE%test\test_status_rules.c" "%HERE%src\fw_status_rules.c" ^
  -o "%OUT%\test_status_rules.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_status_rules.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_vtable.c" "%HERE%src\fw_vtable.c" "%HERE%src\fw_status_rules.c" ^
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
  "%HERE%test\test_obs3d_rules.c" "%HERE%src\fw_obs3d_rules.c" ^
  -o "%OUT%\test_obs3d_rules.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_obs3d_rules.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_mesh_draw.c" "%HERE%src\fw_m4.c" "%HERE%src\fw_functor.c" "%HERE%src\fw_gl_state.c" "%HERE%src\fw_mesh_draw.c" "%HERE%src\fw_mesh_rules.c" "%HERE%src\fw_mesh_gltf.c" "%HERE%src\fw_json.c" ^
  -o "%OUT%\test_mesh_draw.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_mesh_draw.exe"
  "%HERE%test\test_mesh_rules.c" "%HERE%src\fw_mesh_rules.c" ^
  -o "%OUT%\test_mesh_rules.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_mesh_rules.exe"
  "%HERE%test\test_obj3d_rules.c" "%HERE%src\fw_obj3d_rules.c" "%HERE%src\fw_mesh_rules.c" ^
  -o "%OUT%\test_obj3d_rules.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_obj3d_rules.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_gon.c" "%HERE%src\fw_gon.c" ^
  -o "%OUT%\test_gon.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_gon.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_json.c" "%HERE%src\fw_json.c" ^
  -o "%OUT%\test_json.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_json.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_mesh_gltf.c" "%HERE%src\fw_mesh_gltf.c" "%HERE%src\fw_json.c" "%HERE%src\fw_mesh_rules.c" ^
  -o "%OUT%\test_mesh_gltf.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_mesh_gltf.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_mesh_tex.c" "%HERE%src\fw_mesh_tex.c" "%HERE%src\fw_gl_state.c" "%HERE%src\fw_mesh_rules.c" ^
  -o "%OUT%\test_mesh_tex.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_mesh_tex.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
endlocal
