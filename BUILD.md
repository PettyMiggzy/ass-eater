# OnlyOne — build state

**What this file is:** the current state of the system, in one place. Not a
history. `MEMORY.md` is the decision log — why things are the way they are,
in the order they were decided. This is what they *are* today.

Last updated: 2026-09-18.

---

## The product

An 18+ creator platform. Fans subscribe to creators, tip them, unlock
pay-per-view content and messages, and buy from a marketplace. Creators keep
90% of everything.

There is also a token, `$ONLYONE`. **It is not money** — see [Token](#token).

**Domains**
| Host | Serves |
|---|---|
| `onlyass.fun` | the platform (default) |
| `onlyone1.fun` | same platform, second front door |
| `onlyass.xyz` | `/token` — token landing, no adult content |
| `onlyass.online` | `/gateway` — SFW entry page |
| `onlyass.shop` | `/marketplace` |

---

## Two stacks, and only one is deployed

**1. The live site** — Next.js 16 on Vercel, in `pages/` `lib/` `components/`
`proxy.js`. Data in Vercel Blob JSON manifests (a Postgres migration is
written and waiting — see [Blocked](#blocked-on-the-founder)). **This is what
is actually running.** It has no payments of any kind.

**2. `server/`** — Fastify + Postgres + Prisma + Redis. The whole money
system: ledger, fees, payouts, subscriptions, VIP, referrals, marketplace
orders, deposit indexing, the token burn worker. **Not deployed.** Everything
below marked *(server)* exists, is tested, and is not live.

A third piece, `contracts/`, holds `OnlyAssPayments.sol` (direct
wallet-to-wallet payment) and `OnlyAssCreatorNFT.sol` (ERC-1155 creator
drops). Neither is deployed. The launchpad contracts were removed.

---

## Money

**Credits are dollars.** 1 credit = $1. Always, with no exceptions and no
oracle. They are a number in the database, not a token.

```
fan sends USDC  →  bridges to Robinhood Chain, arrives as USDG
                →  credited, less a 2% purchase fee  →  98 credits per $100
fan spends credits on a creator
creator withdraws  →  USDG to their wallet  →  bridge out → USDC on Base
                   →  Coinbase, free, ~1 minute
```

The float can never run short: every credit that exists was created by a
dollar landing in the pool, and the dollar always arrives *before* the payout,
because nobody can spend credits they have not bought. The 2% fee leaves the
pool holding *more* than it owes.

**Credits never go backwards.** A fan cannot refund them, cash them out, or
send them to another person. That closed loop is what keeps this the
Twitch/Patreon model rather than the platform issuing its own dollar
instrument.

### Fees — flat, and nothing reduces them

| | Rate |
|---|---|
| Buying credits | 2% |
| Platform cut on everything | 10% |
| Marketplace | 15% (10% platform + 5% listing) |
| Creator instant payout | +2% (optional, skips the queue) |
| Withdrawal | $1 + 1% |
| Referral | 5% of the platform's own cut, 12 months |

**There are no discounts.** Not for VIP, not for referrals, not for paying in
any particular asset. Creator-set discounts are a later question; when built
they come out of the *creator's* side, never the platform's cut.

**Settlement asset:** USDG on Robinhood Chain (Global Dollar, Paxos). USDC has
no contract on that chain — the bridge converts both ways, so "USDC" is still
the right word for what a person brings and leaves with. Any dollar stablecoin
can be added to the allowlist in `server/src/lib/chain.ts` as config.

---

## Token

`$ONLYONE`. Launching on Robinhood Chain from the founder's own launchpad.
1 billion supply.

**It is never a payment method.** It buys nothing, prices nothing, settles
nothing, and creators are never paid in it. The rule lives in `lib/brand.js`
and `server/src/core/ledger.ts`'s `Balance` type. A token whose value the
platform declares *and* a market also sets has two prices, and the gap is
free money for whoever trades it.

**What it actually does:**

1. **VIP revenue buys and burns it.** Every $20 membership buys $ONLYONE on
   the open market and sends it to the dead address. Recurring buy pressure
   and permanent supply reduction, funded by revenue.
   *(server — `core/vip.ts`, `workers/token-burn.ts`)*
2. **Token-gated creators.** A creator sets how many tokens a fan must
   **hold** to see their page. Nothing is spent; the creator markets it.
   *(live site — `lib/token-gate.js`, off until the contract exists)*
3. **Per-creator token locks.** *(server — `modules/stake.ts`)*

Suggested supply split: liquidity pool 20–30%, public auction 30–40% (this is
what raises the USDC that fills the pool), founder/treasury 20–30% vested,
platform reserve ~10%, redemption contract **zero**.

---

## VIP — $20/month

Paid in credits. The fan never touches a wallet. **No discount** — sold on
perks alone, the way Twitch and YouTube memberships are.

| Perk | Status |
|---|---|
| Early access to posts (creator sets up to 72h) | built *(server)* |
| Badge | art done, not wired |
| Priority in creator inboxes | not built |
| First look at marketplace listings | not built |
| Top Supporter placement | not built |

Membership extends from the later of the current expiry and now, so paying
early never burns the remainder. It lapses; it is not permanent.

---

## Founding Creators — the first 100

Not the first 100 to sign up: **the first 100 approved with a finished
profile** (name, handle, 40+ character bio, a real avatar, ≥1 tag, ≥3 pieces
of content). Granted automatically at approval, capped at 100 server-side.

Perks: permanent badge, priority placement in Explore and the Marketplace
(a real sort), a referral link with a share kit, and 30 days at 0% platform
fee — whose clock starts when payments go live, not at signup, so the offer
still exists when there is a fee to waive (`PAYMENTS_LIVE_AT` in
`lib/founding.js`).

Public recruitment page: `/founding-creator`.

---

## Compliance

| | Status |
|---|---|
| Age verification (AgeChecker.Net) | **live** — real API, server-verified |
| 27-state geoblock, lifted by a verified cookie | **live** (`proxy.js`) |
| TAKE IT DOWN Act: public NCII report + 48h admin queue | **live** |
| Terms of Service / Privacy Policy | live (template — needs an attorney) |
| AI-content labelling | live (self-reported) |
| Content-violation ladder (30-day suspend → ban) | live |
| Payment-circumvention filter (Cash App/Venmo/etc.) | live |
| 18 U.S.C. §2257 statement | **not built** |
| Creator KYC | not built |

Content protection: right-click/drag/long-press save are blocked and media
carries a per-viewer watermark code (`lib/viewer-mark.js`). **Screenshots
cannot be blocked by any website** — the goal is traceability, not
prevention, and creators are told exactly that.

---

## What is live right now

Signup and login (fans may use a username instead of an email), creator
profiles and galleries, tags and browse-by-tag, search, favourites, DMs, the
wall, the marketplace (browse and list — **buying is not built**), the admin
panel, age verification, the takedown process, and the Founding Creator
programme.

**No payments. Nothing on the live site can charge anyone.**

---

## Blocked on the founder

1. **A Postgres database.** Create at neon.tech, put the connection string in
   Vercel as `DATABASE_URL`. The migration is written, tested and committed —
   then reverted on the branch tip so production stays up without it. Until
   this is done, `data/creators.json` and every other manifest is **readable
   by anyone with the URL**. This is the most urgent item.
2. **`onlyone1.fun` returns 403** from Vercel Firewall.
3. Rotate the Venice key when this build is finished (it has been pasted into
   a transcript).
4. Decide: the `$ONLYONE` deposit balance has no consumer since VIP became
   paid — see MEMORY.md.

---

## Running it

```bash
npx next build                      # the live site
node --experimental-test-module-mocks --no-warnings --import ./test-register.mjs \
  lib/session.test.mjs              # and lib/blob-json-store.test.mjs
node lib/payment-circumvention-filter.test.js

cd server
service postgresql start && service redis-server start
npx prisma db push && npx vitest run # 68 tests
npx tsc --noEmit

npx hardhat test                    # contracts
```

**This branch deploys straight to production.** Every push to
`claude/ecstatic-ride-g21n07` builds with `target: "production"`. There is no
staging. Run the checks before pushing, not after.

---

## Secrets

Never committed. `.env.local` is gitignored; production values live in Vercel
as **Secret**-type env vars.

`SESSION_SECRET`, `BLOB_READ_WRITE_TOKEN`, `ADMIN_UPLOAD_KEY`,
`NEXT_PUBLIC_AGECHECKER_KEY`, `AGECHECKER_SECRET_KEY`, `OWNER_ACCESS_KEY`,
`VENICE_API_KEY`, and — once the payment stack deploys — `DATABASE_URL`,
`ORDERS_ENCRYPTION_KEY`, `TREASURY_PRIVATE_KEY`, `DEPOSIT_MNEMONIC`.
