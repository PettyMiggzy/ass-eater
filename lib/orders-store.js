import { encryptShippingAddress, decryptShippingAddress } from './crypto';

/**
 * decryptShippingAddress throws on a malformed blob and on a GCM tag failure
 * (a rotated or wrong ORDERS_ENCRYPTION_KEY). Both read paths below map it
 * across every row, so one unreadable address would throw for the WHOLE
 * result -- a creator's entire shipping queue 500s because of one legacy or
 * corrupt row. A null address is a visible gap in one order; a 500 is no
 * orders at all.
 */
function safeDecrypt(value) {
  try {
    return decryptShippingAddress(value);
  } catch (err) {
    console.error('[orders] shipping address could not be decrypted:', err.message);
    return null;
  }
}
import { query, rowToRecord, withTransaction } from './db';
import { transferWithFee, RECIPIENT_UNAVAILABLE } from './credits-store';
import { claimUniqueListing } from './listings-store';
import { isDemoListing, listingHasDeliverable, effectiveCreatorStatus } from './creator-status';
import { effectiveUserStatus } from './user-moderation';
import { createNotification } from './notifications-store';
import { listingMediaBlocked } from './media-preservation';
import { tryLockMediaFiles, lockFilesOfListings, listingFileItems, MEDIA_LOCK_BUSY } from './media-locks';
import { FEES } from './fees';

// The Terms version each order records -- pages/terms.js Section 6 is what a
// buyer accepts per order. Defined in lib/tos.js (one constant, shared with
// the terms page's "last updated" date and signup); bump it there.
import { CURRENT_TOS_VERSION } from './tos';
import { sliceText } from './unicode-text';
export { CURRENT_TOS_VERSION };

// Orders are stored with the shipping address encrypted at rest (see
// lib/crypto.js). Every read path below decrypts only for the specific
// caller it's already been authorized for (the buyer's own order, or the
// creator who owns the listing) -- and each query filters in SQL rather than
// fetching every order and filtering in JavaScript, so one caller's rows are
// the only ones that ever leave the database.

/**
 * Creates an order record. Call this from wherever real marketplace checkout
 * ends up capturing payment -- this store only tracks the order/fulfillment
 * lifecycle, it doesn't move money itself.
 */
export async function createOrder({ listingId, creatorId, buyerId, priceCents, shippingCents, kind, signatureRequired, shippingAddress, ageConfirmed, tosAccepted }) {
  if (ageConfirmed !== true || tosAccepted !== true) throw new Error('Age confirmation and Marketplace Terms acceptance are both required to place an order');
  const entry = {
    listingId,
    creatorId,
    buyerId,
    priceCents,
    shippingCents: shippingCents || 0,
    signatureRequired: kind === 'physical' && !!signatureRequired, // advisory only -- see MARKETPLACE_FULFILLMENT.md
    kind, // 'digital' | 'physical'
    status: kind === 'physical' ? 'pending_shipment' : 'fulfilled',
    shippingAddress: kind === 'physical' ? encryptShippingAddress(shippingAddress) : null,
    carrier: null,
    trackingNumber: null,
    shippedAt: null,
    ageConfirmedAt: new Date().toISOString(), // recorded per order, separate from account-level DOB check -- see terms.js Section 6
    tosVersion: CURRENT_TOS_VERSION,
    createdAt: new Date().toISOString(),
  };
  const { rows } = await query('insert into orders (data) values ($1) returning id, data', [entry]);
  const order = rowToRecord(rows[0]);
  return { ...order, shippingAddress: undefined }; // never echo the encrypted blob back either
}

/**
 * Creates orders paid from the buyer's credits balance -- no wallet, no
 * on-chain step. `items` carry `creatorUserId` (the creator's OWN login
 * account, resolved by the caller via findUserByCreatorId, since credits
 * move between USER accounts, not creator profile ids).
 *
 * The whole cart is ONE transaction: every item's transfer runs inside it,
 * so a multi-item cart either fully charges or not at all -- a fan cannot
 * end up charged for item 3 of 5 because item 4 turned out to be a listing
 * whose creator has no login account (deleted since the cart page loaded).
 * transferWithFee is called with this transaction's client for exactly
 * that reason, not with its own default one.
 *
 * `idempotencyKey`, when given, is claimed in `checkout_idempotency` inside
 * this same transaction -- a retried or double-submitted checkout (a
 * dropped response, a double-click before the button disables) with the
 * SAME key fails the insert and rolls back the whole charge, rather than
 * being processed a second time. A genuinely new checkout always sends a
 * fresh key, so this never blocks a real repeat purchase. The claim is
 * per buyer (the table's primary key is (buyer_id, idempotency_key)), so a
 * key some OTHER account already used never comes back as this buyer's
 * DUPLICATE_CHECKOUT.
 *
 * Each non-unlimited ("one-of-a-kind") item is atomically claimed via
 * claimUniqueListing BEFORE it's charged -- if a listing has already sold
 * (to this same cart's own duplicate entry, or to someone else racing this
 * exact checkout), the claim fails and the whole transaction rolls back
 * before any money moves, rather than charging for something that's gone.
 *
 * Each item's priceCents / shippingCents / kind must be the values the
 * buyer was shown and confirmed (pages/api/marketplace/orders/create.js
 * checks them against the client's expected values); they are re-checked
 * here against the row-locked listing and a mismatch throws PRICE_CHANGED
 * rather than charging a price nobody agreed to.
 */
