# OnlyAssPayments

Non-custodial paywall payment contract for the Only Ass platform.

## What it does

A fan calls `payWithETH` or `payWithOnlyAss` with a creator's payout wallet,
a `creatorId`, and a `contentId`. The contract splits the payment atomically
in the same transaction: `platformFeeBps` (currently intended to be set to
1000 = 10%) goes to `platformWallet`, the remainder goes straight to the
creator's wallet. The contract never holds a balance between transactions —
there is no escrow and no custody. A `Purchase` event is emitted so the
backend can verify the payment on-chain and unlock content.

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

## Local dev

```
npm run contracts:compile
npm run contracts:test
```

10/10 tests passing as of this writing, covering: ETH/token split math,
zero-value and zero-address reverts, pause behavior, owner-only admin
functions, fee cap enforcement, and that no ERC-20 balance is left stuck in
the contract after a payment.

Also ran `slither .` (static analysis) — the only non-boilerplate finding
(missing zero-address check on the token address setter/constructor) is
fixed. Everything else Slither flags is either OpenZeppelin's own
already-audited code, or the intentional low-level `.call` pattern explained
above.

## Deploying

Set these in your environment before running a deploy script:

- `PLATFORM_WALLET_ADDRESS` — wallet that receives the 10% platform fee
- `ONLYASS_TOKEN_ADDRESS` — the deployed $ONLYASS ERC-20 contract address
  (this is the same address already shown on the site as
  `NEXT_PUBLIC_CONTRACT_ADDRESS`)
- `PLATFORM_FEE_BPS` — optional, defaults to `1000` (10%)
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
