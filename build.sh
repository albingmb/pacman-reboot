#!/usr/bin/env bash
# Compile src/pacman.c en pacman.wasm (WebAssembly pur, aucune bibliothèque).
# Prérequis : zig (pip install ziglang) ou clang avec la cible wasm32.
set -euo pipefail
cd "$(dirname "$0")"

if command -v zig >/dev/null 2>&1; then
  CC=(zig cc)
elif command -v clang >/dev/null 2>&1; then
  CC=(clang)
else
  echo "Erreur : il faut 'zig' (pip install ziglang) ou 'clang' pour compiler." >&2
  exit 1
fi

"${CC[@]}" -target wasm32-freestanding -O2 -nostdlib \
  -Wl,--no-entry -Wl,--export-memory -Wl,--initial-memory=1048576 -Wl,-z,stack-size=65536 \
  -o pacman.wasm src/pacman.c

echo "OK -> pacman.wasm ($(stat -c%s pacman.wasm) octets)"
