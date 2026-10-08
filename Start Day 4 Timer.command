#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
TIMER_URL="http://localhost:3000/"

fail() {
  printf '\n%s\n' "$1" >&2
  if [ -t 0 ]; then
    read -r -p "Press Return to close this window. " _
  fi
  exit 1
}

timer_ready() {
  curl --noproxy '*' --fail --silent --max-time 2 "$TIMER_URL" 2>/dev/null |
    grep '<title>Day 4 Protocol Timer</title>' >/dev/null
}

open_timer() {
  if [ -z "${DAY4_TIMER_NO_BROWSER:-}" ]; then
    open "$TIMER_URL"
  fi
}

if timer_ready; then
  open_timer
  exit 0
fi

# Finder does not inherit the PATH from an interactive Terminal session.
if ! command -v node >/dev/null 2>&1; then
  bundled_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
  if [ -x "$bundled_node/node" ]; then
    export PATH="$bundled_node:$PATH"
  fi
fi
command -v node >/dev/null 2>&1 ||
  fail "Node.js was not found. Install Node.js 22.13 or newer, then open this file again."
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)' ||
  fail "This timer needs Node.js 22.13 or newer. Update Node.js, then open this file again."

runtime_key="$(node -p 'process.platform + "-" + process.arch + "-" + process.versions.node.split(".")[0]') $(cksum package.json pnpm-lock.yaml pnpm-workspace.yaml)"
installed_key="$(cat node_modules/.day4-runtime 2>/dev/null || true)"
if [ "$installed_key" != "$runtime_key" ] || [ ! -f node_modules/vinext/dist/cli.js ]; then
  if ! command -v pnpm >/dev/null 2>&1; then
    bundled_pnpm="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback"
    if [ -x "$bundled_pnpm/pnpm" ]; then
      export PATH="$bundled_pnpm:$PATH"
    fi
  fi
  command -v pnpm >/dev/null 2>&1 ||
    fail "pnpm was not found. Run 'npm install -g pnpm' in Terminal, then open this file again."

  printf '\nPreparing the Day 4 timer for this Mac. First-time setup needs internet access.\n'
  # Moving a copied installation avoids hydrating every old file in OneDrive.
  if [ -d node_modules ] && [ ! -f node_modules/.day4-runtime ]; then
    mkdir -p .pnpm-store
    backup_directory="$(mktemp -d .pnpm-store/previous-dependencies.XXXXXX)"
    mv node_modules "$backup_directory/node_modules"
  fi
  # Reinstall native packages when this folder has been copied from Windows.
  CI=true pnpm install --force --frozen-lockfile --store-dir .pnpm-store ||
    fail "Setup did not finish. Check the internet connection and the error above, then try again."
  printf '%s\n' "$runtime_key" > node_modules/.day4-runtime
fi

printf '\nStarting the Day 4 Protocol Timer...\nKeep this Terminal window open while using the timer.\nPress Ctrl+C here when finished.\n\n'

server_pid=""
cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

node node_modules/vinext/dist/cli.js dev --hostname localhost --port 3000 &
server_pid=$!

ready=false
for ((attempt = 0; attempt < 120; attempt++)); do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    fail "The timer could not start. Check the error above (another app may be using port 3000)."
  fi
  if timer_ready; then
    ready=true
    break
  fi
  sleep 0.5
done
[ "$ready" = true ] || fail "The timer did not become ready. Check the error above, then try again."
open_timer
wait "$server_pid" || fail "The Day 4 timer stopped unexpectedly. Check the error above."
