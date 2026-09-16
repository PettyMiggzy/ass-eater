import { getSessionUserId } from '../../../../lib/session';
import { getListings, findListing } from '../../../../lib/listings-store';
import { createOrder } from '../../../../lib/orders-store';

// This is the integration point for whenever real marketplace checkout/payment
// capture goes live -- it records the order + shipping address, it doesn't
// move money. Nothing on the live site calls this yet (the Buy button is
// still an honest "coming soon"); wire it in right after payment succeeds,
// not before, so a "to ship" queue never shows an order nobody actually paid for.
const REQUIRED_ADDRESS_FIELDS = ['fullName', 'line1', 'city', 'region', 'postalCode', 'country'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = getSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in to place an order' });

  const { listingId, shippingAddress, ageConfirmed, tosAccepted } = req.body || {};
  if (!listingId) return res.status(400).json({ error: 'Missing listing id' });
  if (ageConfirmed !== true || tosAccepted !== true) {
    return res.status(400).json({ error: 'Age confirmation and Marketplace Terms acceptance are both required' });
  }

  const listings = await getListings();
  const listing = findListing(listings, listingId);
  if (!listing || listing.status !== 'active') return res.status(404).json({ error: 'Listing not found or no longer active' });

  if (listing.kind === 'physical') {
    for (const field of REQUIRED_ADDRESS_FIELDS) {
      if (!shippingAddress || !String(shippingAddress[field] || '').trim()) {
        return res.status(400).json({ error: `Shipping address is missing ${field}` });
      }
    }
  }

  try {
    const order = await createOrder({
      listingId: listing.id,
      creatorId: listing.creatorId,
      buyerId: uid,
      priceCents: listing.priceCents,
      shippingCents: listing.shippingCents,
      kind: listing.kind,
      signatureRequired: listing.signatureRequired,
      shippingAddress: listing.kind === 'physical' ? shippingAddress : null,
      ageConfirmed, tosAccepted,
    });
    return res.status(200).json({ ok: true, order });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
