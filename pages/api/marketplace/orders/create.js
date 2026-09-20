import { getVerifiedSessionUserId } from '../../../../lib/session';
import { getListings, findListing } from '../../../../lib/listings-store';
import { findUserByCreatorId } from '../../../../lib/users-store';
import { createOrdersFromCredits } from '../../../../lib/orders-store';
import { getBalanceCents, INSUFFICIENT_BALANCE } from '../../../../lib/credits-store';

const REQUIRED_ADDRESS_FIELDS = ['fullName', 'line1', 'city', 'region', 'postalCode', 'country'];

/**
 * Marketplace checkout, paid from the buyer's credits balance -- no wallet
 * connection here at all. The only place a wallet is ever needed is
 * pages/api/credits/buy.js, converting real USDG into that balance once.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in to place an order' });

  const { items: cartItems, shippingAddress, ageConfirmed, tosAccepted } = req.body || {};
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    return res.status(400).json({ error: 'Cart is empty' });
  }
  if (ageConfirmed !== true || tosAccepted !== true) {
    return res.status(400).json({ error: 'Age confirmation and Marketplace Terms acceptance are both required' });
  }

  // Re-price and re-validate every item against the CURRENT stored listing --
  // never trust a price the client sends.
  const listings = await getListings();
  const resolved = [];
  let needsShipping = false;
  let totalCents = 0;
  for (const { listingId } of cartItems) {
    const listing = findListing(listings, listingId);
    if (!listing || listing.status !== 'active') {
      return res.status(404).json({ error: `A listing in your cart is no longer available (#${listingId})` });
    }
    // A creator's login account is separate from their public creator
    // profile -- credits move between USER accounts, so a listing whose
    // creator has no (or no longer has a) login account can't be paid into.
    const creatorUser = await findUserByCreatorId(listing.creatorId);
    if (!creatorUser) {
      return res.status(404).json({ error: `"${listing.title}" isn't available for purchase right now` });
    }
    if (listing.kind === 'physical') needsShipping = true;
    totalCents += listing.priceCents + (listing.kind === 'physical' ? listing.shippingCents || 0 : 0);
    resolved.push({ listing, creatorUserId: creatorUser.id });
  }

  if (needsShipping) {
    for (const field of REQUIRED_ADDRESS_FIELDS) {
      if (!shippingAddress || !String(shippingAddress[field] || '').trim()) {
        return res.status(400).json({ error: `Shipping address is missing ${field}` });
      }
    }
  }

  const balanceCents = await getBalanceCents(uid);
  if (balanceCents < totalCents) {
    return res.status(402).json({ error: 'Not enough credits', shortfallCents: totalCents - balanceCents });
  }

  try {
    const orders = await createOrdersFromCredits({
      buyerId: uid,
      items: resolved.map(({ listing, creatorUserId }) => ({
        listingId: listing.id,
        creatorId: listing.creatorId,
        creatorUserId,
        priceCents: listing.priceCents,
        shippingCents: listing.kind === 'physical' ? listing.shippingCents : 0,
        kind: listing.kind,
        signatureRequired: listing.signatureRequired,
        shippingAddress,
      })),
      ageConfirmed,
      tosAccepted,
    });
    const newBalance = await getBalanceCents(uid);
    return res.status(200).json({ ok: true, orders, balanceCents: newBalance });
  } catch (err) {
    if (err.code === INSUFFICIENT_BALANCE) return res.status(402).json({ error: 'Not enough credits' });
    return res.status(500).json({ error: err.message });
  }
}
