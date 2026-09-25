# Deploying the OnlyOne backend to the droplet

**Why this is a manual runbook and not something run automatically:** the
Claude session that wrote this can only reach the internet over HTTPS
through a sandboxed proxy -- it cannot open a raw SSH (port 22) connection
to your droplet from where it runs, even with the `onlyone_do` deploy key.
So these steps need to be run by you (or in a Claude Code session that
actually has shell access to the box, e.g. one running on your own
machine or in an environment with unrestricted networking).

Target: `137.184.29.10`, chain: Robinhood Chain (id 4663).

## 1. Get the code onto the box

The box runs from a real git checkout, so redeploys are a `git pull`.
`/opt/onlyone/server` is a symlink to the checkout's `server/` folder:

```bash
# on the droplet, as root
git clone <your repo url> /opt/onlyone/app
ln -sfn /opt/onlyone/app/server /opt/onlyone/server
```

(`app-setup.sh` hands the whole checkout to the `onlyone-deploy` build
user, readable but NOT writable by the runtime users, so it does not matter
that it was cloned as root. None of the processes that run the code -- the
API, the key-holding workers, the media workers -- can modify it. That
includes the path ABOVE it: `/opt/onlyone` itself must be root-owned and not
group/other-writable, or the API could re-point the `/opt/onlyone/server`
symlink (or swap `/opt/onlyone/app`) and the key-holding workers would run
its code, or load its `.env`, on their next restart. `provision.sh` creates
it that way; `app-setup.sh` takes it back from an old `chown -R onlyone`
layout and refuses to deploy under any ancestor another user can write. The
units also mount `/opt/onlyone` read-only (`ReadOnlyPaths=`).)

## 2. System setup (run once, as root, on the droplet)

```bash
cd /opt/onlyone/server/deploy
bash provision.sh
```

This installs Node 22, Postgres, Redis, nginx, ufw, creates the `onlyone`
system user, and creates the `onlyone` Postgres role + database. It prints
a reminder to change the Postgres password from the placeholder.

## 3. Fill in the env files -- directly on the box, never through chat

There are TWO files. The split is the point: the API process is the one that
faces the internet, and it must never hold a signing key.

```bash
cd /opt/onlyone/server
cp .env.example .env
nano .env            # API + shared settings
nano .env.workers    # ONLY the two signing secrets below
chmod 600 .env.workers
chown root:root .env.workers   # app-setup.sh enforces this too: no app user may read it
# .env: app-setup.sh makes it root:onlyone 640 -- readable, never writable,
# by the runtime users (all three units load it).
```

`.env` (loaded by all three units) -- every variable name in `.env.example` is
one the code actually reads. **Keep every comment on its own line**:
systemd's `EnvironmentFile=` does not strip a trailing `# ...` after a
value, it keeps it as part of the value (`app-setup.sh` and the services
warn about any line that does this). In particular:
- `DATABASE_URL` -- use the Postgres password you set in step 2
- `JWT_SECRET` -- long random string (`openssl rand -hex 32`)
- `BRIDGE_SECRET` -- the same value as `BRIDGE_SECRET` in the site's Vercel env
- `WEB_ORIGIN`, `SITE_URL` -- `https://www.joinonlyone.com`
- `DEPOSIT_XPUB` -- after the build (step 4), run
  `sudo -u onlyone node dist/scripts/derive-deposit-xpub.js < /dev/tty`,
  paste the mnemonic at the hidden prompt (it is not echoed), and put the
  printed value here. The API derives
  deposit addresses from it.
