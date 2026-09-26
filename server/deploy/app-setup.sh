#!/usr/bin/env bash
# Run after provision.sh, after the code is at /opt/onlyone/server and
# /opt/onlyone/server/.env has been filled in by hand on the box.
#
# Usage: sudo bash app-setup.sh

set -euo pipefail

APP_USER="onlyone"
# The key-holding workers (treasury key, deposit mnemonic) run as their own
# system user, in APP_USER's group so they can read the build. The
# internet-facing API runs as APP_USER and so can read neither .env.workers
# (root-owned, below) nor the workers' /proc/<pid>/environ.
WORKERS_USER="onlyone-workers"
# The media workers (transcode: ffmpeg/libvips over untrusted uploads, plus
# broadcast, renewals, auction-close) run as a third user with NO signing
# secrets at all (deploy/onlyone-media-workers.service).
MEDIA_USER="onlyone-media"
# Owns the checkout and runs git pull / npm ci / the build. None of the
# runtime users (API, workers, media) may WRITE the code the key-holding
# workers execute: a file-write bug in the API, or anything running as it,
# could otherwise plant code in dist/ or node_modules/ -- or replace the
# directories outright -- and the next restart would run it with the
# treasury key loaded. Runtime users get read-only access through the group.
DEPLOY_USER="onlyone-deploy"
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

echo "==> users"
id -u "$WORKERS_USER" &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin -g "$APP_USER" "$WORKERS_USER"
id -u "$MEDIA_USER" &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin -g "$APP_USER" "$MEDIA_USER"
# A home for npm's cache; primary group onlyone so every file it builds is
# group-readable by the runtime users (and, with the modes below, nothing
# more).
id -u "$DEPLOY_USER" &>/dev/null || useradd --system --create-home --home-dir "/var/lib/$DEPLOY_USER" --shell /usr/sbin/nologin -g "$APP_USER" "$DEPLOY_USER"

echo "==> ownership: the deploy user owns the code; runtime users can only read it"
# Code copied or cloned as root (both documented ways of getting it here)
# left npm ci failing with EACCES. It used to be handed to APP_USER -- the
# API's own user -- which made every file the key-holding workers execute
# writable by the internet-facing process. Now the whole checkout belongs to
# DEPLOY_USER, group APP_USER, with no group or other write anywhere: the
# API, workers and media users can read and run it, and none can change it
# (not a file, and not a directory entry -- a writable server/ dir would let
# the API swap dist/ out wholesale). Own the whole checkout when this is one
# (APP_DIR is normally a symlink to <checkout>/server), else just APP_DIR.
REPO_ROOT="$(git -c safe.directory='*' -C "$APP_DIR/" rev-parse --show-toplevel 2>/dev/null || echo "$APP_DIR")"
# The env files are pruned: they keep the owners and modes set below, and a
# recursive chmod g+r must never, even for a moment, make .env.workers (the
# treasury key) readable by the onlyone group.
lock_code() {
  find "$REPO_ROOT/" "$APP_DIR/" \( -name .env -o -name .env.workers \) -prune -o -exec chown -h "$DEPLOY_USER":"$APP_USER" {} +
  find "$REPO_ROOT/" "$APP_DIR/" \( -name .env -o -name .env.workers \) -prune -o ! -type l -exec chmod u+rwX,g+rX,g-w,o-rwx {} +
}
lock_code

