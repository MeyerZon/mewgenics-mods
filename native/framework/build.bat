@echo off
REM Build mewframework.dll with w64devkit GCC (no MSVC required).
setlocal
if not defined GCC set "GCC=C:\raylib\w64devkit\bin\gcc.exe"
set "HERE=%~dp0"
set "TP=%HERE%..\third_party"
set "OUT=%HERE%build"
if not exist "%OUT%" mkdir "%OUT%"
"%GCC%" -std=c11 -O2 -Wall -Wextra -Wno-cast-function-type -Wno-type-limits -shared -static -static-libgcc ^
  -DFW_BUILDING -DMJ_IMPLEMENTATION ^
  -I"%HERE%src" -I"%TP%\mewjector" -I"%TP%\minhook\include" ^
  "%HERE%src\framework.c" "%HERE%src\status_engine.c" "%HERE%src\glow_engine.c" "%HERE%src\obs3d_engine.c" "%HERE%src\fw_sig.c" "%HERE%src\fw_build.c" "%HERE%src\fw_status_rules.c" "%HERE%src\fw_vtable.c" "%HERE%src\fw_walk.c" "%HERE%src\fw_resolve.c" "%HERE%src\fw_glow_rules.c" "%HERE%src\fw_obs3d_rules.c" ^
  "%HERE%src\mesh_engine.c" "%HERE%src\fw_m4.c" "%HERE%src\fw_functor.c" "%HERE%src\fw_gl_state.c" "%HERE%src\fw_mesh_draw.c" "%HERE%src\fw_mesh_rules.c" ^
  "%TP%\minhook\src\buffer.c" "%TP%\minhook\src\hook.c" "%TP%\minhook\src\trampoline.c" "%TP%\minhook\src\hde\hde64.c" ^
  -o "%OUT%\mewframework.dll" -Wl,--out-implib,"%OUT%\libmewframework.a"
if errorlevel 1 ( echo BUILD FAILED & exit /b 1 )
echo built %OUT%\mewframework.dll
endlocal