export async function createOrdersFromCredits({ buyerId, items, ageConfirmed, tosAccepted, idempotencyKey }) {
  if (ageConfirmed !== true || tosAccepted !== true) {
    throw new Error('Age confirmation and Marketplace Terms acceptance are both required to place an order');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Cart is empty');
  }

  // Lock order: listings are row-locked one by one inside the transaction,
  // so two carts holding the same listings in opposite order used to form a
  // lock cycle (A locks 5 and waits on 9, B locks 9 and waits on 5) and
  // Postgres killed one with a deadlock -- a spurious "something went wrong"
  // for a fan who did nothing wrong. Walking every cart in ascending listing
  // id order removes that cycle. Payer/payee balance rows can still cycle
  // across two different checkouts (X buys from Y while Y buys from X), so a
  // deadlock or serialization failure is retried: the whole transaction,
  // idempotency key included, rolled back, so a retry is a clean re-run.
  const ordered = [...items].sort((a, b) => compareListingIds(a.listingId, b.listingId));
  for (let attempt = 1; ; attempt++) {
    try {
      return await placeOrders({ buyerId, items: ordered, idempotencyKey });
    } catch (err) {
      if (attempt >= CHECKOUT_ATTEMPTS || !RETRYABLE_CODES.has(err && err.code)) throw err;
    }
  }
}

const CHECKOUT_ATTEMPTS = 3;
// deadlock_detected, serialization_failure, and a late media file that was
// busy (lockListingFiles) -- each rolled the whole attempt back.
const RETRYABLE_CODES = new Set(['40P01', '40001', MEDIA_LOCK_BUSY]);

function compareListingIds(a, b) {
  const x = String(a);
  const y = String(b);
  // Numeric ids compared as numbers ("9" < "10"); length first, then text,
  // so no id overflows a Number.
  return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
}

/**
 * Error code for a digital listing the buyer already holds a paid order for.
 * Buying it again would charge non-refundable credits for nothing: delivery
 * already serves the listing's full current media set to the first order.
 */
export const ALREADY_OWNED = 'ALREADY_OWNED';

/** Does this buyer already hold a paid digital order for this listing? */
export async function buyerOwnsDigitalListing(buyerId, listingId, client = null) {
  const runner = client || { query };
  const { rows } = await runner.query(
    `select 1 from orders
      where data->>'buyerId' = $1
        and data->>'listingId' = $2
        and data->>'kind' = 'digital'
        and coalesce(data->>'status', '') in ('fulfilled', 'delivered')
      limit 1`,
    [String(buyerId), String(listingId)],
  );
  return rows.length > 0;
}

// Takes the per-file advisory lock ('media-file:<pathname>') for each of the
// listing's media and retainedMedia files not already in `held` -- files that
// appeared on the row after the up-front sorted pass. They are TRY-locked:
// blocking on one out of sorted order could deadlock against a takedown or a
// quarantine that peeked after the finalize that added it (round-9 media#1),
// so a busy one aborts this attempt with MEDIA_LOCK_BUSY and the whole
// checkout transaction is retried (createOrdersFromCredits).
async function lockListingFiles(client, listing, held) {
  if (!(await tryLockMediaFiles(client, listingFileItems(listing), held))) {
    throw Object.assign(new Error('An item in your cart is being updated -- try again in a moment.'), { code: MEDIA_LOCK_BUSY });
  }
  return held;
}

