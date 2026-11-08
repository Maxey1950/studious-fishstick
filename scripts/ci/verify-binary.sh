#!/usr/bin/env bash
# Usage: verify-binary.sh <App.app> <device|simulator>
# Fails if the Mach-O is not arm64 for the expected platform (guards against ELF / wrong-SDK output).
set -euo pipefail
app="$1"; want="$2"
exe="$app/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Info.plist")"
file "$exe"
file "$exe" | grep -q 'Mach-O' || { echo "not Mach-O"; exit 1; }
plat=$(vtool -show-build "$exe" | awk '/platform/ {print $2; exit}')
echo "platform=$plat"
case "$want" in
  device)    [ "$plat" = "IOS" ] || { echo "expected IOS device binary"; exit 1; }
             lipo -archs "$exe" | grep -qw arm64 || { echo "no arm64 slice"; exit 1; } ;;
  simulator) [ "$plat" = "IOSSIMULATOR" ] || { echo "expected IOSSIMULATOR binary"; exit 1; } ;;
esac
echo "OK: $want binary"
