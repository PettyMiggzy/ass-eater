# Deploying the Only Ass backend to the droplet

**Why this is a manual runbook and not something run automatically:** the
Claude session that wrote this can only reach the internet over HTTPS
through a sandboxed proxy -- it cannot open a raw SSH (port 22) connection
to your droplet from where it runs, even with the `onlyass_do` deploy key.
So these steps need to be run by you (or in a Claude Code session that
actually has shell access to the box, e.g. one running on your own
machine or in an environment with unrestricted networking).

Target: `206.189.216.202`, chain: Robinhood Chain (id 4663).

## 1. Get the code onto the box

From your own machine, with the `onlyass_do` private key (or your own SSH
access to the droplet):

```bash
git clone <your repo url> onlyass
scp -r onlyass/server root@206.189.216.202:/opt/onlyass/server
# or, on the droplet itself: git clone <your repo url> /opt/onlyass/checkout
#                            cp -r /opt/onlyass/checkout/server /opt/onlyass/server
```

## 2. System setup (run once, as root, on the droplet)

```bash
cd /opt/onlyass/server/deploy
bash provision.sh
```

This installs Node 22, Postgres, Redis, nginx, ufw, creates the `onlyass`
system user, and creates the `onlyass` Postgres role + database. It prints
a reminder to change the Postgres password from the placeholder.

## 3. Fill in `.env` -- directly on the box, never through chat

```bash
cd /opt/onlyass/server
cp .env.example .env
nano .env   # or vim
```

Fill in for real:
- `DATABASE_URL` -- use the Postgres password you set in step 2
- `JWT_SECRET` -- long random string (`openssl rand -hex 32`)
- `WEB_ORIGIN` -- `https://onlyass.fun`
- `TREASURY_PRIVATE_KEY` -- the mainnet wallet key you generate yourself.
  **Generate this on the droplet or on a machine you trust, never paste
  it into any chat session, including this one.**
- `DEPOSIT_MNEMONIC` -- same rule: generate it locally, paste only into
  this file, on this box.
- `USDC_ADDRESS` -- the real USDG/stablecoin contract address on Robinhood
  Chain. **Verify this yourself** on
  https://robinhoodchain.blockscout.com or https://docs.robinhood.com/chain
  before setting it -- an unverified/wrong address here means deposits
  silently go unrecognized. (Bridging USDC onto Robinhood Chain delivers
  USDG, not native USDC -- there is no native USDC contract on this chain.)
- `ONLYASS_TOKEN_ADDRESS` -- once $ONLYASS is deployed or bridged onto
  Robinhood Chain.
- `RPC_URL` is already set to `https://rpc.mainnet.chain.robinhood.com` in
  `.env.example` -- keep it, or swap in a private RPC provider endpoint if
  you get one.
- S3/Bunny, Sumsub, LiveKit vars once you have those accounts.

## 4. App setup (run once, as root)

```bash
cd /opt/onlyass/server/deploy
bash app-setup.sh
```

This runs `npm ci`, `prisma migrate deploy`, builds the TypeScript, installs
the `onlyass-api` and `onlyass-workers` systemd services, and wires up the
nginx reverse proxy on port 80.

## 5. TLS

Point `api.onlyass.fun`'s DNS A record at `206.189.216.202`, then:

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d api.onlyass.fun
```

## 6. Verify

```bash
systemctl status onlyass-api onlyass-workers
journalctl -u onlyass-api -f
curl https://api.onlyass.fun/health                    # {"ok":true}
curl https://api.onlyass.fun/messages/conversations     # 401 (no token) -- confirms auth is wired up, not a connection error
```

Once this is confirmed reachable over HTTPS, a Claude session (including
this one) can hit `https://api.onlyass.fun/...` directly to help verify
behavior and debug -- HTTPS is the one thing this sandbox's network policy
already allows out.

## Redeploying after code changes

```bash
cd /opt/onlyass/server
sudo -u onlyass git pull   # or re-scp
sudo -u onlyass npm ci
sudo -u onlyass npx prisma migrate deploy
sudo -u onlyass npm run build
systemctl restart onlyass-api onlyass-workers
```