- The stablecoin: leave `USDG_ADDRESS` commented out to use the canonical
  USDG contract (`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, from
  docs.robinhood.com/chain/contracts). There is no USDC contract on this
  chain; bridged USDC arrives as USDG. `USDC_ADDRESS` is NOT read.
- `ONLYONE_TOKEN_ADDRESS` -- the live token,
  `0x2c34ED86552076715272056D021cEab6080F1Ab5`. Leave
  `INDEX_ONLYONE_DEPOSITS=false` (nothing spends an $ONLYONE balance).
- `RPC_URL` -- `https://rpc.mainnet.chain.robinhood.com`, or a private RPC.
- S3/Bunny (incl. `BUNNY_API_KEY` for takedown cache purges), SES
  (`EMAIL_PROVIDER`, `EMAIL_FROM`, `AWS_REGION`, `SES_SNS_TOPIC_ARNS`, and
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` -- see below), Sumsub,
  LiveKit once you have those accounts.
- SES credentials: this droplet is not on AWS, so there is no instance role
  and the SES client has nothing to sign with unless `AWS_ACCESS_KEY_ID` and
  `AWS_SECRET_ACCESS_KEY` are set. Create a dedicated IAM user whose only
  permission is `ses:SendEmail` on the verified `EMAIL_FROM` identity. (The
  S3 keys are separate -- `S3_ACCESS_KEY` / `S3_SECRET_KEY` -- and SES does
  not read them.) With `EMAIL_PROVIDER=ses` the API refuses to start if no
  credentials resolve, rather than starting and failing every send silently.
- `TREASURY_ADDRESS` -- the treasury wallet's PUBLIC address (never the
  key). The API needs it to accept an admin "mark sent" on a payout: it only
  accepts a USDG transfer FROM this address.

`.env.workers` (loaded ONLY by `onlyone-workers`, the key-holding unit --
never by the API or `onlyone-media-workers`, which parses uploads). One
variable per line and **no comment on the same line**: systemd keeps a
trailing `# ...` as part of the value, and a key with one appended is
rejected -- every payout refunds and every sweep fails (the workers and
`app-setup.sh` warn, naming the variable only):
- `TREASURY_PRIVATE_KEY` -- the mainnet wallet key you generate yourself.
- `DEPOSIT_MNEMONIC` -- same rule.
**Generate both on the droplet or on a machine you trust; never paste them
into any chat session, including this one.**

Names from before the rename (`ONLYASS_*`, `USDC_ADDRESS`) do nothing; the
services and `app-setup.sh` warn if any are still present.

## 4. App setup (run once, as root)

```bash
cd /opt/onlyone/server/deploy
bash app-setup.sh
```

This makes sure ffmpeg is installed (the transcode worker needs it for every
upload), creates the service users, gives the `onlyone-deploy` build user
ownership of the code (group-readable, not writable, by the runtime users),
makes `/opt/onlyone` and every directory above the code root-owned,
runs `npm ci`, `prisma migrate deploy` and the build as that user, seeds the
system accounts, installs and restarts the three systemd services, and wires
up the nginx reverse proxy on port 80:

- `onlyone-api` (user `onlyone`) -- the internet-facing API. Loads `.env`.
- `onlyone-workers` (user `onlyone-workers`) -- ONLY the loops that sign:
  deposit sweeps, payouts, treasury hedge, token burn. The only unit that
  loads `.env.workers`.
- `onlyone-media-workers` (user `onlyone-media`) -- transcode (ffmpeg and
  libvips over every account's uploads), mass-DM broadcast, renewals,
  auction close. Loads `.env` only: a parser exploit in an uploaded file
  lands in a process with no signing key.

## 4b. Create the operator admin account (once; re-run to rotate the password)

There is no HTTP way to create an ADMIN: `/auth/register` is closed, the
bridge refuses ADMIN rows, and password login answers only for ADMIN rows
made by this script. Without one, nobody can reach `/admin` -- and every
case the payout worker deliberately leaves for a human (FAILED payouts it
could not settle, HELD payouts, `POST /admin/payouts/:id/resolve`, manual
token-burn records) waits forever. As root:

```bash
sudo -u onlyone sh -c 'cd /opt/onlyone/server && node dist/scripts/create-admin.js you@example.com youradmin'
```

The password (16+ characters) is typed at a hidden prompt, never passed as
an argument. Running it again for the same email resets the password and
signs out every session. `app-setup.sh` prints a warning on every deploy
until an admin exists.

### Settling a payout by hand

Before sending anything from the treasury yourself, move the payout out of
the automatic paths: `POST /admin/payouts/:id/resolve {"action":"hold"}`
(PENDING or FAILED -> HELD). Then send, then `mark_sent` with your
transaction's hash. Skipping the hold can pay the creator twice: a queued
job broadcasts its own transfer, and the reconciler can refund a FAILED
payout whose nonce your transfer consumed. A payout held out of FAILED
still carries the worker's signed transaction, which may yet land: it can
only be closed with `mark_sent` or `refund` (check the explorer first),
never `release`d back to the queue.

## 5. TLS

Point `api.joinonlyone.com`'s DNS A record at `137.184.29.10`, then:

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d api.joinonlyone.com
```

## 6. Verify

```bash
systemctl status onlyone-api onlyone-workers onlyone-media-workers
journalctl -u onlyone-api -f
curl https://api.joinonlyone.com/health                    # {"ok":true}
curl https://api.joinonlyone.com/messages/conversations     # 401 (no token) -- confirms auth is wired up, not a connection error
```

Once this is confirmed reachable over HTTPS, a Claude session (including
this one) can hit `https://api.joinonlyone.com/...` directly to help verify
behavior and debug -- HTTPS is the one thing this sandbox's network policy
already allows out.

## Redeploying after code changes

```bash
cd /opt/onlyone/app
sudo -H -u onlyone-deploy git pull
bash server/deploy/app-setup.sh    # as root
```

(The first redeploy after the checkout was handed to `onlyone-deploy` is the
one exception: until `app-setup.sh` has run once, the checkout is still owned
by `onlyone`, so pull with `sudo -u onlyone git pull` that one time.)

Nothing else. `app-setup.sh` is the one place the install, migrate, build,
seed, restart and nginx steps live, so a hand-written list here cannot drift
from it. Then check the real public endpoint, not just `systemctl status`:
`curl https://api.joinonlyone.com/health`.

`app-setup.sh` refuses to run unless `/opt/onlyone/server` is inside a git
checkout, and prints the commit it built (`==> Deployed commit: ...`) --
compare it with `git log -1` on the branch you meant to ship.

## Migrating an existing box to the git checkout

A droplet set up by the older runbook has `/opt/onlyone/server` as a REAL
directory of copied code, and it holds the only copy of `.env` (and maybe
`.env.workers`). Do NOT just run `ln -sfn` from step 1 against it: `ln -sfn`
into an existing directory creates `/opt/onlyone/server/server` inside it,
and the old code keeps being rebuilt (`app-setup.sh` now refuses that
layout). As root:

```bash
systemctl stop onlyone-api onlyone-workers onlyone-media-workers 2>/dev/null || true
mv /opt/onlyone/server /opt/onlyone/server.old
git clone <your repo url> /opt/onlyone/app
cp -p /opt/onlyone/server.old/.env /opt/onlyone/app/server/.env
[ -f /opt/onlyone/server.old/.env.workers ] && cp -p /opt/onlyone/server.old/.env.workers /opt/onlyone/app/server/.env.workers
ln -s /opt/onlyone/app/server /opt/onlyone/server
bash /opt/onlyone/server/deploy/app-setup.sh
curl https://api.joinonlyone.com/health
```

Check the printed `Deployed commit`, then, once everything is verified,
`rm -rf /opt/onlyone/server.old` (it contains secrets -- do not leave it
around indefinitely).

## Media bucket lifecycle rule

Do NOT add an expiry rule on `raw/`: completed images are served from their
raw key, so expiring it would delete real content. Abandoned uploads are
cleaned by the workers instead -- `sweepAbandonedUploads`
(workers/transcode.ts) deletes the raw object and the row of every upload
still UPLOADING after 24 hours, hourly. If your provider supports it, do add
a rule aborting incomplete multipart uploads after 1 day.

## Live streaming webhook

In the LiveKit project's webhook settings, point it at
`https://api.joinonlyone.com/live/webhook` and enable at least
`room_finished` and `participant_joined`. `participant_joined` is what
removes a per-minute viewer who reconnects without paid time.

## One-time: moving an existing box to the split env files

A droplet set up before `.env.workers` existed has the treasury key and the
mnemonic in `.env`, which the API loads. To move them:

```bash
cd /opt/onlyone/server
sudo -u onlyone node dist/scripts/derive-deposit-xpub.js < /dev/tty   # paste the mnemonic (hidden)
# add the printed DEPOSIT_XPUB=... line to .env
# cut the TREASURY_PRIVATE_KEY= and DEPOSIT_MNEMONIC= lines out of .env into .env.workers
chmod 600 .env.workers
chown root:root .env.workers   # app-setup.sh enforces this too: no app user may read it
bash deploy/app-setup.sh
```

Also rename any `ONLYASS_*` keys to `ONLYONE_*` and `USDC_ADDRESS` to
`USDG_ADDRESS` (or delete it to use the canonical default) while in there.