function placeOrders({ buyerId, items, idempotencyKey }) {
  return withTransaction(async (client) => {
    if (idempotencyKey) {
      try {
        await client.query('insert into checkout_idempotency (idempotency_key, buyer_id) values ($1, $2)', [idempotencyKey, String(buyerId)]);
      } catch (err) {
        if (err.code === '23505') {
          throw Object.assign(new Error('This checkout was already processed -- check your order history before trying again.'), { code: 'DUPLICATE_CHECKOUT' });
        }
        throw err;
      }
    }

    // The ACCOUNT rows first, in the documented order (lib/media-locks.js
    // step 1; users before creators, the order transferWithFee's
    // accountStanding takes them in): the buyer's and every seller's login
    // rows, then their creator rows, FOR SHARE, each set in id order. Taking
    // them only later, inside transferWithFee -- after the file and listing
    // locks -- was the reverse of an attributed NCII resolve, a creator-media
    // preservation and a creator deletion, which lock the creator (and its
    // logins) first and its files second: the two deadlocked, and when
    // Postgres picked the admin side, a 48-hour takedown answered 500
    // (round-9 money#0). accountStanding's own FOR SHARE later re-locks rows
    // this transaction already holds, so it can no longer wait on anything.
    const userIds = [...new Set([String(buyerId), ...items.map((it) => String(it.creatorUserId ?? ''))].filter(Boolean))].sort();
    const { rows: accountRows } = await client.query(
      'select id, data->>\'creatorId\' as creator_id from users where id = any($1::text[]) order by id for share',
      [userIds],
    );
    const creatorIds = [...new Set([
      ...items.map((it) => String(it.creatorId ?? '')),
      ...accountRows.map((r) => String(r.creator_id ?? '')),
    ].filter(Boolean))];
    if (creatorIds.length) {
      await client.query('select id from creators where id = any($1::text[]) order by id for share', [creatorIds]);
    }

    // The per-file advisory locks for EVERY listing in the cart, taken up
    // front in one globally sorted pass, before any listing row lock (see the
    // loop below for why). Sorting per listing inside the loop would take the
    // files in cart (listing-id) order instead, and a preservation covering
    // files of two listings in one cart -- which takes its files in global
    // pathname order -- could deadlock against it.
    const lockedFiles = await lockFilesOfListings(client, { ids: items.map((it) => String(it.listingId)) });

    const created = [];
    for (const item of items) {
      // Re-read the listing INSIDE the charge's transaction, row-locked, so
      // what is charged is exactly what the caller verified against the
      // price the fan saw: a creator editing the price, or the listing being
      // removed, between the route's check and this point either waits for
      // this transaction or is caught here -- never silently charged at a
      // different price.
      //
      // The listing's per-file advisory locks were taken FIRST, above, before
      // any row lock -- the same locks, in the same order (files, then listing
      // rows), that
      // preserveMedia takes when it quarantines a file and takes its listings
      // off sale. Without them a checkout that locked the row first read "no
      // preservation" while a quarantine was mid-commit, sold the listing,
      // and the buyer was charged for files that are never served. Now a
      // quarantine either commits first (and is seen below, and the listing
      // is already off sale) or waits for this checkout to finish. Files
      // added between the unlocked read and the row lock are locked too.
      const { rows: lr } = await client.query('select id, data from listings where id = $1 for update', [item.listingId]);
      const current = lr.length ? lr[0].data : null;
      if (current) await lockListingFiles(client, current, lockedFiles);
      // Also refused here, on the locked row: a listing marked demo, and a
      // digital listing with no files (its last file removed between the
      // route's check and this point). The seller's own demo flag is checked
      // by transferWithFee (canReceiveStanding).
      if (
        !current ||
        current.status !== 'active' ||
        String(current.creatorId) !== String(item.creatorId) ||
        isDemoListing(current) ||
        !listingHasDeliverable(current)
      ) {
        throw Object.assign(
          new Error(
            current?.status === 'sold'
              ? `"${item.title || 'An item'}" in your cart just sold to someone else.`
              : `"${item.title || 'An item'}" in your cart is no longer available.`,
          ),
          { code: 'LISTING_UNAVAILABLE', listingId: item.listingId },
        );
      }
      // A listing with a file quarantined as evidence: never sold.
      // preserveMedia takes such a listing off sale in the quarantine's own
      // commit; this is the backstop on the locked row (a preserved file is
      // never served, so the buyer would get nothing). A report HOLD does not
      // stop a sale -- see listingMediaBlocked.
      if (await listingMediaBlocked(current, client)) {
        throw Object.assign(new Error(`"${item.title || 'An item'}" in your cart is no longer available.`), {
          code: 'LISTING_UNAVAILABLE',
          listingId: item.listingId,
        });
      }
      const currentKind = current.kind === 'physical' ? 'physical' : 'digital';
      const currentShipping = currentKind === 'physical' ? Number(current.shippingCents) || 0 : 0;
      const itemShipping = item.kind === 'physical' ? Number(item.shippingCents) || 0 : 0;
      if (Number(current.priceCents) !== item.priceCents || currentKind !== item.kind || currentShipping !== itemShipping) {
        throw Object.assign(new Error(`The price of "${item.title || 'an item'}" changed. Review your cart and confirm again.`), {
          code: 'PRICE_CHANGED',
          listingId: item.listingId,
        });
      }
      // A digital item this buyer already paid for: refused on the locked
      // row, before any money moves. (A physical unlimited item bought twice
      // is two shipments, and is allowed.) Earlier items of this same cart
      // are visible here, so a duplicate entry is caught too.
      if (currentKind === 'digital' && (await buyerOwnsDigitalListing(buyerId, item.listingId, client))) {
        throw Object.assign(new Error(`You already own "${item.title || 'this item'}" -- it's in your order history.`), {
          code: ALREADY_OWNED,
          listingId: item.listingId,
        });
      }
      if (!current.unlimited) {
        const claimed = await claimUniqueListing(item.listingId, client);
        if (!claimed) {
          throw Object.assign(
            new Error(`"${item.title || 'An item'}" in your cart just sold to someone else.`),
            { code: 'LISTING_UNAVAILABLE', listingId: item.listingId },
          );
        }
      }
      const totalCents = item.priceCents + itemShipping;
      // transferWithFee also refuses a seller who isn't an active, real
      // creator (RECIPIENT_UNAVAILABLE) or a frozen buyer (ACCOUNT_FROZEN),
      // and applies the founding-creator fee waiver -- see credits-store.js.
      // A refused seller is tagged with this item's listing id, so checkout
      // can tell the fan WHICH item to drop.
      let transfer;
      try {
        transfer = await transferWithFee(
          {
            fromUserId: buyerId,
            toUserId: item.creatorUserId,
            cents: totalCents,
            feeBps: FEES.MARKETPLACE_BPS,
            type: 'marketplace',
            meta: { listingId: item.listingId },
          },
          client,
        );
      } catch (err) {
        if (err?.code === RECIPIENT_UNAVAILABLE && err.listingId == null) err.listingId = item.listingId;
        throw err;
      }
      const { netCents, feeBps: appliedFeeBps } = transfer;
      // Inside the same transaction as the charge -- if the charge rolls
      // back (a later item in the cart fails), there is no notification for
      // a sale that never happened either.
      await createNotification(
        {
          userId: item.creatorUserId,
          type: 'sale',
          message: `You made a sale: "${item.title || 'Listing'}" — +$${(netCents / 100).toFixed(2)} credits`,
          meta: { listingId: item.listingId, netCents },
        },
        client,
      );

      const entry = {
        listingId: item.listingId,
        creatorId: item.creatorId,
        buyerId,
        // Snapshotted at purchase time, not looked up live: a listing can be
        // edited, sold out (see claimUniqueListing above) or removed later,
        // and an order in someone's history should still say what they
        // actually bought regardless of what happens to the listing after.
        title: item.title || null,
        priceCents: item.priceCents,
        shippingCents: itemShipping,
        // What the creator actually received and the rate applied (0 during
        // a founding waiver) -- the order is the receipt for both sides.
        feeBps: appliedFeeBps,
        creatorNetCents: netCents,
        signatureRequired: item.kind === 'physical' && !!item.signatureRequired,
        kind: item.kind,
        status: item.kind === 'physical' ? 'pending_shipment' : 'fulfilled',
        shippingAddress: item.kind === 'physical' ? encryptShippingAddress(item.shippingAddress) : null,
        carrier: null,
        trackingNumber: null,
        shippedAt: null,
        paymentMethod: 'credits',
        ageConfirmedAt: new Date().toISOString(),
        tosVersion: CURRENT_TOS_VERSION,
        createdAt: new Date().toISOString(),
      };
      const { rows } = await client.query('insert into orders (data) values ($1) returning id, data', [entry]);
      created.push({ ...rowToRecord(rows[0]), shippingAddress: undefined });
    }
    return created;
  });
}

