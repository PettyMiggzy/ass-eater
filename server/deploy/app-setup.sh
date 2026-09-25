#!/usr/bin/env bash
# Run after provision.sh, after the code is at /opt/onlyone/server and
# /opt/onlyone/server/.env has been filled in by hand on the box.
#
# Usage: sudo bash app-setup.sh

set -euo pipefail

APP_USER="onlyone"
APP_DIR="${APP_DIR:-/opt/onlyone/server}"

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "Missing $APP_DIR/.env -- create it from .env.example first, with real values, directly on this box." >&2
  exit 1
fi

echo "==> checking this is the git checkout you think it is"
# The box must build from a git checkout (APP_DIR normally a symlink to
# /opt/onlyone/app/server). A box set up by the older runbook has a REAL
# directory here holding copied code, and `ln -sfn` into an existing
# directory does not replace it -- it creates $APP_DIR/server inside it --
# so this script would rebuild and restart the OLD copy, print "Done", and
# the new code would never run. Refuse instead; DEPLOY.md, "Migrating an
# existing box", is the fix.
if [[ -L "$APP_DIR/server" ]]; then
  echo "ERROR: $APP_DIR/server is a symlink inside $APP_DIR -- an 'ln -sfn' nested into the old copied directory." >&2
  echo "       Follow DEPLOY.md 'Migrating an existing box to the git checkout' before redeploying." >&2
  exit 1
fi
if ! git -c safe.directory='*' -C "$APP_DIR/" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: $APP_DIR is not inside a git checkout, so a 'git pull' never reaches it." >&2
  echo "       Follow DEPLOY.md 'Migrating an existing box to the git checkout'." >&2
  exit 1
fi
DEPLOYED_COMMIT="$(git -c safe.directory='*' -C "$APP_DIR/" rev-parse --short HEAD)"
echo "    building commit $DEPLOYED_COMMIT from $(git -c safe.directory='*' -C "$APP_DIR/" rev-parse --show-toplevel)"

echo "==> ffmpeg (every media upload is transcoded with it)"
command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null || apt-get install -y ffmpeg

echo "==> ownership: the app user must own the code it builds"
# Code copied or cloned as root (both documented ways of getting it here)
# left npm ci failing with EACCES on node_modules, and a later git pull by
# the app user failing the same way. Own the whole checkout when this is one
# (APP_DIR is normally a symlink to <checkout>/server), else just APP_DIR.
REPO_ROOT="$(git -c safe.directory='*' -C "$APP_DIR/" rev-parse --show-toplevel 2>/dev/null || echo "$APP_DIR")"
chown -R "$APP_USER":"$APP_USER" "$REPO_ROOT/"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR/"

echo "==> locking down env files"
chmod 600 "$APP_DIR/.env"
# Signing secrets live ONLY in .env.workers, which only onlyone-workers
# loads: the internet-facing API process never needs the treasury key or the
# deposit mnemonic (it derives deposit addresses from DEPOSIT_XPUB).
if [[ -f "$APP_DIR/.env.workers" ]]; then
  chmod 600 "$APP_DIR/.env.workers"
fi
if grep -Eq '^(TREASURY_PRIVATE_KEY|DEPOSIT_MNEMONIC)=.+' "$APP_DIR/.env"; then
  echo "WARNING: TREASURY_PRIVATE_KEY / DEPOSIT_MNEMONIC are set in .env, which the API process loads." >&2
  echo "         Move them to $APP_DIR/.env.workers and set DEPOSIT_XPUB in .env (see DEPLOY.md)." >&2
fi
if grep -Eq '^(ONLYASS_[A-Z0-9_]+|USDC_ADDRESS)=' "$APP_DIR/.env"; then
  echo "WARNING: .env still uses pre-rename names (ONLYASS_*, USDC_ADDRESS) that nothing reads." >&2
  echo "         Rename them to ONLYONE_* / USDG_ADDRESS (see .env.example)." >&2
