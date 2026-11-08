#!/usr/bin/env bash
# Usage: clean.sh [--all]   (--all also removes downloaded upstream sources and artifacts)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
rm -rf "$ROOT/build" "$ROOT/third_party/out" "$ROOT/iDeviceKit.xcodeproj"
[ "${1:-}" = "--all" ] && rm -rf "$ROOT/third_party/src" "$ROOT/artifacts"
echo cleaned
