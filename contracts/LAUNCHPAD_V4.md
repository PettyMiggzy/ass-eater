# OnlyAssLaunchpadV4 + OnlyAssLaunchpadHook

Uniswap V4 rebuild of `OnlyAssLaunchpad` (still in the repo, unchanged --
see `LAUNCHPAD.md`): a creator pays a flat ETH fee, deploys a brand-new
fixed-supply ERC20, and this contract atomically creates + seeds its V4 pool
paired against **$ONLYASS** (never ETH/WETH), in the same transaction. On top
of that, every launch now gets a fixed 1% platform swap fee plus the
creator's own configurable trading tax, and a one-time "graduation bonus"
once a pool hits a volume milestone.

## Why V4, and what changed from the V2 launchpad

V2 has no concept of a per-pool custom fee -- a swap fee is a fixed choice
baked into the pair contract itself (or, for most V2 forks, not
configurable per-pair at all). V4's **hooks** let a pool run arbitrary code
on every swap, which is what makes a creator-configurable tax and a
non-adjustable platform cut possible without forking Uniswap's core
contracts. `OnlyAssLaunchpadHook.sol` is that hook; `OnlyAssLaunchpadV4.sol`
is the launchpad that deploys tokens, creates pools, seeds liquidity, and
attaches the hook to every one of them.

## What it does

`launchToken(params)`, all in one transaction:

1. Takes the flat `launchFeeWei` (0.01 ETH by default) plus the creator's
   $ONLYASS contribution (`onlyAssForLiquidity` -- caller must `approve()`
   the launchpad beforehand), forwarding the fee straight to the platform
   wallet.
2. Deploys a new `LaunchedToken` (same fixed-supply, no-mint-function
   contract the V2 launchpad uses) and splits its supply three ways:
   `platformSupplyBps` (10% default) to the platform wallet,
   `tokenLiquidityBps` (creator-chosen, 50-90% given the defaults) into the
   pool, the rest to the creator.
3. Registers the pool with `OnlyAssLaunchpadHook`, locking in the creator's
   chosen `creatorTaxBps` (capped at 10%) and where their cut of every future
   swap goes.
4. Initializes the `TOKEN/$ONLYASS` V4 pool at a price computed on-chain from
   the two seeded amounts (`OnlyAssSqrtPriceMath` -- same sqrtPriceX96 math
   `v3-pool-math.js` already uses for V3, just done in Solidity so a creator
   supplies plain token amounts instead of a pre-computed price) and mints a
   full-range liquidity position through the canonical `PositionManager`.
5. Holds the resulting position (an ERC-721, not an ERC-20 like V2's pairs)
   in escrow for `LOCK_DURATION` (180 days, same constant as V2). After that,
   `withdrawLiquidity(launchId)` lets only the original creator claim it.

On every swap against that pool, `OnlyAssLaunchpadHook.afterSwap` takes a
fixed 1% platform fee plus that pool's creator tax, in the swap's output
currency, and sends both cuts **directly** out of the PoolManager to their
final recipients via `poolManager.take(currency, recipient, amount)` -- the
hook never holds a balance of anything.

## Fee model

- **Platform fee: fixed 1% (`PLATFORM_FEE_BPS = 100`), on every swap, in
  both directions ("1% each side").** No setter exists for this at all --
  not owner-adjustable, by design, per the explicit ask that this be a fixed
  cut the platform can't later raise.
- **Creator trading tax: 0-10% (`MAX_CREATOR_TAX_BPS = 1_000`), set once at
  launch time, per pool.** The 10% ceiling is a deliberate anti-honeypot
  rail, the same "hard cap survives a compromised/malicious setter"
  philosophy as `OnlyAssLaunchpad`'s `MAX_PLATFORM_SUPPLY_BPS` -- without it,
  nothing would stop a launch from setting a nominal tax that quietly makes
  selling impossible.
- **The pool's own native V4 LP fee is always 0.** 100% of the trading fee
  goes through the hook (platform + creator), not split with a separate
  native-fee mechanism -- one fee mechanism to reason about, not two.

## The graduation bonus

Once a pool's cumulative $ONLYASS volume (tracked by the hook, purely as a
counter) reaches `graduationOnlyAssVolumeThreshold` (500,000 $ONLYASS
default), anyone can call `triggerGraduationBonus(launchId)`, which pays the
launching creator `graduationCreatorBonusWei` (0.5 ETH default) and the
platform wallet `graduationPlatformBonusWei` (0.5 ETH default) -- once, ever,
per launch.

