set -u
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq clang lld mingw-w64 mingw-w64-tools >/dev/null 2>&1; echo "apt-exit: $?"
clang --version | head -1
cd /work/src
# clang cross-compiling to MinGW-w64 x64; SEH (__try/__except) is supported by clang on this target.
clang --target=x86_64-w64-mingw32 -fuse-ld=lld -O2 -shared -fms-extensions -DERROR_DYNAMIC_CODE_BLOCKED=1655L -D_CRT_SECURE_NO_WARNINGS -Wno-unused-function \
  --sysroot=/usr/x86_64-w64-mingw32 -I/usr/x86_64-w64-mingw32/include \
  -L/usr/x86_64-w64-mingw32/lib -L/usr/lib/gcc/x86_64-w64-mingw32/12-win32 \
  version.c version.def -o /work/out/version.dll -lkernel32 -luser32 -lpsapi -static -static-libgcc 2>&1 | grep -vE "^$" | head -40
echo "build-exit: ${PIPESTATUS[0]}"
ls -la /work/out
test -f /work/out/version.dll && x86_64-w64-mingw32-objdump -p /work/out/version.dll | grep -E "DLL Name|^\s+\[ *[0-9]+\] " | head -60
test -f /work/out/version.dll && sha256sum /work/out/version.dll
