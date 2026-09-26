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
never `release`d back to the queue. If that signed transaction landed,
`mark_sent` with the payout's OWN `txHash` accepts the transfer from the key
recorded as having signed it (`signerAddress`) -- so it still closes after a
treasury key rotation. A transfer you send by hand must come from the
current `TREASURY_ADDRESS`.

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
# The old copy's .env still holds TREASURY_PRIVATE_KEY (and maybe
# DEPOSIT_MNEMONIC), and under the older runbook the whole directory was
# owned by the API's own user. Shred the secret-bearing files now that they
# are copied, and take the rest away from every runtime user -- do not leave
# the treasury key readable by the internet-facing API while you verify.
shred -u /opt/onlyone/server.old/.env /opt/onlyone/server.old/.env.workers 2>/dev/null || true
chown -R root:root /opt/onlyone/server.old && chmod -R go-rwx /opt/onlyone/server.old
```

**Before running `app-setup.sh`, take the signing secrets out of `.env`.** A
box set up by the older runbook has `TREASURY_PRIVATE_KEY` (and possibly
`DEPOSIT_MNEMONIC`) in `.env`, which the internet-facing API and the media
workers (ffmpeg/libvips over untrusted uploads) both load. `app-setup.sh`
refuses to install or restart anything while either is there, and the API
and media workers refuse to start with either in their environment. Move
them (as root, still in the same shell):

```bash
cd /opt/onlyone/server
touch .env.workers && chown root:root .env.workers && chmod 600 .env.workers
grep -E '^[[:space:]]*(export[[:space:]]+)?(TREASURY_PRIVATE_KEY|DEPOSIT_MNEMONIC)[[:space:]]*=' .env >> .env.workers
sed -i -E '/^[[:space:]]*(export[[:space:]]+)?(TREASURY_PRIVATE_KEY|DEPOSIT_MNEMONIC)[[:space:]]*=/d' .env
grep -cE '^(TREASURY_PRIVATE_KEY|DEPOSIT_MNEMONIC)=' .env.workers   # the lines are there now
bash /opt/onlyone/server/deploy/app-setup.sh
curl https://api.joinonlyone.com/health
```

If a `DEPOSIT_MNEMONIC` was moved, the API now derives deposit addresses from
`DEPOSIT_XPUB` instead: derive it once the build exists and add it to `.env`
(steps in "Moving the signing secrets out of .env" below), then
`systemctl restart onlyone-api`.

Check the printed `Deployed commit`, then, once everything is verified,
`rm -rf /opt/onlyone/server.old`. (`app-setup.sh` also locks down any
`/opt/onlyone/server.old*` it finds to root-only and warns until it is gone.)

**Rotate the treasury key after migrating.** Under the old layout
`TREASURY_PRIVATE_KEY` sat in the internet-facing API's environment and in
files the API's user owned; treat it as exposed.

Settle everything the old key signed FIRST, and let the old key sign
NOTHING new while you do. A signed transaction stays valid for the old
wallet's nonce until something consumes it, and after the switch the workers
can no longer judge it (they record which key signed each payout, burn and
hedge, and never refund or re-buy one signed by another key -- it just sits
FAILED/in flight for you). A plain restart of the workers does not only
settle: the payout worker signs queued payouts, and the burn and hedge loops
sign a new swap in the same pass that settles the old one -- all with the old
key, rebuilding what this procedure drains. So:

1. Add `TREASURY_SETTLE_ONLY=true` to `.env.workers` -- and ONLY there; the
   workers also load `.env`, so first check it is not set in `.env` either
   (`grep -nE '^[[:space:]]*(export[[:space:]]+)?TREASURY_SETTLE_ONLY[[:space:]]*=' /opt/onlyone/server/.env`
   must print nothing -- it matches only real assignments; a commented-out
   `# ... TREASURY_SETTLE_ONLY ...` line from the `.env.example` template does
   not count and is not printed), or it will still be on after you remove it
   from `.env.workers` at the end -- (on a line of its own,
   no inline `# comment`; `true`, `1` and `yes` are accepted in any case,
   and any value the workers do not recognise makes them refuse to start),
   then `systemctl restart onlyone-workers`. In this mode the workers only
   settle: they read receipts and close what is in flight, and sign nothing
   -- no payout (PENDING ones stay PENDING and are re-queued later), no
   swap, no approval, no nonce-cancel, no sweep gas top-up. **Deposit sweeps
   pause too**: a sweep would send fan funds to the old, exposed treasury
   address, so deposits are still credited but the funds wait at the
   deposit addresses (the sweep jobs retry, and the hourly reconciler
   re-queues them) until the new key and `TREASURY_ADDRESS` are in place.
   **Before going on, confirm the mode is really on** -- in THIS run of the
   unit only. The mode is logged once, at startup, so neither the unit's
   whole history (an older boot's line matches) nor the last N lines (later
   output pushes it out) is a reliable check:

   ```bash
   journalctl -u onlyone-workers _SYSTEMD_INVOCATION_ID=$(systemctl show -p InvocationID --value onlyone-workers) | grep 'treasury signing\|TREASURY SIGNING'
   ```

   must print `TREASURY SIGNING PAUSED (settle-only)` and nothing else. If it
   prints `treasury signing mode: normal`, or nothing, the switch was not
   read -- fix `.env.workers` and restart; do not continue. **Keep it set until step 5 is finished.**
