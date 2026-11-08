#!/usr/bin/env bash
# Combine device + simulator slices into third_party/out/IDeviceKitNative.xcframework
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; O="$ROOT/third_party/out"
rm -rf "$O/IDeviceKitNative.xcframework"
xcodebuild -create-xcframework \
  -library "$O/device/libIDeviceKitNative.a"    -headers "$O/device/include" \
  -library "$O/simulator/libIDeviceKitNative.a" -headers "$O/simulator/include" \
  -output "$O/IDeviceKitNative.xcframework"
find "$O/IDeviceKitNative.xcframework" -maxdepth 2 | sort
