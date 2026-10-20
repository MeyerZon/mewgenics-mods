#!/usr/bin/env sh
# Builds and runs every host-side native test suite (tier T0 for native/) with a plain gcc — the POSIX twin of
# test-all.bat, used by CI (ubuntu-latest) and usable locally from Git Bash (GCC=/c/raylib/w64devkit/bin/gcc.exe).
# The suites are pure C11 (no windows.h, no game): fw_build.c reaches framework_api.h, which only includes
# <windows.h> unless FW_NO_WINDOWS is defined, so that block passes -DFW_NO_WINDOWS.
# Stops at the first failing suite; exit code 1 on any failure.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
GCC=${GCC:-gcc}
CFLAGS="-std=c11 -O1 -g -Wall -Wextra -Werror"
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
run_suite "mewtest harness pure modules" "$HS/build/test_mewtest" -DMT_HOST_TEST -I"$HS/src" "$HS/test/test_mewtest.c" \
  "$HS/src/mt_jsonl.c" "$HS/src/mt_args.c" "$HS/src/mt_msvcstr.c" "$HS/src/mt_script.c" "$HS/src/mt_console.c" "$HS/src/mt_runner.c" "$HS/src/mt_exit.c"
echo "=== all native suites passed"
