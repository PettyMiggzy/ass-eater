# Launching $ONLYASS + the launchpad on Robinhood Chain

Real order of operations. The launchpad can't do anything useful until
$ONLYASS itself exists and has a market — creators launching their own token
need $ONLYASS to pair it against.

## 1. Deploy $ONLYASS itself

```
ONLYASS_TOTAL_SUPPLY="1000000000" npm run onlyass:deploy-token:robinhood
```

`contracts/OnlyAssToken.sol` — fixed supply, minted entirely to the deployer
in the constructor, no mint function ever exposed (same pattern as
`LaunchedToken.sol`, which the launchpad tests already exercise). Prints the
deployed address. Set it as `ONLYASS_TOKEN_ADDRESS` everywhere that's read:
`server/.env`, this deploy step's own env for step 3, and
`NEXT_PUBLIC_CONTRACT_ADDRESS` in Vercel.

## 2. Verify the Uniswap V3 addresses yourself before step 3

**Do not paste in an address from a doc page, a "verified contract list" site,
or search results.** Research for this project found Uniswap v2/v3/v4 are
confirmed live on Robinhood Chain by Uniswap Labs' own blog, but could not
independently confirm any specific factory/router/position-manager address —
Uniswap's own governance-tracked deployment repo
(`Uniswap/v3-new-chain-deployments`) has no Robinhood Chain entry, and the
general search results for "Robinhood Chain contract addresses" are full of
unofficial sites with the exact pattern of address-poisoning/phishing content
that clusters around hyped new chains.

The one channel that can't lie to you: open the real **app.uniswap.org**,
connect your own wallet, switch network to Robinhood Chain, and start a swap
or an add-liquidity flow. Your wallet's transaction preview will show you the
exact contract address it's about to call — copy that, not something you read.
You need:

- `UNISWAP_V3_POSITION_MANAGER_ADDRESS` (for step 3, seeding the pool)
- `UNISWAP_V3_ROUTER_ADDRESS` + `UNISWAP_V3_QUOTER_ADDRESS` (for
  `server/.env`, so `treasury-hedge.ts` can eventually convert incoming
  $ONLYASS deposits — see below, not needed to launch)
- `UNISWAP_V2_FACTORY_ADDRESS` + `UNISWAP_V2_ROUTER_ADDRESS` (for the
  launchpad itself, step 4 — creator token launches use V2 pairs)

Confirmed already, safe to use as-is (first-party, from `docs.robinhood.com/chain/contracts`):
- WETH: `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`
- USDG: `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`

## 3. Seed $ONLYASS's first market

Pick a price and liquidity amounts (this is a business decision — how much
$ONLYASS + how much WETH/USDG you're willing to put up, and what price that
implies). Then:

```
ONLYASS_TOKEN_ADDRESS=0x... \
ONLYASS_POOL_QUOTE_ADDRESS=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 \
UNISWAP_V3_POSITION_MANAGER_ADDRESS=0x... \
ONLYASS_INITIAL_PRICE="0.002" \
ONLYASS_LIQUIDITY_AMOUNT="5000000" \
ONLYASS_LIQUIDITY_QUOTE_AMOUNT="10000" \
npm run onlyass:seed-pool:robinhood
```

`scripts/seed-onlyass-pool.js` creates and initializes the Uniswap V3 pool at
your chosen price, then mints a full-range liquidity position. It refuses to
run if your two liquidity amounts imply a price more than 1% off from
`ONLYASS_INITIAL_PRICE` — that mismatch is almost always a typo, and this is
the one transaction where a typo becomes the permanent opening price. The
price/tick math itself is unit tested (`test/v3-pool-math.test.js`) and
integration tested against real Uniswap V3 factory/pool bytecode
(`test/v3-pool-seed-integration.test.js`), not just self-consistency checked.

If you're pairing against WETH, wrap ETH into WETH first (call WETH's
`deposit()` with the ETH value) — the script expects the quote token already
in ERC-20 form, it doesn't wrap ETH for you.

The script prints `ONLYASS_POOL`, `ONLYASS_IS_TOKEN0`,
`ONLYASS_POOL_TOKEN0_DECIMALS`/`_TOKEN1_DECIMALS`, and `ONLYASS_POOL_FEE` at
the end — set all of those in `server/.env` so `lib/price.ts`'s oracle and the
`treasury-hedge` worker can read the real market instead of a pre-launch
override.

## 4. Deploy the launchpad

Only after 1–3. Needs the V2 factory/router from step 2:

```
PLATFORM_WALLET_ADDRESS=0x... \
ONLYASS_TOKEN_ADDRESS=0x... \
UNISWAP_V2_FACTORY_ADDRESS=0x... \
UNISWAP_V2_ROUTER_ADDRESS=0x... \
npm run launchpad:deploy:robinhood
```

See `contracts/LAUNCHPAD.md` for the contract's own design notes and the
Slither review.

## If Thursday arrives before step 2 is actually confirmed

Do steps 1–4 on **Robinhood Chain testnet** (chain `46630`, the
`*:robinhood-testnet` npm scripts) instead of mainnet. A testnet launch you
can demo and iterate on beats a mainnet one built on an address nobody
personally verified. Flip to mainnet once the router address is confirmed
through your own wallet, not before.
