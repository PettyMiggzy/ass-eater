# Persistent notes (business/product context, not code docs)

Read this at the start of a session for context that isn't obvious from the
code. Append to it -- don't let it go stale, but don't delete history that
might matter later either.

## Founder/creator token allocation

The platform owner will hold **40% of $ONLYASS's 1 billion total supply**,
unlocked over **30 days after deploy**, with a **daily cap on how much can be
collected/claimed** (exact vesting curve/cap not yet specified as of
2026-09-16). Relevant whenever touching:

- Public tokenomics disclosure/marketing copy for $ONLYASS -- a 40% founder
  allocation is the kind of thing that needs to be disclosed plainly, not
  discovered later, both for basic trust and because a large, presumably
  short-vested founder stake is exactly the pattern retail buyers get burned
  by when it isn't disclosed.
- Any future on-chain vesting/claim contract for this allocation -- nothing
  like that has been built yet. If asked to build it, the daily-cap +
  30-day-window mechanic needs the actual numbers first, not defaults guessed
  at.
- `treasury-hedge.ts` / price-impact modeling -- a wallet than can eventually
  move 40% of supply is a meaningful tail risk for pool depth/slippage
  assumptions once vesting completes.

## Branding

Keeping the **onlyass.fun domain**, but planning to change the **product/brand
name** (not the domain) -- explicit "Only Ass" branding is a real problem for
mainstream ad platforms (Google/Meta/TikTok Ads all prohibit adult content
ads regardless of brand name, so a rename mainly helps with stigma/press/App
Store listing/word-of-mouth, not with unlocking those ad platforms directly,
since they review actual site content). Current thinking: advertise
primarily on adult ad networks under whatever new name is picked, since
mainstream paid ads are blocked by the content itself, not just the name.
