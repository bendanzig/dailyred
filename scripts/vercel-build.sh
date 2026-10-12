#!/usr/bin/env bash
# Builds the static site for Vercel: recreate the patched decompilation,
# download the self-hosted web dependencies, build the ROM, and leave the
# finished site in web/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

"$ROOT/scripts/setup-linux.sh"

if [ ! -d "$ROOT/pokefirered/.git" ]; then
  "$ROOT/scripts/get-pokefirered.sh"
fi

"$ROOT/scripts/fetch-vendor.sh"
"$ROOT/scripts/build-rom.sh"

echo
echo "Vercel build output is ready in $ROOT/web"