echo "==> locking the path above the code"
# Locking the checkout is not enough if the directory ABOVE it is writable:
# /opt/onlyone used to be owned by the API user (provision.sh chown -R), so a
# compromised API process could `ln -sfn` /opt/onlyone/server at a directory
# it controls, or rename /opt/onlyone/app and put its own in its place. Every
# unit reaches its WorkingDirectory, EnvironmentFile= and ExecStart through
# that path, so the next restart of the key-holding workers would run its
# code (or load its .env, e.g. NODE_OPTIONS=--require) with the treasury key
# in the environment. Every ancestor of the symlink and of the checkout must
# therefore be root-owned and not group/other-writable. Ancestors one of our
# own users owns (the old layout) are taken back to root; anything else that
# is writable by someone else (a sticky /tmp, a user's home) is refused
# rather than chown'd -- that is not a layout to deploy the key into.
lock_parents() {
  local start d owner
  for start in "$(dirname "$APP_DIR")" "$(dirname "$REPO_ROOT")"; do
    d="$start"
    while [[ -n "$d" && "$d" != "/" ]]; do
      owner="$(stat -c %U "$d")"
      case "$owner" in
        "$APP_USER"|"$WORKERS_USER"|"$MEDIA_USER"|"$DEPLOY_USER")
          chown root:root "$d"
          chmod go-w "$d"
          ;;
      esac
      if [[ "$(stat -c %U "$d")" != "root" ]] || [[ -n "$(find "$d" -maxdepth 0 -perm /022)" ]]; then
        echo "ERROR: $d is writable by someone other than root ($(stat -c '%U:%G %A' "$d"))." >&2
        echo "       A runtime user could swap the code or .env out from under the key-holding workers." >&2
        echo "       Make it root-owned and not group/other-writable, or deploy under /opt/onlyone." >&2
        exit 1
      fi
      d="$(dirname "$d")"
    done
  done
  # The symlink itself (APP_DIR is normally /opt/onlyone/server -> app/server).
  # Its own owner does not decide who can replace it -- the parent above does
  # -- but it should not look like the API's.
  if [[ -L "$APP_DIR" ]]; then chown -h root:root "$APP_DIR"; fi
}
lock_parents

echo "==> locking down any pre-migration copy"
# DEPLOY.md "Migrating an existing box" moves the old real directory aside
# as /opt/onlyone/server.old. Its .env held TREASURY_PRIVATE_KEY, and the
# older runbook chown'd it to the API's user -- ReadOnlyPaths blocks writes,
# not reads, so the internet-facing API could still read the key there.
# Root-only until an operator deletes it.
for old in "$(dirname "$APP_DIR")"/server.old*; do
  [[ -e "$old" && ! -L "$old" ]] || continue
  chown -R root:root "$old"
  chmod -R go-rwx "$old"
  echo "WARNING: $old still exists (root-only now). It may contain the treasury key: delete it once the migration is verified, and rotate the key." >&2
done

echo "==> locking down env files"
# .env is read by systemd (as root) for every unit, and by prisma during
# this deploy (as DEPLOY_USER, via the group). No runtime user may WRITE it:
# the key-holding workers load it too, so a writable .env was a way to
# inject e.g. NODE_OPTIONS into the process that holds the treasury key.
chown root:"$APP_USER" "$APP_DIR/.env"
chmod 640 "$APP_DIR/.env"
# Signing secrets live ONLY in .env.workers, which only onlyone-workers
# loads: the internet-facing API process and the media workers never need
# the treasury key or the deposit mnemonic (the API derives deposit
# addresses from DEPOSIT_XPUB).
#
# .env.workers is owned by ROOT, mode 600: systemd reads EnvironmentFile= as
# root, so the workers unit still gets it; nothing else needs to open it.
if [[ -f "$APP_DIR/.env.workers" ]]; then
  chown root:root "$APP_DIR/.env.workers"
  chmod 600 "$APP_DIR/.env.workers"
fi
# A REFUSAL, not a warning, and before anything is installed or restarted:
# the API and the media workers (ffmpeg/libvips over untrusted uploads) both
# load .env, so a signing secret there puts the treasury key in exactly the
# processes the env split exists to keep it out of. A warning used to scroll
# past among the npm/prisma output, "Done" printed, and every unit restarted
# with the key loaded (both processes also refuse to start with it now).
# Matches an optional `export ` and surrounding spaces, as systemd does.
SECRET_IN_ENV_RE='^[[:space:]]*(export[[:space:]]+)?(TREASURY_PRIVATE_KEY|DEPOSIT_MNEMONIC)[[:space:]]*=[[:space:]]*["'"'"']?[^"'"'"'[:space:]#]'
if grep -Eq "$SECRET_IN_ENV_RE" "$APP_DIR/.env"; then
  echo "ERROR: TREASURY_PRIVATE_KEY / DEPOSIT_MNEMONIC are set in $APP_DIR/.env, which the API and the media workers load." >&2
  echo "       Nothing was installed or restarted. Move both lines to $APP_DIR/.env.workers (root:root, 600)" >&2
  echo "       and set DEPOSIT_XPUB in .env -- DEPLOY.md, 'Moving the signing secrets out of .env' -- then re-run this." >&2
  exit 1
