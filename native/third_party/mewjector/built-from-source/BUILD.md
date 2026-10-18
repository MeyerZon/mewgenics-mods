# Mewjector v3.5 built from source

Source: github.com/githubuser508/mewjector, commit state of 2026-10-17 (version.c, version.def, mj_lde.h,
copied into tools/mewjector-build/ with their SHA-256 in that folder's build log). Full source audit: see
docs/engine-map.md and the project status page.

Built with Debian clang 14 cross-compiling to x86_64-w64-mingw32 inside a throwaway `node:26-bookworm`
container (tools/mewjector-build/build.sh). Flags of note: `-fms-extensions` (for `__try/__except`) and
`-DERROR_DYNAMIC_CODE_BLOCKED=1655L` (constant missing from the MinGW headers). No source edits.

Result: version.dll, 242,176 bytes, imports KERNEL32.dll and msvcrt.dll only, exports the 17 version.dll
functions plus MJ_AllocTypeIdPair, MJ_GetGameBase, MJ_GetVersion, MJ_InstallHook, MJ_Log, MJ_LookupName,
MJ_QueryHook, MJ_RegisterName, MJ_VerifyHooks. SHA-256 in SHA256SUMS.

The upstream release zip binary (MSVC build, sha256 545694a1...) is NOT used.
