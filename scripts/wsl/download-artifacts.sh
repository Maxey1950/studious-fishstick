#!/usr/bin/env bash
# Usage: download-artifacts.sh [workflow.yml]  -> artifacts/<run-id>/ from the latest successful run
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; wf="${1:-ci.yml}"
id=$(gh run list --workflow "$wf" --status success --limit 1 --json databaseId -q '.[0].databaseId')
[ -n "$id" ] || { echo "no successful run of $wf"; exit 1; }
gh run download "$id" --dir "$ROOT/artifacts/$id" && echo "Saved to artifacts/$id"