// What a BUYER may see of their own order: an ALLOWLIST, like
// toPublicCreator. Spreading the stored record used to hand the buyer the
// admin's internal close note (closeReason / closedBy -- e.g. "seller banned
// after a possible-minor report") and the seller's own receipt (feeBps,
// creatorNetCents, which reveal a founding fee waiver). A new internal field
// written onto an order is now private to the buyer by default.
const BUYER_ORDER_FIELDS = [
  'id', 'listingId', 'title', 'priceCents', 'shippingCents', 'kind', 'status', 'signatureRequired',
  'carrier', 'trackingNumber', 'shippedAt', 'createdAt', 'closedAt', 'addressErasedAt', 'tosVersion',
];

// Every buyer-facing order payload goes through this: the order history
// below AND the checkout response (pages/api/marketplace/orders/create.js
// maps createOrdersFromCredits' records through it with
// { withAddress: false } -- the buyer typed the address a second ago).
export function toBuyerOrder(o, { withAddress = true } = {}) {
  const out = {};
  for (const key of BUYER_ORDER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(o, key) && o[key] !== undefined) out[key] = o[key];
  }
  // Their own shipping address, decrypted so they can see where it's going.
  if (withAddress) out.shippingAddress = safeDecrypt(o.shippingAddress);
  return out;
}