2. Every payout in PROCESSING or FAILED: look its `txHash` up on the explorer
   and settle it with `POST /admin/payouts/:id/resolve` (mark it sent if it
   landed -- a transfer the recorded `signerAddress` sent is accepted for the
   payout's own `txHash`, before and after the switch -- otherwise hold it
   and settle by hand). None may be left PROCESSING/FAILED with a hash
   nobody has checked.
3. No `TokenBurn` with `pendingTxHash` set and no `TreasuryHedgeBatch` in
   `PENDING`: the settle-only workers close each one that gets a receipt.
   One that never resolves (its signer is not the current key, or none was
   recorded) is closed with `POST /admin/treasury-tx/burn/<pendingTxHash>/resolve`
   or `POST /admin/treasury-tx/hedge/<batchId>/resolve`: it is judged
   against the signer's own nonce, and still undecided it needs
   `{"acknowledgeNeverLands": true}` after you have checked the explorer (a
   released burn is bought again; if its old swap lands later, that is a
   second purchase).
4. `systemctl stop onlyone-workers` (leave `TREASURY_SETTLE_ONLY=true` in
   place) and re-check steps 2 and 3: nothing the old key signed may be
   left unsettled.
5. Move EVERY asset out of the old wallet to the new one: all of its
   $ONLYONE (the founder's bag and every swept token deposit -- the
   treasury is both), all USDG, any other ERC-20 or NFT it holds. Revoke
   every router / Permit2 allowance the old key granted (the burn and hedge
   approve `UNISWAP_V3_ROUTER_ADDRESS`; revoke.cash or the token's
   `approve(router, 0)`). Move the ETH **last** -- every other transfer
   needs it for gas -- and leave at most dust. Only an old wallet holding
   no tokens, no allowances and no gas is safe from whoever else holds the
   exposed key: a few cents of ETH sent to it is all they need to move
   anything left behind.

