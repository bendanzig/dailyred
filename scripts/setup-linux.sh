#!/usr/bin/env bash
# Installs everything needed to build the Daily Red ROM on Linux, into
# ./.toolchain (no sudo, no apt packages, nothing written outside this
# project):
#
#   - xPack GNU Arm Embedded GCC (arm-none-eabi-gcc + binutils + newlib),
#     used by pokefirered's `modern` build target via TOOLCHAIN=...
#   - libpng (static), needed by pokefirered/tools/gbagfx
#
# Re-running is safe: finished steps are skipped.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TC="$ROOT/.toolchain"
mkdir -p "$TC/downloads"

GCC_VER="14.2.1-1.1"
LIBPNG_VER="1.6.44"

case "$(uname -m)" in
  x86_64) GCC_HOST="linux-x64" ;;
  aarch64|arm64) GCC_HOST="linux-arm64" ;;
  *) echo "Unsupported CPU: $(uname -m)"; exit 1 ;;
esac

sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

# --- arm-none-eabi GCC --------------------------------------------------------
GCC_NAME="xpack-arm-none-eabi-gcc-$GCC_VER"
if [ ! -x "$TC/arm-none-eabi/bin/arm-none-eabi-gcc" ]; then
  tarball="$GCC_NAME-$GCC_HOST.tar.gz"
  url="https://github.com/xpack-dev-tools/arm-none-eabi-gcc-xpack/releases/download/v$GCC_VER/$tarball"
  echo ">> Downloading $tarball"
  curl -fL --retry 3 -o "$TC/downloads/$tarball" "$url"
  curl -fsL -o "$TC/downloads/$tarball.sha" "$url.sha"
  expected="$(awk '{print $1}' "$TC/downloads/$tarball.sha")"
  actual="$(sha256 "$TC/downloads/$tarball")"
  [ "$expected" = "$actual" ] || { echo "Checksum mismatch for $tarball"; exit 1; }
  echo ">> Checksum OK, extracting"
  tar -xzf "$TC/downloads/$tarball" -C "$TC"
  rm -f "$TC/arm-none-eabi"
  ln -s "$GCC_NAME" "$TC/arm-none-eabi"
  rm -f "$TC/downloads/$tarball"
fi
"$TC/arm-none-eabi/bin/arm-none-eabi-gcc" --version | head -1
# Fail early if the compiler can't actually run.
echo 'int f(void){return 0;}' | "$TC/arm-none-eabi/bin/arm-none-eabi-gcc" -x c -c -o /dev/null -

# --- libpng (static, built with the system compiler) -------------------------
if [ ! -f "$TC/libpng/lib/libpng.a" ]; then
  echo ">> Building libpng $LIBPNG_VER"
  src="$TC/downloads/libpng-$LIBPNG_VER"
  rm -rf "$src"
  curl -fL --retry 3 -o "$src.tar.gz" \
    "https://github.com/pnggroup/libpng/archive/refs/tags/v$LIBPNG_VER.tar.gz"
  tar -xzf "$src.tar.gz" -C "$TC/downloads"
  cp "$src/scripts/pnglibconf.h.prebuilt" "$src/pnglibconf.h"
  mkdir -p "$TC/libpng/include" "$TC/libpng/lib" "$src/obj"
  # Disable the optional SIMD paths so no extra arch-specific sources are needed.
  for f in png pngerror pngget pngmem pngpread pngread pngrio pngrtran pngrutil \
           pngset pngtrans pngwio pngwrite pngwtran pngwutil; do
    cc -O2 -DPNG_ARM_NEON_OPT=0 -DPNG_INTEL_SSE_OPT=0 -I"$src" \
       -c "$src/$f.c" -o "$src/obj/$f.o"
  done
  ar rcs "$TC/libpng/lib/libpng.a" "$src"/obj/*.o
  cp "$src/png.h" "$src/pngconf.h" "$src/pnglibconf.h" "$TC/libpng/include/"
fi
if [ ! -f "$TC/libpng/lib/libpng.so" ]; then
  cat > "$TC/libpng/lib/libpng.so" <<'EOF'
INPUT ( libpng.a -lz -lm )
EOF
fi
echo ">> libpng: $TC/libpng/lib/libpng.a"

echo
echo "Toolchain ready. Build with: scripts/build-rom.sh"
