#!/usr/bin/env bash
# Clone the pinned official upstream tags into third_party/src (shallow).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; . "$ROOT/third_party/versions.env"
SRC="$ROOT/third_party/src"; mkdir -p "$SRC"
get() { # name repo tag
  if [ -d "$SRC/$1/.git" ]; then echo "$1 present"; return; fi
  git clone --depth 1 --branch "$3" "https://github.com/$2.git" "$SRC/$1"
}
get libplist libimobiledevice/libplist "$LIBPLIST_TAG"
get libimobiledevice-glue libimobiledevice/libimobiledevice-glue "$LIBGLUE_TAG"
get libusbmuxd libimobiledevice/libusbmuxd "$LIBUSBMUXD_TAG"
get libimobiledevice libimobiledevice/libimobiledevice "$LIBIMOBILEDEVICE_TAG"
get openssl openssl/openssl "$OPENSSL_TAG"
get libtatsu libimobiledevice/libtatsu "$LIBTATSU_TAG"
get curl curl/curl "$CURL_TAG"
