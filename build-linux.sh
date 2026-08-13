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

if [ "$SKIP_INSTALL" = false ]; then
    step "Installing / updating dependencies"
    pnpm install
fi

step "Building core packages + desktop host + renderer"
pnpm package:desktop:linux

OUT_DIR="$REPO_ROOT/apps/desktop-host/dist-electron"
step "Done - artifacts in: $OUT_DIR"
if [ -d "$OUT_DIR" ]; then
    find "$OUT_DIR" -maxdepth 1 -type f \( -name "*.AppImage" -o -name "*.deb" -o -name "*.rpm" \) \
        -exec ls -lh {} \; | awk '{print $5, $9}'
fi
