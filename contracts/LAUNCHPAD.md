# OnlyAssLaunchpad

A self-serve token launchpad: a creator pays a flat ETH fee, deploys a
brand-new fixed-supply ERC20, and the launchpad seeds that token's Uniswap V2
pool paired against **$ONLYASS** (never ETH/WETH) in the same transaction.

## What it does

`launchToken(params)`:

1. Takes a flat `launchFeeWei` (0.01 ETH by default) plus the creator's
   $ONLYASS contribution to the pool (`onlyAssForLiquidity` -- caller must
   `approve()` the launchpad for this beforehand).
2. Deploys a new `LaunchedToken` (fixed supply, minted once, no further
   minting possible).
3. Splits that supply three ways: `platformSupplyBps` (10% by default) to the
   platform wallet, `tokenLiquidityBps` (creator-chosen, must be 50-90% given
   the defaults) into the pool, and whatever's left straight to the creator.
4. Creates the `TOKEN/$ONLYASS` Uniswap V2 pair and calls `addLiquidity` with
   the committed tokens + $ONLYASS.
5. Holds the resulting LP position in escrow for `LOCK_DURATION` (180 days,
   a constant -- not owner-adjustable, so the lock term can never be changed
   retroactively for an existing launch even if the launchpad's owner key
   were compromised). After that, `withdrawLiquidity(launchId)` lets only the
   original creator pull it out.
6. Forwards the ETH launch fee to the platform wallet.

## Design decisions for an auditor

- **Paired with $ONLYASS, not WETH, by construction.** `onlyAssToken` is
  `immutable`, set once at deploy time. Every launch's pool is
  `TOKEN/$ONLYASS`; there is no code path that creates a WETH pair.
- **The new token can never inflate.** `LaunchedToken` mints its entire
  supply once, in the constructor, to the launchpad. No `mint()` function
  exists on the deployed token at all.
- **LP tokens are escrowed, not handed to the creator immediately.** This is
  the anti-rug mechanic: a creator can't deploy, seed a pool, and immediately
  drain the liquidity in the same block. `MIN_LIQUIDITY_BPS` (50%) also stops
  a creator from keeping ~100% of supply and seeding the pool with dust.
- **`isTrackedPair` blocks `rescueERC20` from ever touching a locked LP
  token**, even though `rescueERC20` is `onlyOwner`. This closes the one path
  a compromised owner key could otherwise use to steal a creator's
  still-locked liquidity before `LOCK_DURATION` elapses -- same "hard limit
  survives a compromised owner key" philosophy as `OnlyAssPayments`'s
  `MAX_FEE_BPS`.
- **`MAX_PLATFORM_SUPPLY_BPS = 2000` (20%) is a hard ceiling** on
  `platformSupplyBps`, enforced in the setter, for the same reason.
- **Params are passed as a struct (`LaunchParams`)**, not individual
  arguments -- `launchToken` has enough parameters that the Solidity compiler
  hits "stack too deep" otherwise. Purely a compiler constraint, no
  behavioral difference.
- **The `getPair` existence check was deliberately removed.** Because
  `LaunchedToken` is always freshly deployed inside the same call, its
  Uniswap pair can never already exist -- `createPair` is called
  unconditionally instead of checking first, removing dead code.
- **`.call` instead of `.transfer`/`.send` for the ETH fee**, guarded by
  `nonReentrant` -- same reasoning as `OnlyAssPayments` (`.transfer`'s 2300
  gas stipend breaks payouts to smart-contract wallets).

## Slither findings (all accepted, none changed)

Ran `slither . --compile-force-framework hardhat` -- 6 findings, all on
`OnlyAssLaunchpad`, all reviewed and accepted:

- **`unused-return` on `addLiquidity`'s `(amountA, amountB, ...)`.** Only
  `liquidity` is used. Since the pair is always brand new (see above),
  Uniswap's `addLiquidity` always uses exactly the desired amounts on a
  fresh pool -- there's no scenario here where `amountA`/`amountB` differ
  from what was approved, so there's nothing meaningful to check.
- **`reentrancy-benign` (x2)**: state writes (`isTrackedPair`, `launches`)
  after external calls, inside `_deployAndSeed`/`launchToken`. Both entry
  points are `nonReentrant`, so no reentrant call into this contract can
  observe the intermediate state Slither is warning about.
- **`timestamp`**: `withdrawLiquidity`'s `block.timestamp < l.unlockTime`
  check. Standard time-lock pattern; miner/validator timestamp manipulation
  is on the order of seconds, irrelevant against a 180-day lock.
- **`low-level-calls` (x2, one on each contract)**: the `.call{value: ...}`
  pattern, already explained above and in `OnlyAssPayments`'s own README.

## What still needs a human before mainnet

- **Uniswap V2 factory/router addresses for the target chain.** The deploy
  script takes these as required env vars rather than hardcoding them --
  verify the real addresses on Blockscout (or wherever the target chain's
  block explorer is) before deploying. Getting this wrong means either the
  deploy reverts (wrong interface) or, worse, silently pairs against a fake
  factory. This is the exact same class of mistake as guessing a stablecoin
  address -- don't.
- **`LOCK_DURATION` (180 days) and `MIN_LIQUIDITY_BPS` (50%) are my
  defaults**, not numbers you specified. Reasonable for an anti-rug
  mechanic, but worth a deliberate yes/no before mainnet since they're
  compile-time constants -- changing them means redeploying the whole
  launchpad (though not any already-launched tokens/pools, which are
  independent contracts).
- **No deploy to mainnet from this session** -- same boundary as
  `OnlyAssPayments`: a real deployer private key never gets generated,
  accepted, or transmitted in this chat. Use `npm run
  launchpad:deploy:robinhood-testnet` / `launchpad:deploy:robinhood` from
  your own machine with your own key.

## Local dev

```
npm run contracts:compile
npm run contracts:test
```

19 tests for `OnlyAssLaunchpad` (29 total across both contracts), run against
the **real** Uniswap V2 factory/router/pair contracts (via `@uniswap/v2-core`
and `@uniswap/v2-periphery`'s prebuilt bytecode, deployed fresh in each test)
rather than mocks -- covers fee/param validation, supply distribution math,
actual pool creation and reserve seeding, LP escrow and the lock/withdraw
lifecycle, the rescue-can't-touch-locked-LP guarantee, and admin/pause
controls.
