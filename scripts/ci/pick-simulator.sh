#!/usr/bin/env bash
# Prints the UDID of an available iPhone simulator (booted first, else newest runtime).
set -euo pipefail
xcrun simctl list devices available -j | python3 -c '
import json,sys
d=json.load(sys.stdin)["devices"]
c=[(rt,x["udid"]) for rt,l in d.items() if "iOS" in rt for x in l if x["name"].startswith("iPhone")]
if not c: sys.exit("no iPhone simulator available")
c.sort(key=lambda t:[int(p) for p in __import__("re").findall(r"\d+",t[0])])
print(c[-1][1])'