This is **not** funded automatically out of trading fees. It's a deliberate
choice: the fee hook only ever moves the ERC-20/currency it's already
handling, never ETH, which keeps the highest-risk contract in this codebase
(the hook, attached to every launch, running on every swap) as simple as
possible. The bonus instead draws from this contract's own ETH balance,
which anyone can top up via `fundGraduationPool()` -- the platform is
expected to fund it deliberately (e.g. out of launch-fee revenue), not have
it self-fund silently. If the balance is short, `triggerGraduationBonus`
reverts with `GraduationPoolUnderfunded` rather than paying a partial bonus.

All three graduation numbers (threshold, creator bonus, platform bonus) are
owner-adjustable via `setGraduationParams` -- they're a business knob, like
`launchFeeWei`/`platformSupplyBps`, not a protocol constant.

**Why cumulative $ONLYASS volume, not ETH volume, as the milestone metric:**
these pools never trade against ETH at all (always `TOKEN/$ONLYASS`), so
there's no native on-chain ETH volume signal to threshold against. $ONLYASS
volume is the one metric every launch's pool actually produces, and it's
comparable across launches since every pool shares that leg.

## Design decisions for an auditor

- **The hook is deployed via CREATE2 through a purpose-built
  `HookDeployer.sol`, with a salt mined by `scripts/mine-hook-salt.js` /
  `scripts/lib/hook-miner.js`.** Uniswap V4 decides which callbacks fire by
  reading the low 14 bits of the hook contract's own address (see
  `Hooks.sol`), so this is required, not optional -- there is no way to
  register a hook's permissions after deployment. The hook's constructor
  calls `Hooks.validateHookPermissions` against its own address, so a
  mis-mined address fails to deploy rather than silently running with the
  wrong permissions.
