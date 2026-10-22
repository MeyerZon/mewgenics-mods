#!/usr/bin/env sh
# Builds and runs every host-side native test suite (tier T0 for native/) with a plain gcc — the POSIX twin of
# test-all.bat, used by CI (ubuntu-latest) and usable locally from Git Bash (GCC=/c/raylib/w64devkit/bin/gcc.exe).
# The suites are pure C11 (no windows.h, no game): fw_build.c reaches framework_api.h, which only includes
# <windows.h> unless FW_NO_WINDOWS is defined, so that block passes -DFW_NO_WINDOWS.
# Stops at the first failing suite; exit code 1 on any failure.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
GCC=${GCC:-gcc}
# -Wno-format-truncation: Ubuntu gcc builds with _FORTIFY_SOURCE and flags the deliberately bounded snprintf()s into
# MtArgs.err[128] (a truncated error message is the intent); w64devkit gcc does not.
CFLAGS="-std=c11 -O1 -g -Wall -Wextra -Werror -Wno-format-truncation"
FW="$HERE/framework"
HS="$HERE/mods/test-harness"

run_suite() { # name, output, sources...
  name=$1; out=$2; shift 2
  echo "=== $name"
  if ! "$GCC" $CFLAGS "$@" -o "$out"; then echo "TEST BUILD FAILED"; exit 1; fi
  if ! "$out"; then echo "TESTS FAILED"; exit 1; fi
}

mkdir -p "$FW/build" "$HS/build"
run_suite "mewframework signature scanner" "$FW/build/test_sig" -I"$FW/src" "$FW/test/test_sig.c" "$FW/src/fw_sig.c"
run_suite "mewframework build gate + generated tables" "$FW/build/test_build" -DFW_NO_WINDOWS= -I"$FW/src" "$FW/test/test_build.c" "$FW/src/fw_build.c" "$FW/src/fw_sig.c"
run_suite "mewframework status rules" "$FW/build/test_status_rules" -DFW_NO_WINDOWS= -I"$FW/src" "$FW/test/test_status_rules.c" "$FW/src/fw_status_rules.c"
run_suite "mewframework vtable clone + thunks" "$FW/build/test_vtable" -DFW_NO_WINDOWS= -I"$FW/src" "$FW/test/test_vtable.c" "$FW/src/fw_vtable.c" "$FW/src/fw_status_rules.c"
run_suite "mewframework entity/component walks" "$FW/build/test_walk" -DFW_NO_WINDOWS= -I"$FW/src" "$FW/test/test_walk.c" "$FW/src/fw_walk.c"
run_suite "mewframework resolve + hook plan" "$FW/build/test_resolve" -DFW_NO_WINDOWS= -I"$FW/src" "$FW/test/test_resolve.c" "$FW/src/fw_resolve.c" "$FW/src/fw_sig.c"
run_suite "mewtest harness pure modules" "$HS/build/test_mewtest" -DMT_HOST_TEST -I"$HS/src" -I"$FW/src" "$HS/test/test_mewtest.c" \
  "$HS/src/mt_jsonl.c" "$HS/src/mt_args.c" "$HS/src/mt_msvcstr.c" "$HS/src/mt_script.c" "$HS/src/mt_console.c" "$HS/src/mt_runner.c" "$HS/src/mt_exit.c" "$HS/src/mt_queue.c" "$HS/src/mt_gon.c"
echo "=== all native suites passed"
