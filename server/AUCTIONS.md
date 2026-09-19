# Marketplace auctions

eBay-style bidding on top of the existing fixed-price marketplace. See
`core/auctions.ts` for the implementation, `core/auctions.test.ts` for the
test suite (19 tests).

## Why bids settle in USD (`balanceCents`), never $ONLYONE

An auction can run for hours or days. A bid has to hold its value for that
whole window, and it needs to be directly comparable to every other bid —
neither of those works if bids are denominated in a token whose price can
move, or if paying in one asset carries the platform's usual 10% discount
(a $100 bid paid in $ONLYONE would really be a $90 bid — "highest bid wins"
stops meaning anything once that's in play). Restricting auctions to the
USDC-backed `balanceCents` pool sidesteps both problems: it's stable for the
auction's whole duration and every bid is worth exactly its face value.

## Why a bid locks funds immediately

The classic auction failure mode is the winning bidder not actually being
able to pay once it's over. Instead of discovering that at close time,
`placeBid` holds the bidder's funds the instant they bid (`AUCTION_BID_HOLD`)
and releases them the instant they're outbid (`AUCTION_BID_RELEASE`). By the
time an auction closes, the leading bid is already real money sitting out of
that bidder's spendable balance — `closeAuction` just routes it to the
creator, it never has to attempt a fresh charge that could fail.

## Mechanics

- **Starting bid**: `Listing.priceCents` doubles as the starting bid for an
  `AUCTION` listing (no separate field).
- **Minimum increment**: creator-overridable (`minBidIncrementCents`);
  otherwise the greater of $1 or 5% of the current bid.
- **Reserve**: optional hidden minimum (`reserveCents`). If the winning bid
  doesn't clear it, the auction closes with no sale and a full release —
  same as any other unmet-reserve auction.
- **Anti-snipe**: a bid inside the last 5 minutes pushes the deadline out by
  5 more minutes, same idea as eBay/live-auction extensions, so the last
  second isn't a race to click first.
- **Closing**: `workers/auction-close.ts` sweeps every 60 seconds (auctions
  are time-sensitive enough to warrant checking far more often than the
  other periodic workers) and calls `closeAuction` on anything past its
  `auctionEndsAt`.
- **Fees**: identical split to a fixed-price sale (10% platform + 5% listing,
  off the winning bid; shipping, if physical, is added on top uncommissioned)
  — an auction sale is still a marketplace sale, just priced by bidding. Both
  paths now read `PLATFORM_FEE_BPS`/`LISTING_FEE_BPS` from
  `core/marketplace-fees.ts` so they can't drift apart.
- **Physical auction items**: same shipping/signature-required handling as a
  fixed-price physical listing (see `MARKETPLACE_FULFILLMENT.md`) — the
  winning bidder's order starts at `AWAITING_SHIPMENT`, no escrow, same as
  everything else in the marketplace.

## Not built (yet)

- **No "Buy It Now" price alongside an auction.** Pure bidding only for v1.
- **No live-site (Blob-based) auctions.** Bidding needs a real fund-locking
  balance to be honest, which only exists in `server/`'s ledger — the live
  site has no real payment yet, so there's nothing truthful to build there
  until the backend deploys, same reasoning as everything else payment-shaped
  in `MARKETPLACE_FULFILLMENT.md`.
- **No outbid notifications.** A bidder currently has to check back to see
  if they've been outbid.
