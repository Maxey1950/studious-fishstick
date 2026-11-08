#!/usr/bin/env bash
# Initial setup for Ubuntu 24.04 (WSL2). Installs host build deps + GitHub CLI + lint tools.
set -euo pipefail
sudo apt-get update
sudo apt-get install -y build-essential git curl ca-certificates pkg-config autoconf automake libtool \
  m4 python3 python3-yaml python3-pip cython3 libssl-dev libusb-1.0-0-dev libreadline-dev socat \
  yamllint shellcheck unzip zip
if ! command -v gh >/dev/null; then
  sudo mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update && sudo apt-get install -y gh
fi
echo "Done. Next: 'gh auth login', then scripts/wsl/fetch-upstream.sh"