/** A buyer's own order history (see toBuyerOrder for exactly what it carries). */
export async function getOrdersForBuyer(buyerId) {
  const { rows } = await query(
    `select id, data from orders where data->>'buyerId' = $1 order by id`,
    [String(buyerId)],
  );
  return rows.map(rowToRecord).map((o) => toBuyerOrder(o));
}

/**
 * The creator-facing shape of an order. The buyer's address is shared ONLY
 * so the creator can ship: it is decrypted for an order still awaiting
 * shipment and null for every other (shipped, or anything else) -- this used
 * to hand the name, street address and phone of every past buyer to the
 * creator's browser on every dashboard load, forever. The buyer's account id
 * is never part of it, and neither is the admin's internal close note.
 */
function toCreatorOrder(o) {
  // The admin's close note (closeReason / closedBy) is internal: it may name a
  // moderation finding about this very seller. The creator sees the status and
  // closedAt only.
  const { buyerId: _buyer, shippingAddress, closeReason: _reason, closedBy: _by, closeForced: _forced, ...rest } = o;
  return { ...rest, shippingAddress: o.status === 'pending_shipment' ? safeDecrypt(shippingAddress) : null };
}

/** A creator's physical orders, scoped to their own listings only (see toCreatorOrder). */
export async function getOrdersForCreator(creatorId) {
  const { rows } = await query(
    `select id, data from orders
      where data->>'creatorId' = $1 and data->>'kind' = 'physical'
      order by id`,
    [String(creatorId)],
  );
  return rows.map(rowToRecord).map(toCreatorOrder);
}

/**
 * Creator marks a physical order shipped.
 *
 * Ownership is part of the UPDATE's WHERE clause, not a check done against a
 * row read earlier, so there is no window in which the order could change
 * between the check and the write. A missing row and a row belonging to
 * someone else are deliberately the same error: "not found" tells a prodding
 * caller nothing about whether that order id exists.
 */
/**
 * True when this buyer has already committed a checkout under `key`. The
 * checkout route asks this BEFORE its balance, price and availability
 * prechecks: a retry of a checkout that committed but lost its response would
 * otherwise get "not enough credits" or "price changed" (the first attempt
 * already spent the credits / sold the item) instead of being told it went
 * through. The claim inside createOrdersFromCredits stays the real guard.
 */
export async function isCheckoutKeyClaimed(key, buyerId) {
  if (typeof key !== 'string' || !key) return false;
  const { rows } = await query(
    'select 1 from checkout_idempotency where idempotency_key = $1 and buyer_id = $2',
    [key.slice(0, 200), String(buyerId)],
  );
  return rows.length > 0;
}

export async function markOrderShipped(orderId, creatorId, { carrier, trackingNumber }) {
  // A paid physical order whose address can't be decrypted must not be
  // recorded as shipped -- nobody knows where it went. The address is written
  // once at checkout and never changes, so checking it before the update is
  // not a race.
  const { rows: pre } = await query(
    `select data->>'kind' as kind, data->>'status' as status, data->'shippingAddress' as addr from orders where id = $1 and data->>'creatorId' = $2`,
    [orderId, String(creatorId)],
  );
  if (pre.length && pre[0].status === ORDER_CLOSED_STATUS) throw orderClosedError();
  if (pre.length && pre[0].kind === 'physical') {
    const addr = pre[0].addr == null ? null : safeDecrypt(pre[0].addr);
    if (!addr || typeof addr !== 'object' || !addr.line1) {
      const err = new Error("This order's shipping address can't be read -- contact team@onlyone1.fun before shipping.");
      err.code = 'ADDRESS_UNREADABLE';
      throw err;
    }
  }
  const { rows } = await query(
    `update orders
        set data = data || jsonb_build_object(
              'status', 'shipped',
              'carrier', $3::text,
              'trackingNumber', $4::text,
              'shippedAt', $5::text
            )
      where id = $1
        and data->>'creatorId' = $2
        and data->>'kind' = 'physical'
        and coalesce(data->>'status', '') in ('pending_shipment', 'shipped')
      returning id, data`,
    [orderId, String(creatorId), carrier ?? null, trackingNumber ?? null, new Date().toISOString()],
  );
  if (!rows.length) {
    // Distinguish the two cases the old code did, but only for an order this
    // creator actually owns -- otherwise stay silent about its existence.
    const { rows: own } = await query(
      `select data->>'kind' as kind, data->>'status' as status from orders where id = $1 and data->>'creatorId' = $2`,
      [orderId, String(creatorId)],
    );
    if (own.length && own[0].status === ORDER_CLOSED_STATUS) throw orderClosedError();
    if (own.length && own[0].kind !== 'physical') throw new Error('Only physical orders can be marked shipped');
    throw new Error('Order not found');
  }
  // Now shipped, so toCreatorOrder leaves the address (and buyer id) out.
  return { ...toCreatorOrder(rowToRecord(rows[0])), shippingAddress: undefined };
}

