#!/usr/bin/env bash
# Usage: trigger-ci.sh [ci.yml|release-ipa.yml] [ref]
set -euo pipefail
wf="${1:-ci.yml}"; ref="${2:-$(git rev-parse --abbrev-ref HEAD)}"
gh workflow run "$wf" --ref "$ref"
sleep 5; gh run list --workflow "$wf" --limit 1
echo "Watch: gh run watch \$(gh run list --workflow $wf --limit 1 --json databaseId -q '.[0].databaseId')"
