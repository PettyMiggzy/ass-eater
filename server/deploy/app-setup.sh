#!/usr/bin/env bash
# Run after provision.sh, after the code is at /opt/onlyone/server and
# /opt/onlyone/server/.env has been filled in by hand on the box.
#
# Usage: sudo bash app-setup.sh

set -euo pipefail

APP_USER="onlyone"
APP_DIR="/opt/onlyone/server"

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "Missing $APP_DIR/.env -- create it from .env.example first, with real values, directly on this box." >&2
  exit 1
fi

echo "==> locking down .env permissions (holds the treasury key + deposit mnemonic)"
chown "$APP_USER":"$APP_USER" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

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

cat <<'EOF'

==> Done. Check status with:
  systemctl status onlyone-api onlyone-workers
  journalctl -u onlyone-api -f
  journalctl -u onlyone-workers -f

Then point api.joinonlyone.com's DNS A record at this droplet's IP and run:
  certbot --nginx -d api.joinonlyone.com
to get TLS (install certbot first: apt-get install -y certbot python3-certbot-nginx).
EOF
