#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for the Shop Crank repository.
set -eo pipefail

cd "$(dirname "$0")/.."

# Node 24 to match .github/workflows/cloudflare-pages.yml and AGENTS.md.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -f "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install 24
  nvm alias default 24
  nvm use 24
  # /exec-daemon/node is ahead of nvm on Cloud Agent PATH and is not Node 24.
  NODE24_BIN="$(dirname "$(nvm which 24)")"
  export PATH="$NODE24_BIN:$PATH"
  hash -r
else
  echo "nvm not found at $NVM_DIR/nvm.sh; using existing Node on PATH" >&2
fi
echo "Using Node $(node -v) / npm $(npm -v)"
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$node_major" -lt 24 ]; then
  echo "ShopCrank requires Node 24 or newer; found $(node -v)" >&2
  exit 1
fi

# Login shells (install/start use bash -l) otherwise keep resolving node to
# /exec-daemon/node. Failure here is non-fatal: this script already prepends.
if [ -n "${NODE24_BIN:-}" ] && sudo -n tee /etc/profile.d/shopcrank-node24.sh >/dev/null <<'EOF'
# Prefer the Node 24 installed by .cursor/install.sh over /exec-daemon/node.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use 24 >/dev/null
  NODE24_BIN="$(dirname "$(nvm which 24)")"
  export PATH="$NODE24_BIN:$PATH"
fi
EOF
then
  echo "Installed /etc/profile.d/shopcrank-node24.sh"
fi

# Install dependencies and refresh the committed web bundle (app.js) from src/.
npm ci
npm run build:web

# Ephemeral ECDSA P-256 key pair for signing diagnostics capability tokens.
# The Worker signs with the private key; diagnostic hosts verify with the public
# key (and cannot mint tokens). Both files are gitignored (dev only).
KEY_DIR="diagnostics/keys"
DIAG_PRIV="$KEY_DIR/local-capability-private-key.pem"
DIAG_PUB="$KEY_DIR/local-capability-public-key.pem"
mkdir -p "$KEY_DIR"
if [ ! -f "$DIAG_PRIV" ] || [ ! -f "$DIAG_PUB" ]; then
  openssl ecparam -name prime256v1 -genkey -noout -out "$KEY_DIR/.ec.tmp.pem"
  openssl pkcs8 -topk8 -nocrypt -in "$KEY_DIR/.ec.tmp.pem" -out "$DIAG_PRIV"
  openssl ec -in "$DIAG_PRIV" -pubout -out "$DIAG_PUB" 2>/dev/null
  rm -f "$KEY_DIR/.ec.tmp.pem"
  echo "Generated local diagnostics capability signing key pair"
fi

# Local-only Worker dev vars (uncommitted, gitignored family). Enables the
# documented DEV_AUTH_BYPASS flow so `wrangler dev` is usable without a real
# Cloudflare Access identity. Values are random local placeholders, never real.
if [ ! -f .dev.vars ]; then
  cat > .dev.vars <<EOF
DEV_AUTH_BYPASS=1
AUTH_EXPOSE_LOGIN_LINK=1
ACCESS_ADMIN_EMAILS=admin@demo-shop.com
INTEGRATION_ENCRYPTION_KEY=$(openssl rand -hex 24)
DIAGNOSTICS_CAPABILITY_SECRET=$(openssl rand -hex 24)
DIAGNOSTICS_SIGNING_PRIVATE_KEY=$(grep -v -- '-----' "$DIAG_PRIV" | tr -d '\n')
EOF
  echo "Created local .dev.vars for Worker development"
fi
if ! grep -q '^LICENSE_TOKEN_SECRET=' .dev.vars; then
  echo "LICENSE_TOKEN_SECRET=$(openssl rand -hex 32)" >> .dev.vars
  echo "Added a local LICENSE_TOKEN_SECRET to .dev.vars"
fi
if ! grep -q '^AUTH_EXPOSE_LOGIN_LINK=' .dev.vars; then
  echo "AUTH_EXPOSE_LOGIN_LINK=1" >> .dev.vars
  echo "Enabled local AUTH_EXPOSE_LOGIN_LINK in .dev.vars"
fi

# Apply D1 migrations to the local (miniflare) database used by `wrangler dev`.
# If a previous local DB schema drifts from tracked migrations, reset local state
# once and retry so bootstrap remains idempotent for fresh development setups.
if ! npm run db:migrate:local; then
  echo "Local D1 migration failed; resetting .wrangler/state/v3/d1 and retrying once"
  rm -rf .wrangler/state/v3/d1
  if ! npm run db:migrate:local; then
    echo "Local D1 migration still failed after reset; continuing bootstrap for non-D1 tasks"
  fi
fi