export const ORDER_NOT_FOUND = 'ORDER_NOT_FOUND';
export const ORDER_NOT_SHIPPED = 'ORDER_NOT_SHIPPED';
export const ORDER_NOT_CLOSABLE = 'ORDER_NOT_CLOSABLE';
export const ORDER_CLOSED = 'ORDER_CLOSED';
export const ORDER_SELLER_ACTIVE = 'ORDER_SELLER_ACTIVE';
// Terminal status of a paid physical order that will never ship (the seller
// was banned or deleted before shipping it). Everything that means "still
// owes a shipment" keys on status = 'pending_shipment' -- the address-erase
// paths, fan self-deletion, creator-deletion obligations -- so a closed order
// counts as settled for all of them with no further change.
export const ORDER_CLOSED_STATUS = 'closed_unfulfilled';
export const MAX_CLOSE_REASON = 500;

function orderClosedError() {
  return Object.assign(new Error('This order was closed and can no longer be shipped.'), { code: ORDER_CLOSED });
}

/**
 * Admin: close a paid PHYSICAL order that can never be fulfilled -- its seller
 * was banned (the ship routes refuse a banned creator) or deleted (no login
 * left). Before this nothing could move such an order out of
 * 'pending_shipment': the buyer's encrypted name and street address could
 * never be erased, and the buyer could never delete their own account
 * (round-8 money#0; Privacy section 7 promises unshipped orders are settled
 * first).
 *
 * That precondition is ENFORCED here, not just described (round-9 money#1):
 * closing is terminal and moves no money, so a mistyped order number used to
 * cancel a live order an active seller was about to ship -- the buyer out the
 * money, the seller unable to ship. The seller counts as unable to fulfil
 * when the creator record is gone, no login is left for it, or its effective
 * standing (creator status, or the login's own account moderation) is
 * banned. Anything else is refused with ORDER_SELLER_ACTIVE unless the admin
 * passes `force: true` (a long suspension, an unreachable seller), which is
 * recorded on the order as `closeForced`. The seller's login and creator rows
 * are share-locked first (users, then creators -- the order deleteCreator and
 * accountStanding use), then the order, so an un-ban cannot land between the
 * check and the close.
 *
 * Only a 'pending_shipment' physical order is closable, and that is a
 * condition on the UPDATE itself, so a seller shipping it at the same moment
 * cannot be overwritten (whichever lands first wins; the loser gets a clear
 * error). Stamps `closedAt`, `closeReason` and `closedBy: 'admin'` -- an
 * internal note: getOrdersForBuyer and toCreatorOrder never return the reason.
 * With `eraseAddress: true` the shipping address is erased in the SAME
 * transaction (eraseOrderShippingAddress, which the new status now allows).
 *
 * Deliberately moves NO money: fans get no refunds by default, and whether to
 * re-credit a buyer out of a banned seller's frozen balance is the owner's
 * explicit, separate decision (/api/admin/manual-credit is not it either).
 *
 * Throws ORDER_NOT_FOUND (no such order), ORDER_NOT_CLOSABLE (digital, or not
 * pending shipment -- `.status` says which) or ORDER_SELLER_ACTIVE (`.seller`
 * carries the seller summary). Returns { orderId, status, closedAt, erased,
 * forced }.
 */
