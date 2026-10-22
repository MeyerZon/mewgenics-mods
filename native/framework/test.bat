@echo off
REM Host-side unit tests for mewframework's pure parts (no game, no windows.h): the signature
REM scanner (test_sig), the build gate + GENERATED per-build tables (test_build), the status
REM definition rules / name aliasing (test_status_rules), the custom-status vtable clone + thunks
REM (test_vtable), the entity/component walks + apply/merge writes (test_walk), the load-time
REM policy: symbol resolution, the launch gate, API bounds and the hook plan (test_resolve) and the
REM per-unit glow rules: registry, pruning, layer vector, pass lookup and writes (test_glow_rules) and the
REM phase-0 3D observer: budget, camera/layer/item accessors, log line formats (test_obs3d_rules), the
REM M1 mesh draw: 4x4 maths vs the observed matrices, the std::function functor, GL save/restore, probe rules (test_mesh_draw), the 3D-object
REM registry + model matrix + the API v6 layout (test_obj3d_rules) and the GON walker / graphics.model seam, string and block forms (test_gon), the per-unit
REM models: units walk, seen set, block transform, facing, log line (test_unit_model).
REM phase-M mesh rules: OBJ parser, game axes, unit cube, model registry, model paths (test_mesh_rules), the
REM JSON tokenizer (test_json), the glTF 2.0 loader (test_mesh_gltf) and the mesh texture / palette rules (test_mesh_tex).
REM JSON tokenizer (test_json), the glTF 2.0 loader (test_mesh_gltf) and the M2 sprite/mesh painter order + camera filter (test_mesh_order), M3 hide_sprite: decision, set, the wrapping filter (test_mesh_hide).
REM and the M3 unit model facing: Character::Face direction -> model yaw (test_unit_face).
REM M3: the PNG decoder for a .glb's embedded image (test_png) and the embedded model texture: precedence, decode, upload (test_mesh_embtex).
REM JSON tokenizer (test_json), the glTF 2.0 loader (test_mesh_gltf) and the M2 sprite/mesh painter order + camera filter (test_mesh_order)
REM and the M3 unit palette row: a cat's CatParts row for a GON `palette true` model (test_unit_palette).
REM JSON tokenizer (test_json), the glTF 2.0 loader (test_mesh_gltf) and the M2 sprite/mesh painter order + camera filter (test_mesh_order),
REM the M3 per-band mesh slices: depth range, band plan, visible area, tints, probe tile, log line (test_mesh_slice).
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
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_mesh_rules.c" "%HERE%src\fw_mesh_rules.c" ^
  -o "%OUT%\test_mesh_rules.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_mesh_rules.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_obj3d_rules.c" "%HERE%src\fw_obj3d_rules.c" "%HERE%src\fw_unit_face.c" "%HERE%src\fw_mesh_rules.c" ^
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
  "%HERE%test\test_unit_model.c" "%HERE%src\fw_unit_model.c" "%HERE%src\fw_gon.c" ^
  -o "%OUT%\test_unit_model.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_unit_model.exe"
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
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_mesh_order.c" "%HERE%src\fw_mesh_order.c" "%HERE%src\fw_functor.c" ^
  -o "%OUT%\test_mesh_order.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_mesh_order.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_mesh_hide.c" "%HERE%src\fw_mesh_hide.c" "%HERE%src\fw_mesh_order.c" "%HERE%src\fw_functor.c" "%HERE%src\fw_obj3d_rules.c" "%HERE%src\fw_unit_face.c" "%HERE%src\fw_mesh_rules.c" ^
  -o "%OUT%\test_mesh_hide.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_mesh_hide.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_unit_face.c" "%HERE%src\fw_unit_face.c" "%HERE%src\fw_unit_model.c" "%HERE%src\fw_gon.c" ^
  -o "%OUT%\test_unit_face.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_unit_face.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_png.c" "%HERE%src\fw_png.c" ^
  -o "%OUT%\test_png.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_png.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_mesh_embtex.c" "%HERE%src\fw_mesh_embtex.c" "%HERE%src\fw_png.c" "%HERE%src\fw_mesh_rules.c" "%HERE%src\fw_mesh_gltf.c" "%HERE%src\fw_json.c" ^
  -o "%OUT%\test_mesh_embtex.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_mesh_embtex.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_model_names.c" "%HERE%src\fw_model_names.c" "%HERE%src\fw_gon.c" "%HERE%src\fw_mesh_rules.c" ^
  -o "%OUT%\test_model_names.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_model_names.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_unit_palette.c" "%HERE%src\fw_unit_palette.c" "%HERE%src\fw_gon.c" ^
  -o "%OUT%\test_unit_palette.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_unit_palette.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
"%GCC%" -std=c11 -O1 -g -Wall -Wextra -Werror -I"%HERE%src" ^
  "%HERE%test\test_mesh_slice.c" "%HERE%src\fw_mesh_slice.c" "%HERE%src\fw_mesh_order.c" "%HERE%src\fw_functor.c" ^
  -o "%OUT%\test_mesh_slice.exe"
if errorlevel 1 ( echo TEST BUILD FAILED & exit /b 1 )
"%OUT%\test_mesh_slice.exe"
if not "%errorlevel%"=="0" ( echo TESTS FAILED & exit /b 1 )
endlocal
