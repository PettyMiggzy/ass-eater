# OnlyAssPayments

Non-custodial paywall payment contract for the Only Ass platform.

## What it does

A fan calls `payWithETH`, `payWithOnlyAss`, or `payWithCreatorToken` with a
creator's payout wallet, a `creatorId`, and a `contentId`. The contract
splits the payment atomically in the same transaction: `platformFeeBps`
(currently intended to be set to 1000 = 10%) goes to `platformWallet`, the
remainder goes straight to the creator's wallet. The contract never holds a
balance between transactions — there is no escrow and no custody. A
`Purchase` event is emitted so the backend can verify the payment on-chain
and unlock content.

**`payWithCreatorToken`** lets a fan pay in a creator's *own* token — but
only a token that creator actually launched through `OnlyAssLaunchpadV4`,
checked live on-chain against the launchpad's real launch records every
single call (`_isLaunchedByCreator`, no admin allowlist, nothing cached).
This is what makes "creators can get paid in their own launched token" true
without the platform having to vouch for or track which tokens are
legitimate — the launchpad already is that record. `launchpad` is an
owner-settable address (constructor arg or `setLaunchpad`), so this can
still deploy before the launchpad exists — `payWithCreatorToken` just stays
disabled (`LaunchpadNotSet`) until it's wired up.

## Design decisions or documentation for an auditor

- **Non-custodial by design.** Funds move straight from fan to creator/platform
  in one transaction. There's no withdrawal function for the "escrow balance"
  because there never is one — `rescueERC20` exists only to recover tokens
  sent to the contract by accident (e.g. a plain `transfer` instead of calling
  a payment function), not routine funds.
- **`.call` instead of `.transfer`/`.send` for ETH.** Deliberate — `.transfer`'s
  2300 gas stipend breaks payouts to smart-contract wallets (Safe/Gnosis,
  smart-contract creator wallets). `nonReentrant` on both payment functions is
  the mitigation for `.call`'s reentrancy surface.
- **`MAX_FEE_BPS = 3000`.** Hard ceiling so `onlyOwner` can never set an
  abusive fee, even if the owner key were compromised.
- **No pull-based creator/fee address list.** Both functions take the payout
  address as a parameter rather than looking it up on-chain. The contract
  intentionally doesn't know about "creators" — that mapping lives in the
  platform's off-chain database (Vercel Blob). This keeps the contract small
  and avoids putting mutable user data on-chain, but it means **the backend
  is responsible for checking that `creatorWallet` in the `Purchase` event
  matches the wallet currently on file for `creatorId` before unlocking
  content** — otherwise a client could pay an arbitrary address and still
  claim a `creatorId`. The contract itself has no way to be tricked out of
  funds by this; the risk is purely "fan unlocks content without the right
  creator being paid," which is a backend verification concern, not a
  contract bug.
- **`Pausable`.** `onlyOwner` can pause new payments (e.g. if the fee wallet
  key is compromised) without needing to redeploy.
- Built on OpenZeppelin 5.x (`Ownable`, `ReentrancyGuard`, `Pausable`,
  `SafeERC20`) rather than hand-rolled equivalents.
- **`_isLaunchedByCreator` loops the creator's launches and calls the
  launchpad once per launch.** Both `IOnlyAssLaunchpadV4Views` functions it
  calls are `view` (compiled to `STATICCALL`, so they're incapable of
  reentering this contract's state regardless of what's actually deployed at
  `launchpad`), `launchpad` itself is an owner-set trusted address (same
  trust model as `onlyAssToken`, not fan-supplied), and the loop bound is a
  real creator's real launch count — realistically single digits, not
  attacker-inflatable. `payWithCreatorToken` is `nonReentrant` on top of all
  that regardless.

## Local dev

```
npm run contracts:compile
npm run contracts:test
```

14/14 tests passing as of this writing, covering: ETH/token split math,
zero-value and zero-address reverts, pause behavior, owner-only admin
functions, fee cap enforcement, that no ERC-20 balance is left stuck in the
contract after a payment, and `payWithCreatorToken`'s launchpad-verification
gate (accepts a genuinely-launched token, rejects an unlaunched one, rejects
claiming a *different* creator's launched token, reverts cleanly when no
launchpad is configured yet).

Also ran `slither .` — 3 findings, all reviewed and accepted: the
`_isLaunchedByCreator` loop-of-external-calls and its unused-return (both
explained above — trusted, view-only, small, `nonReentrant`-guarded
regardless), and the pre-existing intentional low-level `.call` pattern for
ETH.

## Deploying

Set these in your environment before running a deploy script:

- `PLATFORM_WALLET_ADDRESS` — wallet that receives the 10% platform fee
- `ONLYASS_TOKEN_ADDRESS` — the deployed $ONLYASS ERC-20 contract address
  (this is the same address already shown on the site as
  `NEXT_PUBLIC_CONTRACT_ADDRESS`)
- `PLATFORM_FEE_BPS` — optional, defaults to `1000` (10%)
- `LAUNCHPAD_V4_ADDRESS` — optional, the deployed `OnlyAssLaunchpadV4`
  address. Leave unset to deploy with `payWithCreatorToken` disabled for
  now and wire it up later via `setLaunchpad(...)` once the launchpad
  exists.
- `SEPOLIA_RPC_URL` / `MAINNET_RPC_URL` and `DEPLOYER_PRIVATE_KEY` — for
  `hardhat.config.js` to pick up the network

```
npm run contracts:deploy:sepolia   # test on Sepolia first
npm run contracts:deploy:mainnet   # only after the audit
```

After deploying, set `NEXT_PUBLIC_PAYMENTS_CONTRACT_ADDRESS` in Vercel to the
printed address so the frontend can find it.

**Do not deploy to mainnet before the audit comes back.** Sepolia is free and
lets the whole flow (frontend → contract → backend verification) get tested
end-to-end with fake ETH first.