export async function closeUnfulfilledOrder(orderId, { reason, eraseAddress = false, force = false } = {}) {
  if (!/^[1-9]\d{0,17}$/.test(String(orderId ?? ''))) {
    throw Object.assign(new Error('Order not found'), { code: ORDER_NOT_FOUND });
  }
  const why = sliceText(String(reason ?? '').trim(), MAX_CLOSE_REASON);
  const closedAt = new Date().toISOString();
  const result = await withTransaction(async (client) => {
    const { rows: pre } = await client.query(
      `select data->>'creatorId' as creator_id, data->>'kind' as kind, data->>'status' as status from orders where id = $1`,
      [String(orderId)],
    );
    if (!pre.length) throw Object.assign(new Error('Order not found'), { code: ORDER_NOT_FOUND });
    const creatorId = pre[0].creator_id;
    const seller = await sellerStanding(client, creatorId, { lock: true });
    const forced = !seller.unableToFulfil;
    if (forced && force !== true) {
      throw Object.assign(
        new Error(
          `The seller of order #${orderId} is still ${seller.status} and can ship it. Only an order whose seller was banned or deleted is closed this way -- check the order number, or close it anyway with force.`,
        ),
        { code: ORDER_SELLER_ACTIVE, seller },
      );
    }
    const { rows } = await client.query(
      `update orders
          set data = data || jsonb_build_object(
                'status', $2::text, 'closedAt', $3::text, 'closeReason', $4::text, 'closedBy', 'admin',
                'closeForced', $6::boolean)
        where id = $1
          and data->>'kind' = 'physical'
          and coalesce(data->>'status', '') = 'pending_shipment'
          and data->>'creatorId' is not distinct from $5::text
        returning id, data->>'buyerId' as buyer_id`,
      [String(orderId), ORDER_CLOSED_STATUS, closedAt, why, creatorId, forced],
    );
    if (!rows.length) {
      const { rows: cur } = await client.query(
        `select data->>'kind' as kind, data->>'status' as status from orders where id = $1`,
        [String(orderId)],
      );
      if (!cur.length) throw Object.assign(new Error('Order not found'), { code: ORDER_NOT_FOUND });
      const msg = cur[0].kind !== 'physical'
        ? 'Only a physical order can be closed.'
        : `Only an order still waiting to ship can be closed (this one is ${cur[0].status || 'unknown'}).`;
      throw Object.assign(new Error(msg), { code: ORDER_NOT_CLOSABLE, status: cur[0].status || null });
    }
    const erased = eraseAddress ? (await eraseOrderShippingAddress(String(orderId), client)).erased : false;
    return { orderId: String(rows[0].id), buyerId: rows[0].buyer_id, status: ORDER_CLOSED_STATUS, closedAt, erased, forced };
  });
  // Tell the buyer, best-effort and after the commit: the close stands even
  // if the notification cannot be written.
  if (result.buyerId) {
    try {
      await createNotification({
        userId: String(result.buyerId),
        type: 'order_closed',
        message: `Your order #${result.orderId} could not be fulfilled by the seller and has been closed. Contact team@onlyone1.fun with any questions.`,
        meta: { orderId: result.orderId },
      });
    } catch (err) {
      console.error('[orders] close notification failed:', err?.message);
    }
  }
  const { buyerId: _b, ...out } = result;
  return out;
}

/**
 * Whether the seller behind `creatorId` can still fulfil an order, for the
 * admin close path and the admin order summaries:
 *   { creatorId, name, handle, status, hasLogin, unableToFulfil }
 * `status` is 'deleted' (no creator record), 'no_login', or the effective
 * standing with the login's own account moderation applied (the stricter
 * wins). With `lock`, the login rows and then the creator row are share-locked
 * on the caller's transaction (users, then creators).
 */
async function sellerStanding(runner, creatorId, { lock = false } = {}) {
  const suffix = lock ? ' for share' : '';
  const id = creatorId == null ? null : String(creatorId);
  const { rows: logins } = id
    ? await runner.query(`select id, data from users where data->>'creatorId' = $1 order by id${suffix}`, [id])
    : { rows: [] };
  const { rows: cr } = id
    ? await runner.query(`select id, data from creators where id = $1${suffix}`, [id])
    : { rows: [] };
  const creator = cr.length ? cr[0].data : null;
  const base = { creatorId: id, name: creator?.name ?? null, handle: creator?.handle ?? null };
  if (!creator) return { ...base, status: 'deleted', hasLogin: logins.length > 0, unableToFulfil: true };
  if (!logins.length) return { ...base, status: 'no_login', hasLogin: false, unableToFulfil: true };
  const creatorStatus = effectiveCreatorStatus(creator) || 'unknown';
  const accountBanned = logins.some((u) => effectiveUserStatus(u.data) === 'banned');
  const status = accountBanned ? 'banned' : creatorStatus;
  return { ...base, status, hasLogin: true, unableToFulfil: status === 'banned' };
}

/**
 * Admin order summaries (GET /api/admin/orders). Non-sensitive fields only:
 * NEVER the shipping address (decrypted or not). Filters: `orderId` (one
 * order), `creatorId` (a seller's orders), `buyerId`, `status`. Each row
 * carries the seller's standing (sellerStanding, unlocked) so the close panel
 * can show who it is about to affect before it asks for confirmation.
 */