- **The hook never holds a balance.** Every fee `take()` call sends straight
  to its final recipient (`platformWallet` / that pool's `creatorWallet`),
  never to the hook itself -- there's nothing sitting in this contract for a
  bug or a compromised key to steal, unlike the reference pattern in
  Uniswap's own `src/test/FeeTakingHook.sol` (which takes to itself first).
- **Registering a pool is one-time and launchpad-gated
  (`registerPool`/`onlyLaunchpad`), and `afterSwap` reverts (fail-closed) on
  an unregistered pool** rather than silently waiving fees. In practice a
  pool can only ever exist with this hook attached if the launchpad just
  created and registered it atomically in the same transaction, so this
  should never actually trigger outside of an attacker deploying their own
  V4 pool with the same hook address and no registration.
- **`launchpad` is settable once, not immutable, on the hook.** This breaks
  a real circular dependency: the launchpad's constructor needs the hook's
  address, so the hook can't know the launchpad's address until after the
  launchpad itself is deployed. `LaunchpadAlreadySet` blocks it from ever
  being changed again after that one call.
- **The LP position is an ERC-721 held in escrow, not decomposed.**
  `withdrawLiquidity` transfers the NFT itself to the creator after
  `LOCK_DURATION` -- it does not remove liquidity or return underlying
  tokens on the creator's behalf. Same escrow-then-handover semantics as
  V2's LP-ERC20 escrow, just for the token standard V4 actually uses.
- **`OnlyAssSqrtPriceMath` has a documented, tested mathematical ceiling**
  (~1.8e19:1 on the amount1:amount0 ratio, past which the Q192 intermediate
  no longer fits in 256 bits) and reverts with a clear `RatioOutOfRange`
  instead of an opaque `require(denominator > prod1)` failure three call
  frames deep inside `FullMath`. Not a realistic launch scenario given
  `MIN_LIQUIDITY_BPS`, but worth knowing the failure mode is a clean revert.
- **Currency sorting, tick range, and pool fee are fixed, not
  creator-configurable**: `POOL_FEE = 0` always (see fee model above),
  `TICK_SPACING = 60` always, full-range liquidity always
  (`TickMath.minUsableTick`/`maxUsableTick`). Fewer knobs, fewer ways for a
  creator (or a bug) to seed a broken pool.

## Testing status -- read before mainnet use

Unlike most V4 integrations built without Foundry, this one is **not**
mock-only. `@uniswap/v4-core` ships Foundry-only build artifacts (no
prebuilt Hardhat-compatible bytecode), so this repo forces Hardhat to
compile the real, unmodified `PoolManager` / `PositionManager` / `Permit2` /
`PoolSwapTest` contracts directly from their npm-published source
(`contracts/test/V4TestDeployment.sol` + `PermitTestDeployment.sol`, split
across those two files purely because Permit2 is pinned to a different exact
solc version upstream) and deploys all of them fresh in
`test/OnlyAssLaunchpadV4.integration.test.js`. That suite exercises the real
end-to-end path: deploy token → init V4 pool → seed full-range liquidity via
`PositionManager` → **real swap through `PoolSwapTest`** → confirms the fee
split lands in both wallets' actual balances (not just emitted events) →
LP escrow lock/withdraw lifecycle → graduation bonus threshold/payout/double-pay
guard.

What that *doesn't* cover, and still needs before mainnet:

- **Foundry-based fuzzing/invariant testing.** This suite is a handful of
  directed happy-path/revert-path cases on Hardhat's local EVM, not the
  property-based testing a V4 hook audit expects (v4-core's own repo ships
  `Fuzzers.sol` for exactly this). `OnlyAssSqrtPriceMath` has its own
  pure-math unit tests (`test/onlyass-sqrt-price-math.test.js`) but nothing
  here fuzzes the hook's fee-taking path against adversarial swap sizes,
  multiple concurrent pools, or hostile hookData.
- **A professional audit.** This is the highest-risk contract pair in this
  codebase -- real fee custody, novel-to-this-repo V4 mechanics, and money
  moving on every single swap of every launch, not just at launch time.
- **Never run against Robinhood Chain itself**, only Hardhat's local EVM.
  See the EVM-version note below.

## Slither findings (all accepted, none changed)

Ran `slither . --compile-force-framework hardhat` -- 9 findings across the
two new contracts (a 10th, a naming-convention nit on a parameter name, was
just fixed instead of accepted), all reviewed:

- **`arbitrary-send-eth` on `triggerGraduationBonus`.** Flags sending ETH to
  `l.creator` -- but that address is fixed at launch time (`launchToken`
  records `msg.sender` once, immutably) and nothing in this function lets the
  caller redirect it elsewhere; "arbitrary" here just means "not a
  compile-time constant," same shape as V2's already-accepted LP-escrow
  payout pattern.
- **`unused-return` on `positionManager.initializePool`'s returned tick.**
  Nothing here needs the pool's tick immediately after initializing it --
  same reasoning as V2's already-accepted `unused-return` on `addLiquidity`.
- **`reentrancy-benign` (x2)**: state writes after external calls, in
  `OnlyAssLaunchpadHook.afterSwap` (the volume counter, after the `take()`
  calls) and in `OnlyAssLaunchpadV4.launchToken`/`_deployAndSeed` (`launches`
  array, after the fee forward + pool seeding calls). `afterSwap` is gated
  `onlyPoolManager` and never calls back into `poolManager.swap()` itself, so
  there's no path to reenter it mid-callback and double-count volume;
  `launchToken` is `nonReentrant`, same as V2's already-accepted identical
  finding.
- **`reentrancy-events`**: `FeeTaken` emitted after the `take()` calls it
  reports on. Ordering only, not exploitable.
- **`timestamp`**: `withdrawLiquidity`'s `block.timestamp < l.unlockTime`
  check -- same 180-day lock, same already-accepted reasoning as V2.
- **`assembly` in `HookDeployer.deploy`**: the CREATE2 opcode has no
  non-assembly Solidity spelling. Required, not incidental.
- **`low-level-calls` (x3)**: the `.call{value: ...}` pattern for the launch
  fee and both graduation bonus payouts, all `nonReentrant`-guarded -- same
  reasoning as V2/`OnlyAssPayments`'s already-accepted findings (supports
  smart-contract-wallet recipients; `.transfer`'s 2300 gas stipend breaks
  those).

