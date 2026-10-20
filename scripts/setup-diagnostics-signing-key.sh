#!/usr/bin/env bash
#
# One-shot setup for the diagnostics capability signing key.
#
# Generates an ECDSA P-256 key pair, stores the PRIVATE key as the Worker secret
# DIAGNOSTICS_SIGNING_PRIVATE_KEY (piped straight to wrangler — never printed),
# and writes the PUBLIC key to diagnostics/keys/capability-public-key.pem so the
# diagnostic hosts can verify tokens.
#
# For a hands-off, GitHub-only setup, prefer adding DIAGNOSTICS_SIGNING_PRIVATE_KEY
# as a GitHub Actions repo secret — the Cloudflare deploy workflow provisions it
# to the Worker automatically (see docs below). Use this script when you want to
# generate/rotate the key locally instead.
#
# Run where wrangler is authenticated to Cloudflare:
#   npx wrangler login      # (browser)  OR
#   export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
#
# Usage: bash scripts/setup-diagnostics-signing-key.sh [--rotate] [--print-secret]
set -euo pipefail

cd "$(dirname "$0")/.."

SECRET_NAME="DIAGNOSTICS_SIGNING_PRIVATE_KEY"
PUB_OUT="diagnostics/keys/capability-public-key.pem"
ROTATE=0
PRINT_SECRET=0
for arg in "$@"; do
  case "$arg" in
    --rotate) ROTATE=1 ;;
    --print-secret) PRINT_SECRET=1 ;;
  esac
done

command -v openssl >/dev/null 2>&1 || { echo "error: openssl is required" >&2; exit 1; }

wrangler() { npx wrangler "$@"; }

# Private key lives only in a locked temp dir and is removed on exit.
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
chmod 700 "$workdir"

echo "Generating ECDSA P-256 key pair..."
openssl ecparam -name prime256v1 -genkey -noout -out "$workdir/ec.pem"
openssl pkcs8 -topk8 -nocrypt -in "$workdir/ec.pem" -out "$workdir/priv.pkcs8.pem"
openssl ec -in "$workdir/ec.pem" -pubout -out "$workdir/pub.pem" 2>/dev/null

if [ -f "$PUB_OUT" ] && [ "$ROTATE" -ne 1 ]; then
  echo "error: $PUB_OUT already exists. Rotating the key invalidates tokens signed" >&2
  echo "       by the previous key. Re-run with --rotate to intentionally replace it." >&2
  exit 1
fi

mkdir -p "$(dirname "$PUB_OUT")"
cp "$workdir/pub.pem" "$PUB_OUT"
echo "Wrote public key -> $PUB_OUT"

secret_value="$(grep -v -- '-----' "$workdir/priv.pkcs8.pem" | tr -d '\n')"

if [ "$PRINT_SECRET" -eq 1 ]; then
  # For storing as a GitHub Actions secret (DIAGNOSTICS_SIGNING_PRIVATE_KEY).
  echo "----- BEGIN base64 DER private key (store as the GitHub secret; keep it safe) -----"
  echo "$secret_value"
  echo "----- END -----"
else
  if ! wrangler whoami >/dev/null 2>&1; then
    echo "warning: wrangler is not authenticated. Run 'npx wrangler login' or set" >&2
    echo "         CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID before continuing." >&2
  fi
  echo "Setting Worker secret $SECRET_NAME (value piped, never printed)..."
  printf '%s' "$secret_value" | wrangler secret put "$SECRET_NAME"
fi

cat <<EOF

Done.
Next steps:
  1) Commit $PUB_OUT so diagnostic hosts can verify capability tokens.
  2) Deploy the Worker so the secret takes effect:  npm run deploy:worker
EOF
