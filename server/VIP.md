# VIP: burn $ONLYONE for a platform-wide discount

The one fan-facing discount on the platform. See `core/vip.ts` for the
implementation, `core/vip.test.ts` + `core/ledger.test.ts` for the tests.
Replaces an earlier "stake $ONLYONE for a month" idea that was never
built -- this is what got built instead.

## Mechanics

- A fan burns any amount of $ONLYONE (`POST /vip/burn`, body `{ tokens }`)
  out of their $ONLYONE-funded balance (`Account.onlyAssCents`), converted to
  USD-cents at the live price purely to know how much to debit. Burns
  accumulate (`Account.vipBurnedTokens`) -- there's no requirement to burn
  the whole threshold in one shot.
- Once cumulative burned tokens meet or exceed the platform-wide threshold
  (`PlatformConfig.vipBurnThresholdTokens`, 10,000,000 by default), the fan
  gets `FEES.VIP_DISCOUNT_BPS` (10%) off **everything** -- every `charge()`
  (subscriptions, tips, message unlocks, token-locks) and every marketplace
  purchase, checked live in both places.
- **VIP status is derived, not stored.** There's no `isVip` flag on the
  account -- every check compares `vipBurnedTokens` against the *current*
  threshold. If the platform lowers the threshold later (see below), anyone
  who already burned enough for the new bar is VIP immediately, no
  backfill/migration needed.
- **The threshold is admin-adjustable** (`GET`/`PATCH /admin/vip-config`),
  specifically so it can move as $ONLYONE's price does. The explicit ask
  this was built for: as price rises, lower how many tokens it takes to
  reach VIP, rather than letting the real-dollar cost of VIP status float
  upward forever on a fixed token count.

## Why a ledger burn, not (yet) an on-chain one

"Burn" here means the value is debited from the fan's balance and posted to
`BURNED_ID` (`core/ledger.ts`) -- a pseudo-account exactly like `PLATFORM_ID`
except nothing is ever paid out of it. From the ledger's perspective that
value is gone, same as if it had been sent to a dead address on-chain. It
does **not** itself execute a real on-chain burn transaction, so the actual
$ONLYONE circulating supply doesn't shrink to match -- yet.

That's a deliberate scope cut, not an oversight: making it a genuine
on-chain burn would mean either (a) trusting a fan to burn from their own
wallet and indexing it (a new watcher analogous to `deposit-indexer.ts`, but
watching transfers *out* to a burn address instead of *in*), or (b) having
the treasury periodically burn a real batch of tokens on-chain equal to
whatever's accumulated in `BURNED_ID`. Either is a reasonable next step if
the platform wants VIP burns to be publicly verifiable / actually
deflationary, not just an internal accounting entry -- not built now because
the discount mechanic itself (the part fans actually feel) doesn't depend on
which one is true, and it's a meaningfully bigger, separately-riskier piece
of work (real fund movement to a chain address) than the ledger bookkeeping.

## Why this replaced the loyalty/token-payment discounts instead of stacking

Two discounts used to exist and both got removed when this shipped: paying
out of an $ONLYONE balance no longer auto-discounts a charge
(`TOKEN_PAYMENT_DISCOUNT_BPS`, was in `ledger.ts`), and having an active
subscription or per-creator token-lock no longer discounts a marketplace
purchase (`LOYALTY_DISCOUNT_BPS`, was in `marketplace.ts`). The explicit
intent is one discount, earned one way, not several overlapping ones a fan
could hit almost by accident.

## Not built (yet)

- **No on-chain burn** -- see above.
- **No "perks" beyond the fee discount.** The framing this was requested
  under was a "VIP club" -- burning currently earns exactly the fee
  discount and nothing else (badges, early access, exclusive content, a
  visible VIP marker on a fan's profile, etc. would all be additive on top
  of the same `isVip(tx, userId)` check, not architecturally blocked, just
  not asked for yet).
- **No live-site (Blob-based) VIP.** Same reasoning as auctions/marketplace:
  this needs a real $ONLYONE-denominated balance to burn from, which only
  exists in `server/`'s ledger.
- **Creators pricing things in their own launched token** (not just
  USD/$ONLYONE) was raised as a likely future direction ("creators that
  launch tokens are probably going to charge their own token") but
  explicitly deferred -- `payAsset`/`payoutAsset` stay `USD | ONLYONE` only
  for now. Supporting a third, per-creator, per-launch token as a payment
  asset would need real per-token price oracles and balance pools, not a
  small addition.
