#!/usr/bin/env bash
# Cross-compile OpenSSL + libplist + libimobiledevice-glue + libusbmuxd + libimobiledevice
# as STATIC arm64 libraries for one slice. Needs macOS + Xcode + brew (autoconf automake libtool pkg-config).
# Usage: build-deps.sh device|simulator     Output: third_party/out/<slice>/{include,lib,libIDeviceKitNative.a}
set -euo pipefail
SLICE="${1:?usage: $0 device|simulator}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; . "$ROOT/third_party/versions.env"
MINIOS="${MINIOS:-16.0}"
case "$SLICE" in
  device)    SDKNAME=iphoneos;        TARGET="arm64-apple-ios${MINIOS}";           WANT_PLAT=IOS ;;
  simulator) SDKNAME=iphonesimulator; TARGET="arm64-apple-ios${MINIOS}-simulator"; WANT_PLAT=IOSSIMULATOR ;;
  *) echo "slice must be device|simulator"; exit 2 ;;
esac
SDK="$(xcrun --sdk "$SDKNAME" --show-sdk-path)"
PREFIX="$ROOT/third_party/out/$SLICE"; WORK="$ROOT/build/deps-$SLICE"
rm -rf "$PREFIX" "$WORK"; mkdir -p "$PREFIX" "$WORK"
"$ROOT/scripts/wsl/fetch-upstream.sh"   # plain git; works on macOS too

# GNU libtoolize name on Homebrew
export PATH="$(brew --prefix libtool)/libexec/gnubin:$PATH"
CLANG="$(xcrun --sdk "$SDKNAME" -f clang)"
export CC="$CLANG -target $TARGET -isysroot $SDK"
export CFLAGS="-O2 -g0"
export AR="$(xcrun --sdk "$SDKNAME" -f ar)" RANLIB="$(xcrun --sdk "$SDKNAME" -f ranlib)"
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig" PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
# cross-compile autoconf cache answers
export ac_cv_func_malloc_0_nonnull=yes ac_cv_func_realloc_0_nonnull=yes
JOBS="$(sysctl -n hw.ncpu)"

copy_src() { cp -R "$ROOT/third_party/src/$1" "$WORK/$1"; cd "$WORK/$1"; }

echo "=== openssl ($SLICE)"
copy_src openssl
./Configure darwin64-arm64-cc no-shared no-tests no-async no-dso --prefix="$PREFIX" --openssldir="$PREFIX/ssl" >/dev/null
make -j"$JOBS" build_libs >/dev/null
make install_dev >/dev/null

echo "=== curl ($SLICE)"
copy_src curl
autoreconf -fi >/dev/null 2>&1
./configure --host=aarch64-apple-darwin --prefix="$PREFIX" --enable-static --disable-shared \
  --with-openssl="$PREFIX" --without-libpsl --without-brotli --without-zstd --without-nghttp2 \
  --without-libidn2 --without-libssh2 --without-librtmp --disable-ldap --disable-ldaps \
  --disable-docs --disable-manual --disable-debug --disable-curldebug \
  >"$WORK/curl.configure.log" 2>&1 || { tail -n 60 "$WORK/curl.configure.log"; exit 1; }
make -C lib -j"$JOBS" >/dev/null
make -C lib install >/dev/null
make -C include install >/dev/null
make install-pkgconfigDATA >/dev/null
# zlib is provided by the iOS SDK (libz.tbd); give pkg-config a stub so libcurl.pc resolves.
mkdir -p "$PREFIX/lib/pkgconfig"
printf 'Name: zlib\nDescription: iOS SDK zlib\nVersion: 1.2.12\nLibs: -lz\n' > "$PREFIX/lib/pkgconfig/zlib.pc"

for p in libplist libimobiledevice-glue libusbmuxd libtatsu libimobiledevice; do
  echo "=== $p ($SLICE)"
  copy_src "$p"
  NOCONFIGURE=1 ./autogen.sh >/dev/null
  extra=()
  case "$p" in libplist|libimobiledevice) extra+=(--without-cython) ;; esac
  ./configure --host=aarch64-apple-darwin --prefix="$PREFIX" --enable-static --disable-shared \
              --disable-silent-rules ${extra[@]+"${extra[@]}"} >"$WORK/$p.configure.log" 2>&1 \
    || { tail -n 60 "$WORK/$p.configure.log"; exit 1; }
  # Build only the library + headers (skip CLI tools: they are not usable on iOS and are GPL).
  for d in libcnary common; do [ -d "$d" ] && make -C "$d" -j"$JOBS" >/dev/null; done
  make -C src -j"$JOBS" >/dev/null
  make -C src install >/dev/null
  [ -d include ] && make -C include install >/dev/null
  make install-pkgconfigDATA >/dev/null 2>&1 || true
done

echo "=== merge"
LIBS=("$PREFIX"/lib/libplist-2.0.a "$PREFIX"/lib/libimobiledevice-glue-1.0.a "$PREFIX"/lib/libusbmuxd-2.0.a \
      "$PREFIX"/lib/libimobiledevice-1.0.a "$PREFIX"/lib/libtatsu-1.0.a "$PREFIX"/lib/libcurl.a "$PREFIX"/lib/libssl.a "$PREFIX"/lib/libcrypto.a)
for l in "${LIBS[@]}"; do [ -f "$l" ] || { echo "missing $l"; ls "$PREFIX/lib"; exit 1; }; done
/usr/bin/libtool -static -o "$PREFIX/libIDeviceKitNative.a" "${LIBS[@]}"

echo "=== verify"
V="$WORK/verify"; mkdir -p "$V"; cd "$V"; ar x "$PREFIX/lib/libimobiledevice-1.0.a"
obj="$(ls ./*.o | head -n1)"
plat="$(vtool -show-build "$obj" | awk '/platform/ {print $2; exit}')"
echo "archs: $(lipo -archs "$PREFIX/libIDeviceKitNative.a")  platform: $plat"
[ "$plat" = "$WANT_PLAT" ] || { echo "WRONG PLATFORM (wanted $WANT_PLAT)"; exit 1; }
lipo -archs "$PREFIX/libIDeviceKitNative.a" | grep -qw arm64
nm -g "$PREFIX/libIDeviceKitNative.a" 2>/dev/null | grep -q ' T _idevice_new' || { echo "idevice_new missing"; exit 1; }
echo "OK $SLICE"
