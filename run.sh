#!/usr/bin/env bash
# Launch mk, building it first if there is nothing to launch.
#
#   ./run.sh [file.md] [--view]      the release build
#   ./run.sh --dev [file.md]         hot-reloading dev build (npm run app)
set -euo pipefail
cd "$(dirname "$0")"

[[ -d node_modules ]] || npm install

if [[ "${1:-}" == "--dev" ]]; then
  shift
  exec npx tauri dev -- -- "$@"
fi

BIN="src-tauri/target/release/mk"
if [[ ! -x "$BIN" ]]; then
  echo "No release binary yet — building it (the first build takes a few minutes)."
  npx tauri build --no-bundle
fi
exec "$BIN" "$@"
