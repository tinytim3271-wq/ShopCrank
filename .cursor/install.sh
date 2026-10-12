#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for the Shop Crank repository.
set -eo pipefail

cd "$(dirname "$0")/.."

# Node 24 to match .github/workflows/cloudflare-pages.yml and AGENTS.md.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install 24 >/dev/null
nvm alias default 24 >/dev/null
nvm use 24 >/dev/null
echo "Using Node $(node -v) / npm $(npm -v)"

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
ACCESS_ADMIN_EMAILS=admin@demo-shop.com
INTEGRATION_ENCRYPTION_KEY=$(openssl rand -hex 24)
DIAGNOSTICS_CAPABILITY_SECRET=$(openssl rand -hex 24)
DIAGNOSTICS_SIGNING_PRIVATE_KEY=$(grep -v -- '-----' "$DIAG_PRIV" | tr -d '\n')
EOF
  echo "Created local .dev.vars for Worker development"
fi

# Apply D1 migrations to the local (miniflare) database used by `wrangler dev`.
npm run db:migrate:local
