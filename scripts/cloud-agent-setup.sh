#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for ShopCrank.
# Refreshes dependencies, builds the web bundle, seeds local-only Worker dev
# secrets, and applies the D1 schema to the local Miniflare database.
set -euo pipefail

cd "$(dirname "$0")/.."

npm ci
npm run build:web

# Local-only Worker dev secrets (see README, "local Worker API development
# only"). These enable the dev auth bypass and provide throwaway encryption
# keys for Miniflare. They are never used in production and .dev.vars is
# gitignored. Only generated when missing so the script stays idempotent.
if [ ! -f .dev.vars ]; then
  cat > .dev.vars <<EOF
DEV_AUTH_BYPASS=1
INTEGRATION_ENCRYPTION_KEY=$(openssl rand -hex 32)
DIAGNOSTICS_CAPABILITY_SECRET=$(openssl rand -hex 32)
ACCESS_ADMIN_EMAILS=admin@example.com
EOF
  echo "Wrote local .dev.vars for Worker development."
fi

# Apply the D1 schema to the local Miniflare database (non-interactive,
# skips already-applied migrations).
npm run db:migrate:local
