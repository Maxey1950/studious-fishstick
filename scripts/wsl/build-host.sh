#!/usr/bin/env bash
# Build Linux host-side libs + CLI tools (ideviceinfo, idevice_id, ...) into third_party/out/host.
# Useful for testing a real device from WSL (needs usbipd-win to pass USB into WSL2) and as a
# reference when comparing with the iOS build. These are Linux ELF binaries: NEVER packaged into the IPA.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; SRC="$ROOT/third_party/src"; PREFIX="$ROOT/third_party/out/host"
[ -d "$SRC/libplist" ] || "$ROOT/scripts/wsl/fetch-upstream.sh"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" PATH="$PREFIX/bin:$PATH"
for p in libplist libimobiledevice-glue libusbmuxd libimobiledevice; do
  echo "=== $p"; cd "$SRC/$p"
  [ -x configure ] || NOCONFIGURE=1 ./autogen.sh
  ./configure --prefix="$PREFIX" --without-cython --disable-static --enable-shared >/dev/null
  make -j"$(nproc)" >/dev/null && make install >/dev/null
done
echo "Installed to $PREFIX/bin: $(ls "$PREFIX/bin" | tr '\n' ' ')"
