#!/usr/bin/env bash
set -euo pipefail

# Compile the Rust AMM hot-path to WASM and generate JS/TS bindings.
# Prerequisites: cargo, wasm-pack
#   curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "[rust-wasm] building release WASM..."
wasm-pack build --target web --release --out-dir pkg

echo "[rust-wasm] done — bindings written to rust-wasm/pkg/"
echo "  Import in TypeScript: import init, { get_amount_out, find_optimal_amount_in } from '../rust-wasm/pkg/amm_wasm'"
