#!/usr/bin/env bash
# One-time system setup for a fresh Ubuntu 22.04/24.04 droplet.
# Run as root: sudo bash provision.sh
#
# This installs system packages and creates the app user/directories.
# It does NOT deploy the app code or start services -- see DEPLOY.md
# for the rest of the steps (those come after code is on the box and
# .env is filled in by hand, on the box, never pasted through chat).

set -euo pipefail

APP_USER="onlyone"
APP_DIR="/opt/onlyone"

echo "==> apt update + base packages"
apt-get update -y
apt-get install -y curl git nginx postgresql postgresql-contrib redis-server ufw ca-certificates gnupg \
  fail2ban unattended-upgrades

echo "==> unattended security updates + fail2ban (SSH brute-force protection)"
dpkg-reconfigure -f noninteractive unattended-upgrades
systemctl enable --now fail2ban

echo "==> Node.js 22.x (NodeSource)"
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v
npm -v

echo "==> app user + directories"
id -u "$APP_USER" &>/dev/null || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

echo "==> Postgres: create role + database"
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='onlyone'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE ROLE onlyone WITH LOGIN PASSWORD 'CHANGE_ME_SEE_ENV';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='onlyone'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE onlyone OWNER onlyone;"

echo "==> Redis: bind to localhost only, enable persistence, start on boot"
sed -i 's/^# *bind .*/bind 127.0.0.1 -::1/' /etc/redis/redis.conf || true
systemctl enable --now redis-server

echo "==> Postgres: start on boot"
systemctl enable --now postgresql

echo "==> firewall: allow SSH, HTTP, HTTPS only"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

cat <<'EOF'

==> Done. Next steps (see DEPLOY.md):
  1. Get the server/ code onto this box at /opt/onlyone/server
     (git clone, or scp/rsync a tarball from your machine).
  2. Create /opt/onlyone/server/.env with real values -- do this by
     editing the file directly on this box (nano/vim), never by
     pasting secrets through a chat session. Use .env.example as the
     template. Set the Postgres password you actually used above
     (replace CHANGE_ME_SEE_ENV) in both the DB and DATABASE_URL.
  3. Run deploy/app-setup.sh as the onlyone user (or root) to install
     deps, build, migrate, and install the systemd services.
EOF