Then create the new treasury wallet (if not done before step 5), put the new key
in `.env.workers`, set
`TREASURY_ADDRESS` in `.env` to the new wallet's PUBLIC address (the API and
the workers both read it: the API to accept `mark_sent` transfers and burns
from the treasury, the workers to recognise their own gas top-ups), and
remove `TREASURY_SETTLE_ONLY` from `.env.workers` (and confirm it is set in
neither `.env` nor `.env.workers`:
`grep -nE '^[[:space:]]*(export[[:space:]]+)?TREASURY_SETTLE_ONLY[[:space:]]*=' /opt/onlyone/server/.env /opt/onlyone/server/.env.workers`
prints nothing; commented lines are not matched and do not count),
and restart BOTH `onlyone-api` and `onlyone-workers`. Left on the old address,
the API keeps trusting the exposed wallet and refuses the new one; the
workers refuse to start while `TREASURY_ADDRESS` disagrees with the key
they sign with.
Deposit sweeps resume with that restart and now go to the new wallet.
Check the CURRENT run of the unit (every boot before the rotation logged
`normal` too, so the unit's whole history proves nothing):

```bash
journalctl -u onlyone-workers _SYSTEMD_INVOCATION_ID=$(systemctl show -p InvocationID --value onlyone-workers) | grep 'treasury signing\|TREASURY SIGNING'
```

must print `treasury signing mode: normal` and no `TREASURY SIGNING PAUSED`
line. Settle-only left on means every payout stays PENDING and deposit
sweeps stay paused, with nothing else flagging it.

**Rotate the deposit mnemonic too, if a real one was ever in `.env`.**
`DEPOSIT_MNEMONIC` derives the private key of EVERY fan deposit address, and
deposits sit at those addresses until a sweep moves them. If a real mnemonic
sat in `.env` under the old layout, it is exactly as exposed as the treasury
key: whoever holds it can take any deposit before the platform's sweep does.
(If `DEPOSIT_MNEMONIC` was still a placeholder, or never set, until
`.env.workers` existed -- the case on the droplet as of 2026-09 -- there is
nothing to rotate; skip this.) Rotating it:

1. Generate a new mnemonic OFFLINE and derive its `DEPOSIT_XPUB`
   (`sudo -u onlyone node dist/scripts/derive-deposit-xpub.js < /dev/tty`).
   Do not install either yet.
2. With the OLD mnemonic still in `.env.workers` and the workers running
   normally, drain every existing deposit address: every `DepositAddress`
   row must hold no USDG, no $ONLYONE and at most dust ETH (check on the
   explorer). Do this after the treasury rotation above, so the sweeps land
   in the NEW treasury.

   **What moves by itself, and what does not.** The hourly reconciler
   (`workers/deposit-indexer.ts` reconcileSweeps) re-queues a sweep only for:
   an accepted stablecoin balance of a dollar or more at an address that has
   a STABLE deposit on record; native ETH at an address with a CREDITED ETH
   deposit (with `TRACK_NATIVE_ETH` on); and $ONLYONE at an address with a
   credited $ONLYONE deposit, only while `INDEX_ONLYONE_DEPOSITS` is on. A
   sweep that needs a gas top-up additionally needs a credited deposit of
   that asset and a balance worth a dollar. So these are **never** swept
   automatically:
   - a credited stablecoin balance under $1 (the reconciler's floor, and the
     top-up floor);
   - stablecoin at an address with no credited STABLE deposit (a transfer
     that priced to 0 cents, or one from before the indexer's start block);
   - any $ONLYONE while `INDEX_ONLYONE_DEPOSITS=false` (the recommended
     setting above -- it is never credited, so never swept);
   - ETH from a deposit that is still price-pending.

   **There is no tool in this repo that sweeps those today.** Moving them
   means signing from each deposit address with the OLD mnemonic, funding
   its gas from the treasury -- which is exactly the improvised hand-signing
   this runbook otherwise forbids. So a rotation that finds any of them
   needs an operator sweep script built FIRST (run with `.env.workers`;
   derive the index's signer and check it against the `DepositAddress` row
   the way `expectedDepositSigner` does; fund gas through the journaled
   top-up path under `withTreasuryLock`; ignore the dollar floor and credit
   status; one index and one token per run). Build it as part of the
   step-3 retirement work, which is already a prerequisite. Until then,
   list the stranded balances (index, token, amount) and treat the rotation
   as not finished -- do not install the new mnemonic over them.
3. Stop handing out addresses under the old mnemonic. **This needs a code or
   schema decision before it can be done**: today `POST /wallet/deposit-address`
   returns a user's existing row forever, and the indexer checks every row
   against the one `DEPOSIT_MNEMONIC` (a mismatch disables sweeping), so the
   old rows cannot simply coexist with a new mnemonic. The options -- retire
   the old rows (e.g. a `retiredAt` column the indexer stops watching once
   they are swept, and the API skips when issuing) and give every user a new
   address under the new xpub, or move to a new `CHAIN_ID`-scoped key
   generation -- are an owner/ops call, not something to improvise mid-
   rotation.
4. Once that exists: install the new `DEPOSIT_XPUB` in `.env` and the new
   `DEPOSIT_MNEMONIC` in `.env.workers`, restart both units, and tell users
   their deposit address has changed -- anything sent to an old address
   afterwards is at the mercy of whoever holds the old mnemonic.

## Treasury outflow journal

`onlyone-workers.service` has `StateDirectory=onlyone-workers`: systemd
creates `/var/lib/onlyone-workers` (owner `onlyone-workers`, mode 0700) and
exports it as `$STATE_DIRECTORY`. The workers append every signed treasury
outflow there (`treasury-outflow.jsonl`) once it is SIGNED and BEFORE
broadcasting it -- payouts, burns, hedges and gas top-ups alike. An attempt
that fails before it is signed (the treasury has no ETH for gas, an RPC error
estimating it) is refunded and never counted, so it cannot use up the daily
cap. The
automatic caps -- `PAYOUT_MAX_CENTS` / `PAYOUT_DAILY_MAX_CENTS`,
`TOKEN_BURN_BATCH_MAX_CENTS` / `TOKEN_BURN_DAILY_MAX_CENTS`,
`TREASURY_HEDGE_BATCH_MAX_CENTS` / `TREASURY_HEDGE_DAILY_MAX_CENTS` and the
hedge's token-side caps `TREASURY_HEDGE_BATCH_MAX_TOKENS` /
`TREASURY_HEDGE_DAILY_MAX_TOKENS` (whole $ONLYONE sold), and the deposit
sweep's gas top-ups `SWEEP_GAS_DAILY_MAX_GWEI` (default 5,000,000 gwei =
0.005 ETH, 100 top-ups of 0.00005 ETH; a sweep over it fails and retries,
and the hourly reconciler re-queues leftover stablecoin) plus at most
`SWEEP_GAS_PER_ADDRESS_DAILY` (default 3) top-ups per deposit address, only
for a balance worth a dollar or more, and journaled only once the top-up is
signed -- are
counted from it, so a restart or redeploy no longer reopens the 24h window
and nothing that can only write the database can shrink the count. If the
journal is missing, unreadable or corrupt, payouts are HELD (`treasury
outflow journal unavailable`) and burns/hedges defer; fix the directory,
restart the unit, then release the held payouts. Never delete the file to
"unstick" payouts -- that is exactly resetting the daily cap. Running the
workers by hand outside systemd needs `OUTFLOW_JOURNAL_DIR` set to a private
directory.

**Repairing a corrupt line** (the log says `outflow journal corrupt at line
N`). A torn or unterminated last line is repaired automatically at load;
damage anywhere else is refused on purpose. To repair it by hand:

1. `systemctl stop onlyone-workers`
2. Back the file up first:
   `cp -a /var/lib/onlyone-workers/treasury-outflow.jsonl /var/lib/onlyone-workers/treasury-outflow.jsonl.bak-$(date +%s)`
3. Edit line N. Each line is one JSON object
   (`{"at":…,"kind":…,"cents":…,"ref":…}`). If two entries are glued onto
   one line (`{…}{…}`), SPLIT them onto two lines -- never drop either. Remove
   only a fragment that is not a complete entry. Never remove a whole valid
   entry: each one is money the treasury signed, and removing it raises the
   daily cap by that much.
4. `systemctl start onlyone-workers`, confirm the error is gone in
   `journalctl -u onlyone-workers`, then release the HELD payouts.

**Clock corrections.** Entries are stamped with the system clock. If the
clock ran AHEAD and was then corrected, entries written meanwhile are dated
in the future; the journal pulls them back to "now" at load (the log says
`OUTFLOW JOURNAL: … in the FUTURE`) so they still count, but only for one
full 24h window. The clamped times are written back to the file (also when
the clock steps back while the workers are running), so a restart or
redeploy inside that window does not start it over. Automatic payouts, burns and hedges may therefore stay
HELD/deferred for up to 24h after a clock correction -- expected, not a
fault. Keep NTP (`timedatectl`) enabled on the droplet. Do NOT `release` a
payout held by `daily payout limit reached` during that window: the worker
re-checks the same journal, the clamped entries still count, and it is held
again within seconds. A payout that cannot wait is settled by hand as in
"Settling a payout by hand" above -- it is already HELD, so send it from the
treasury yourself, then `mark_sent` with the hash. Otherwise wait for the
24h window to pass, then release. Never remove journal entries to make room:
that raises the cap by exactly the money those entries represent.

The deposit indexer also refuses (logs an error, credits nothing) if the
`DepositAddress` table for the chain holds more than `DEPOSIT_ADDRESS_MAX`
(default 250,000) rows, rather than loading them all into the key-holding
process -- a flood of injected rows used to be a way to OOM-restart it.

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

## Moving the signing secrets out of .env

(One-time, for a droplet set up before `.env.workers` existed.) Such a box
has the treasury key and the mnemonic in `.env`, which the API and the media
workers load; `app-setup.sh` refuses to deploy until they are moved, and the
API and media workers refuse to start with either set. To move them:

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
