import { getVerifiedSessionUserId } from '../../../../lib/session';
import { getListings, findListing } from '../../../../lib/listings-store';
import { createOrdersFromPayment } from '../../../../lib/orders-store';
import { verifyUsdcPayment } from '../../../../lib/chain-verify';
import { getMarketplaceVerificationConfig, marketplaceVerificationLive } from '../../../../lib/marketplace-payment-config';

const REQUIRED_ADDRESS_FIELDS = ['fullName', 'line1', 'city', 'region', 'postalCode', 'country'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const config = getMarketplaceVerificationConfig();
  if (!marketplaceVerificationLive(config)) {
    // Same honest-not-live pattern as AgeChecker/SES before their
    // credentials existed: the endpoint is real, it just refuses to accept
    // a payment it has no way to actually verify yet.
    return res.status(501).json({ error: 'Marketplace crypto checkout is not configured yet.' });
  }

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in to place an order' });

  const { items: cartItems, txHash, shippingAddress, ageConfirmed, tosAccepted } = req.body || {};
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    return res.status(400).json({ error: 'Cart is empty' });
  }
  if (ageConfirmed !== true || tosAccepted !== true) {
    return res.status(400).json({ error: 'Age confirmation and Marketplace Terms acceptance are both required' });
  }

  // Re-price and re-validate every item against the CURRENT stored listing --
  // never trust a price the client sends. A stale cart (a listing edited or
  // pulled after it was added) is caught here, before anything is verified
  // on-chain, not after.
  const listings = await getListings();
  const resolved = [];
  let needsShipping = false;
  for (const { listingId } of cartItems) {
    const listing = findListing(listings, listingId);
    if (!listing || listing.status !== 'active') {
      return res.status(404).json({ error: `A listing in your cart is no longer available (#${listingId})` });
    }
    if (listing.kind === 'physical') needsShipping = true;
    resolved.push(listing);
  }

  if (needsShipping) {
    for (const field of REQUIRED_ADDRESS_FIELDS) {
      if (!shippingAddress || !String(shippingAddress[field] || '').trim()) {
        return res.status(400).json({ error: `Shipping address is missing ${field}` });
      }
    }
  }

  const totalCents = resolved.reduce((sum, l) => sum + l.priceCents + (l.kind === 'physical' ? l.shippingCents || 0 : 0), 0);
  // USDC is 6 decimals; a stablecoin needs no price oracle since it's 1:1
  // with the dollar by definition -- same reasoning as server/'s STABLE
  // asset handling elsewhere in this codebase.
  const minAmount = (BigInt(totalCents) * 10n ** 6n) / 100n;

  try {
    await verifyUsdcPayment({
      rpcUrl: config.rpcUrl,
      txHash,
      tokenAddress: config.usdcAddress,
      payoutAddress: config.payoutAddress,
      minAmount,
    });
  } catch (err) {
    return res.status(402).json({ error: err.message, code: err.code });
  }

  try {
    const orders = await createOrdersFromPayment({
      txHash,
      buyerId: uid,
      items: resolved.map((l) => ({
        listingId: l.id,
        creatorId: l.creatorId,
        priceCents: l.priceCents,
        shippingCents: l.kind === 'physical' ? l.shippingCents : 0,
        kind: l.kind,
        signatureRequired: l.signatureRequired,
        shippingAddress,
      })),
      ageConfirmed,
      tosAccepted,
    });
    return res.status(200).json({ ok: true, orders });
  } catch (err) {
    if (err.code === 'TX_ALREADY_USED') return res.status(409).json({ error: err.message });
    return res.status(500).json({ error: err.message });
  }
}