export async function getOrderSummariesForAdmin({ orderId = null, creatorId = null, buyerId = null, status = null, limit = 200 } = {}) {
  const where = [];
  const params = [];
  const add = (sql, value) => {
    params.push(String(value));
    where.push(sql.replace('$?', `$${params.length}`));
  };
  if (orderId != null) add('id = $?', orderId);
  if (creatorId != null) add(`data->>'creatorId' = $?`, creatorId);
  if (buyerId != null) add(`data->>'buyerId' = $?`, buyerId);
  if (status != null) add(`coalesce(data->>'status', '') = $?`, status);
  params.push(Math.max(1, Math.min(500, Number(limit) || 200)));
  const { rows } = await query(
    `select id, data from orders ${where.length ? `where ${where.join(' and ')}` : ''} order by id desc limit $${params.length}`,
    params,
  );
  const sellers = new Map();
  const out = [];
  for (const row of rows) {
    const o = rowToRecord(row);
    const key = o.creatorId == null ? '' : String(o.creatorId);
    if (!sellers.has(key)) sellers.set(key, await sellerStanding({ query }, o.creatorId));
    out.push({
      id: String(o.id),
      listingId: o.listingId ?? null,
      title: o.title ?? null,
      kind: o.kind ?? null,
      status: o.status ?? null,
      priceCents: o.priceCents ?? null,
      shippingCents: o.shippingCents ?? 0,
      buyerId: o.buyerId ?? null,
      creatorId: o.creatorId ?? null,
      createdAt: o.createdAt ?? null,
      shippedAt: o.shippedAt ?? null,
      closedAt: o.closedAt ?? null,
      closeReason: o.closeReason ?? null,
      closeForced: o.closeForced === true,
      addressErasedAt: o.addressErasedAt ?? null,
      hasAddress: o.shippingAddress != null,
      seller: sellers.get(key),
    });
  }
  return out;
}

/**
 * Privacy section 7: a physical order's shipping name and address stay with
 * the order only until it ships; after that the person can ask for them to be
 * deleted. Nothing could do that -- no route touched an order's address, and
 * deleting the fan account left every address in place -- so the promise
 * could only be kept with hand-written SQL against production.
 *
 * Sets `shippingAddress` to null and stamps `addressErasedAt` on ONE order,
 * refusing (ORDER_NOT_SHIPPED) while it is still pending_shipment -- the
 * creator needs the address to ship it. The status is checked in the UPDATE's
 * own WHERE clause, so a concurrent change can't slip between a check and the
 * write. Idempotent: an order already erased (or a digital order, which never
 * had an address) answers with `erased: false`. Throws ORDER_NOT_FOUND for no
 * such order. Returns { orderId, erased, addressErasedAt }.
 */
export async function eraseOrderShippingAddress(orderId, client = null) {
  const runner = client || { query };
  if (!/^[1-9]\d{0,17}$/.test(String(orderId ?? ''))) {
    throw Object.assign(new Error('Order not found'), { code: ORDER_NOT_FOUND });
  }
  const { rows } = await runner.query(
    `update orders
        set data = jsonb_set(data, '{shippingAddress}', 'null'::jsonb)
                   || jsonb_build_object('addressErasedAt', $2::text)
      where id = $1
        and coalesce(data->>'status', '') <> 'pending_shipment'
        and data->'shippingAddress' is not null
        and data->'shippingAddress' <> 'null'::jsonb
      returning id, data->>'addressErasedAt' as at`,
    [String(orderId), new Date().toISOString()],
  );
  if (rows.length) return { orderId: String(rows[0].id), erased: true, addressErasedAt: rows[0].at };
  const { rows: cur } = await runner.query(
    `select id, data->>'status' as status, data->>'addressErasedAt' as at from orders where id = $1`,
    [String(orderId)],
  );
  if (!cur.length) throw Object.assign(new Error('Order not found'), { code: ORDER_NOT_FOUND });
  if (cur[0].status === 'pending_shipment') {
    throw Object.assign(new Error("This order hasn't shipped yet -- its address is still needed to ship it."), { code: ORDER_NOT_SHIPPED });
  }
  return { orderId: String(cur[0].id), erased: false, addressErasedAt: cur[0].at || null };
}

/**
 * Erases the shipping address of every already-SHIPPED (not pending) order a
 * buyer placed, stamping addressErasedAt, on the caller's transaction. Used by
 * fan account deletion (lib/users-store.js deleteFanAccount), which refuses
 * self-service while any order is unshipped. Returns how many were erased.
 */
export async function eraseShippedAddressesForBuyer(buyerId, client = null) {
  const runner = client || { query };
  const { rowCount } = await runner.query(
    `update orders
        set data = jsonb_set(data, '{shippingAddress}', 'null'::jsonb)
                   || jsonb_build_object('addressErasedAt', $2::text)
      where data->>'buyerId' = $1
        and coalesce(data->>'status', '') <> 'pending_shipment'
        and data->'shippingAddress' is not null
        and data->'shippingAddress' <> 'null'::jsonb`,
    [String(buyerId), new Date().toISOString()],
  );
  return rowCount || 0;
}