fi
# systemd's EnvironmentFile= keeps a trailing '# comment' as part of the value.
# Names only -- never print values, some of them are secrets.
COMMENTED=$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=[^#]*[[:space:]]#' "$APP_DIR/.env" | cut -d= -f1 || true)
if [ -n "$COMMENTED" ]; then
  echo "WARNING: these .env lines end in an inline '# comment', which systemd keeps as part of the value:" >&2
  echo "$COMMENTED" | sed 's/^/           /' >&2
  echo "         Move each comment onto its own line." >&2
fi

cd "$APP_DIR"

echo "==> npm ci"
sudo -u "$APP_USER" npm ci

echo "==> prisma generate + migrate deploy"
sudo -u "$APP_USER" npx prisma generate
sudo -u "$APP_USER" npx prisma migrate deploy

echo "==> build"
sudo -u "$APP_USER" npm run build

echo "==> seeding system accounts (platform + escrow pseudo-users)"
sudo -u "$APP_USER" node dist/scripts/seed-system-accounts.js

echo "==> operator admin account"
# Reminder only (never fails the deploy): without an ADMIN row nobody can
# resolve a FAILED/HELD payout -- see DEPLOY.md step 4b.
sudo -u "$APP_USER" node dist/scripts/admin-check.js || true

echo "==> install systemd units"
cp "$APP_DIR/deploy/onlyone-api.service" /etc/systemd/system/onlyone-api.service
cp "$APP_DIR/deploy/onlyone-workers.service" /etc/systemd/system/onlyone-workers.service
systemctl daemon-reload
# `enable --now` only STARTS a unit if it isn't already running -- on every
# redeploy after the first, both services are already active, so it was a
# silent no-op and the freshly rebuilt dist/ never actually loaded. Caught
# live: the bridge route shipped, the build succeeded, "Done" printed, and
# the API kept serving 404s for it because the old process was still the
# one running. `enable` (persist across reboots) and `restart` (always pick
# up the new build) are two different things and both are needed here.
systemctl enable onlyone-api onlyone-workers
systemctl restart onlyone-api onlyone-workers

echo "==> nginx site"
# Certbot rewrites this file in place to add the HTTPS server block once TLS
# is set up (see DEPLOY.md step 5). Blindly re-copying the plain-HTTP
# template on every redeploy -- which this script used to do
# unconditionally -- silently overwrote that HTTPS block on the very next
# run of this script, leaving nginx listening on 80 only while every other
# service looked perfectly healthy. Detected the hard way: onlyone-api was
# green, /health worked on localhost, but the public HTTPS endpoint started
# resetting connections mid-TLS-handshake right after a routine redeploy.
# Only install/overwrite the template before TLS exists; once Certbot has
# added a "listen 443" block, leave the file alone.
if [[ -f /etc/nginx/sites-available/onlyone ]] && grep -q "listen 443" /etc/nginx/sites-available/onlyone; then
  echo "    TLS already configured (Certbot has edited this file) -- leaving it as-is."
  echo "    To change the base proxy config after TLS is live, edit"
  echo "    /etc/nginx/sites-available/onlyone directly on the box, not this template."
else
  cp "$APP_DIR/deploy/nginx-onlyone.conf" /etc/nginx/sites-available/onlyone
  ln -sf /etc/nginx/sites-available/onlyone /etc/nginx/sites-enabled/onlyone
fi
nginx -t && systemctl reload nginx

echo "==> Deployed commit: $DEPLOYED_COMMIT"

cat <<'EOF'

==> Done. Check status with:
  systemctl status onlyone-api onlyone-workers
  journalctl -u onlyone-api -f
  journalctl -u onlyone-workers -f

Then point api.joinonlyone.com's DNS A record at this droplet's IP and run:
  certbot --nginx -d api.joinonlyone.com
to get TLS (install certbot first: apt-get install -y certbot python3-certbot-nginx).
EOF
