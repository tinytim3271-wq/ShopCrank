#!/usr/bin/env bash
# Start the local PWA and the offline Worker. Safe to run more than once.
set -eo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -f "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use 24 >/dev/null
  NODE24_BIN="$(dirname "$(nvm which 24)")"
  export PATH="$NODE24_BIN:$PATH"
  hash -r
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required to start the ShopCrank dev servers" >&2
  exit 1
fi

listening() {
  curl -sf --max-time 2 "$1" >/dev/null 2>&1
}

# Restart a named session only when its URL is not already healthy.
ensure_session() {
  local name="$1"
  local url="$2"
  shift 2
  if listening "$url"; then
    echo "$name already responding at $url"
    return 0
  fi
  if tmux has-session -t "$name" 2>/dev/null; then
    tmux kill-session -t "$name"
  fi
  tmux new-session -d -s "$name" -c "$ROOT" -- "$@"
  echo "started $name"
}

# Source nvm inside the session. A tmux server started earlier will not
# inherit the Node 24 PATH from this script.
if listening "http://127.0.0.1:8787/api/healthz"; then
  echo "worker-api already responding at http://127.0.0.1:8787/api/healthz"
else
  if tmux has-session -t worker-api 2>/dev/null; then
    tmux kill-session -t worker-api
  fi
  tmux new-session -d -s worker-api -c "$ROOT" -- bash -lc 'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; if [ -f "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null; NODE24_BIN="$(dirname "$(nvm which 24)")"; export PATH="$NODE24_BIN:$PATH"; hash -r; fi; exec npm run dev:worker -- --ip 127.0.0.1 --port 8787'
  echo "started worker-api"
fi

wait_for() {
  local url="$1"
  local tries="$2"
  local session="$3"
  local i
  for i in $(seq 1 "$tries"); do
    if listening "$url"; then
      echo "ready $url"
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for $url" >&2
  if [ -n "$session" ]; then
    tmux capture-pane -pt "$session" -S -120 >&2 || true
  fi
  return 1
}

wait_for "http://127.0.0.1:8787/api/healthz" 120 worker-api
ensure_session frontend "http://127.0.0.1:3000/api/healthz" \
  "$(command -v node)" scripts/dev-frontend.mjs
wait_for "http://127.0.0.1:3000/api/healthz" 30 frontend
