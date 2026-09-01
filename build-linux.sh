#!/usr/bin/env bash
# Builds RiaCore desktop application for Linux (AppImage, x64).
# Output: apps/desktop-host/dist-electron/
#
# Usage:
#   ./build-linux.sh              # full build (install + compile + package)
#   ./build-linux.sh --skip-install

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKIP_INSTALL=false

for arg in "$@"; do
    case "$arg" in
        --skip-install) SKIP_INSTALL=true ;;
        *) echo "[ERROR] Unknown argument: $arg"; exit 1 ;;
    esac
done

step() { echo -e "\n\033[0;36m==> $1\033[0m"; }
err()  { echo -e "\n\033[0;31m[ERROR] $1\033[0m" >&2; exit 1; }

cd "$REPO_ROOT"

step "Checking pnpm"
if ! command -v pnpm &>/dev/null; then
    err "pnpm not found. Install it: https://pnpm.io/installation"
fi
echo "  pnpm $(pnpm --version)"

EXPECTED_NODE_VERSION=$(node -p "require('./package.json').engines.node")
EXPECTED_PNPM_VERSION=$(node -p "require('./package.json').engines.pnpm")
ACTUAL_NODE_VERSION=$(node -p "process.version.slice(1)")
ACTUAL_PNPM_VERSION=$(pnpm --version)

if [ "$ACTUAL_NODE_VERSION" != "$EXPECTED_NODE_VERSION" ]; then
    err "Node $EXPECTED_NODE_VERSION is required; found $ACTUAL_NODE_VERSION"
fi
if [ "$ACTUAL_PNPM_VERSION" != "$EXPECTED_PNPM_VERSION" ]; then
    err "pnpm $EXPECTED_PNPM_VERSION is required; found $ACTUAL_PNPM_VERSION"
fi

if [ "$SKIP_INSTALL" = false ]; then
    step "Installing dependencies from the lockfile"
    pnpm install --frozen-lockfile
fi

step "Building core packages + desktop host + renderer"
pnpm package:desktop:linux

OUT_DIR="$REPO_ROOT/apps/desktop-host/dist-electron"
step "Done - artifacts in: $OUT_DIR"
if [ -d "$OUT_DIR" ]; then
    find "$OUT_DIR" -maxdepth 1 -type f \( -name "*.AppImage" -o -name "*.deb" -o -name "*.rpm" \) \
        -exec ls -lh {} \; | awk '{print $5, $9}'
fi