## What still needs a human before mainnet

- **Real `PoolManager` / `PositionManager` / `Permit2` addresses for
  Robinhood Chain**, verified the same way `LAUNCHPAD.md` already insists on
  for V2's factory/router: open a real wallet, start a swap or add-liquidity
  flow on the real chain, and read the exact address your wallet is about to
  call. Do not take these from a doc page or a "verified address list" site.
  Permit2's canonical address (`0x000000000022D473030F116dDEE9F6B43aC78BA3`
  on most EVM chains) is a much more widely-attested constant than a random
  launch platform's contracts, but still confirm it's actually deployed
  there before trusting it -- it is passed in as a constructor argument, not
  hardcoded, specifically so this repo never has to assume it.
- **Confirm Robinhood Chain's EVM supports Cancun (EIP-1153 transient
  storage).** V4's `PoolManager` uses transient storage internally
  (`tstore`/`tload`, flagged by solc's own compiler warning during `npm run
  contracts:compile`); this repo's Hardhat config compiles the V4 contracts
  with `evmVersion: "cancun"` to emit those opcodes, but nothing here has
  confirmed the target chain's EVM actually executes them. If it doesn't,
  this isn't a bug in these contracts -- it's Uniswap's own `PoolManager`
  simply not functioning on that chain at all, which would block using V4
  there under any implementation, not just this one.
- **`node_modules/permit2` and `node_modules/solmate` are symlinks**,
  recreated by `scripts/postinstall-permit2-link.js` on every `npm install`
  (see that file's header for why -- Foundry-style bare imports bundled
  inside `@uniswap/v4-periphery`, which Hardhat has no remapping mechanism
  for). If a fresh clone fails to compile with an "is not installed" error
  naming `permit2` or `solmate`, run `npm install` again (the postinstall
  hook should have created them) or `node
  scripts/postinstall-permit2-link.js` directly.
- **`LOCK_DURATION` (180 days), `MAX_CREATOR_TAX_BPS` (10%), and the
  graduation bonus defaults (500,000 $ONLYASS / 0.5 ETH / 0.5 ETH) are this
  session's defaults**, not numbers specified beyond "half ETH and half ETH"
  for the bonus split itself. Worth a deliberate yes/no before mainnet, same
  as V2's `LOCK_DURATION`/`MIN_LIQUIDITY_BPS` defaults.
- **No deploy to mainnet from this session.** Same boundary as every other
  contract here: a real deployer private key never gets generated, accepted,
  or transmitted in this chat. Use `npm run
  launchpad-v4:deploy:robinhood-testnet` / `launchpad-v4:deploy:robinhood`
  from your own machine with your own key, after setting
  `PLATFORM_WALLET_ADDRESS` / `ONLYASS_TOKEN_ADDRESS` /
  `V4_POOL_MANAGER_ADDRESS` / `V4_POSITION_MANAGER_ADDRESS` /
  `PERMIT2_ADDRESS`.

## Local dev

```
npm run contracts:compile
npm run contracts:test
```

`scripts/mine-hook-salt.js` previews the hook's mined address without
deploying anything (needs an already-deployed `HookDeployer` -- the real
deploy flow, `scripts/deploy-launchpad-v4.js`, does this mining inline as
part of one atomic deploy sequence instead).