fi
if grep -Eq '^(ONLYASS_[A-Z0-9_]+|USDC_ADDRESS)=' "$APP_DIR/.env"; then
  echo "WARNING: .env still uses pre-rename names (ONLYASS_*, USDC_ADDRESS) that nothing reads." >&2
  echo "         Rename them to ONLYONE_* / USDG_ADDRESS (see .env.example)." >&2
fi
# systemd's EnvironmentFile= keeps a trailing '# comment' as part of the value.
# Both files: a signing secret with a comment after it is unusable, and the
# only symptom is every payout refunding. Names only -- never print values,
# some of them are secrets (this runs as root, so it can read .env.workers).
for ENVF in "$APP_DIR/.env" "$APP_DIR/.env.workers"; do
  [[ -f "$ENVF" ]] || continue
  COMMENTED=$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=[^#]*[[:space:]]#' "$ENVF" | cut -d= -f1 || true)
  if [ -n "$COMMENTED" ]; then
    echo "WARNING: these $(basename "$ENVF") lines end in an inline '# comment', which systemd keeps as part of the value:" >&2
    echo "$COMMENTED" | sed 's/^/           /' >&2
    echo "         Move each comment onto its own line." >&2
  fi
done

cd "$APP_DIR"

AS_DEPLOY=(sudo -H -u "$DEPLOY_USER")

echo "==> npm ci"
"${AS_DEPLOY[@]}" npm ci

echo "==> prisma generate + migrate deploy"
"${AS_DEPLOY[@]}" npx prisma generate
"${AS_DEPLOY[@]}" npx prisma migrate deploy

echo "==> build"
"${AS_DEPLOY[@]}" npm run build
# Whatever the build and install just wrote: same modes as the rest.
lock_code

echo "==> seeding system accounts (platform + escrow pseudo-users)"
"${AS_DEPLOY[@]}" node dist/scripts/seed-system-accounts.js

echo "==> operator admin account"
# Reminder only (never fails the deploy): without an ADMIN row nobody can
# resolve a FAILED/HELD payout -- see DEPLOY.md step 4b.
"${AS_DEPLOY[@]}" node dist/scripts/admin-check.js || true

echo "==> install systemd units"
cp "$APP_DIR/deploy/onlyone-api.service" /etc/systemd/system/onlyone-api.service
cp "$APP_DIR/deploy/onlyone-workers.service" /etc/systemd/system/onlyone-workers.service
cp "$APP_DIR/deploy/onlyone-media-workers.service" /etc/systemd/system/onlyone-media-workers.service
systemctl daemon-reload
# `enable --now` only STARTS a unit if it isn't already running -- on every
# redeploy after the first, both services are already active, so it was a
# silent no-op and the freshly rebuilt dist/ never actually loaded. Caught
# live: the bridge route shipped, the build succeeded, "Done" printed, and
# the API kept serving 404s for it because the old process was still the
# one running. `enable` (persist across reboots) and `restart` (always pick
# up the new build) are two different things and both are needed here.
systemctl enable onlyone-api onlyone-workers onlyone-media-workers
systemctl restart onlyone-api onlyone-workers onlyone-media-workers

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
  systemctl status onlyone-api onlyone-workers onlyone-media-workers
  journalctl -u onlyone-api -f
  journalctl -u onlyone-workers -f
  journalctl -u onlyone-media-workers -f

Redeploys: git pull as the deploy user (it owns the checkout now):
  sudo -H -u onlyone-deploy git -C /opt/onlyone/app pull

Then point api.joinonlyone.com's DNS A record at this droplet's IP and run:
  certbot --nginx -d api.joinonlyone.com
to get TLS (install certbot first: apt-get install -y certbot python3-certbot-nginx).
EOF
