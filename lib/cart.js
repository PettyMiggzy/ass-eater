import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Client-side cart, persisted to localStorage so it survives a refresh (and
 * navigating from a listing card to /cart). This is deliberately NOT server
 * state -- nobody has paid for anything yet, so there is nothing here worth
 * protecting from tampering. Its price snapshot is what the fan is SHOWN,
 * and checkout sends it back as the price the fan agreed to: the server
 * (pages/api/marketplace/orders/create.js) re-prices from the live listing
 * and refuses with 409 PRICE_CHANGED if they differ, rather than charging a
 * price the fan never saw.
 *
 * Items are keyed by listing id (one of each, quantity fixed at 1) -- these
 * are one-off creator listings, not a bulk-SKU store, so "quantity 3 of the
 * same photoset" isn't a real thing a buyer wants.
 */
const STORAGE_KEY = 'onlyone-cart-v1';
const CartContext = createContext(null);

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function CartProvider({ children }) {
  const [items, setItems] = useState([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setItems(readStored());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return; // don't overwrite storage with [] before the initial read lands
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      // localStorage can throw (private mode, quota, disabled) -- the cart
      // just doesn't persist across a refresh in that case, it still works
      // for this tab session since `items` state is unaffected.
    }
  }, [items, hydrated]);

  const add = useCallback((listing) => {
    setItems((prev) => {
      if (prev.some((it) => String(it.id) === String(listing.id))) return prev;
      return [
        ...prev,
        {
          id: listing.id,
          title: listing.title,
          priceCents: listing.priceCents,
          shippingCents: listing.shippingCents || 0,
          kind: listing.kind,
          signatureRequired: !!listing.signatureRequired,
          creatorId: listing.creatorId,
          creatorName: listing.creatorName,
          // Public listing payloads carry a tiny blurred `preview` instead
          // of real media URLs (media is private until bought); fall back
          // to a legacy image src only if an older payload has one.
          img: listing.preview || (listing.media?.[0]?.type === 'video' ? null : listing.media?.[0]?.src || null),
        },
      ];
    });
  }, []);

  const remove = useCallback((id) => {
    setItems((prev) => prev.filter((it) => String(it.id) !== String(id)));
  }, []);

  /**
   * Replaces the price/kind snapshot of items the server says changed
   * (checkout's 409 PRICE_CHANGED carries the current values). The fan then
   * sees the new total and has to confirm again -- the server only ever
   * charges the price the cart showed.
   */
  const applyChanges = useCallback((changes) => {
    const byId = new Map((changes || []).map((c) => [String(c.listingId), c]));
    setItems((prev) =>
      prev.map((it) => {
        const c = byId.get(String(it.id));
        if (!c) return it;
        return {
          ...it,
          title: c.title ?? it.title,
          priceCents: c.priceCents,
          shippingCents: c.shippingCents || 0,
          kind: c.kind,
        };
      }),
    );
  }, []);

  const clear = useCallback(() => setItems([]), []);

  const has = useCallback((id) => items.some((it) => String(it.id) === String(id)), [items]);

  const subtotalCents = items.reduce((sum, it) => sum + (it.priceCents || 0), 0);
  const shippingCents = items.reduce((sum, it) => sum + (it.kind === 'physical' ? it.shippingCents || 0 : 0), 0);
  const totalCents = subtotalCents + shippingCents;
  const needsShipping = items.some((it) => it.kind === 'physical');

  const value = useMemo(
    () => ({ items, add, remove, applyChanges, clear, has, subtotalCents, shippingCents, totalCents, needsShipping, hydrated }),
    [items, add, remove, applyChanges, clear, has, subtotalCents, shippingCents, totalCents, needsShipping, hydrated],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart() must be used inside <CartProvider>');
  return ctx;
}
