#!/usr/bin/env bash
# Run after provision.sh, after the code is at /opt/onlyass/server and
# /opt/onlyass/server/.env has been filled in by hand on the box.
#
# Usage: sudo bash app-setup.sh

set -euo pipefail

APP_USER="onlyass"
APP_DIR="/opt/onlyass/server"

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
cp "$APP_DIR/deploy/onlyass-api.service" /etc/systemd/system/onlyass-api.service
cp "$APP_DIR/deploy/onlyass-workers.service" /etc/systemd/system/onlyass-workers.service
systemctl daemon-reload
systemctl enable --now onlyass-api onlyass-workers

echo "==> nginx site"
cp "$APP_DIR/deploy/nginx-onlyass.conf" /etc/nginx/sites-available/onlyass
ln -sf /etc/nginx/sites-available/onlyass /etc/nginx/sites-enabled/onlyass
nginx -t && systemctl reload nginx

cat <<'EOF'

==> Done. Check status with:
  systemctl status onlyass-api onlyass-workers
  journalctl -u onlyass-api -f
  journalctl -u onlyass-workers -f

Then point api.onlyass.fun's DNS A record at this droplet's IP and run:
  certbot --nginx -d api.onlyass.fun
to get TLS (install certbot first: apt-get install -y certbot python3-certbot-nginx).
EOF
