import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { resolveCartOwnership, editCart } from './cart-ownership';

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
// v2 stores { owner, items }: the account the cart belongs to (null for a
// cart built while signed out). v1 was a bare array with no owner, so a cart
// could outlive a sign-out and be shown to -- and paid for by -- the next
// account on a shared browser. A v1 cart cannot be attributed to anyone, so it
// is dropped rather than risk handing one person's adult-listing picks to
// another.
const STORAGE_KEY = 'onlyone-cart-v2';
const LEGACY_STORAGE_KEY = 'onlyone-cart-v1';
const CartContext = createContext(null);

const EMPTY = { owner: null, items: [] };

function readStored() {
  try {
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // nothing to drop, or storage unavailable
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) return EMPTY;
    const owner = typeof parsed.owner === 'string' && parsed.owner ? parsed.owner : null;
    return { owner, items: parsed.items };
  } catch {
    return EMPTY;
  }
}

export { resolveCartOwnership, editCart };

export function CartProvider({ children }) {
  const router = useRouter();
  const [stored, setStored] = useState(EMPTY);
  const [storageRead, setStorageRead] = useState(false);
  // The signed-in account as last confirmed with the server
  // (/api/auth/me): undefined until known. Re-checked on every client-side
  // navigation, because logging in, logging out and deleting an account all
  // end in a router.push, which does not remount this provider.
  const [viewer, setViewerState] = useState(undefined);
  const viewerCheck = useRef(0);

  useEffect(() => {
    setStored(readStored());
    setStorageRead(true);
  }, []);

  const checkViewer = useCallback(async (retried = false) => {
    const id = ++viewerCheck.current;
    let failed = false;
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) {
        failed = true; // unknown: keep whatever is withheld, withheld
      } else {
        const data = await res.json();
        if (viewerCheck.current !== id) return;
        const uid = data?.user?.id;
        setViewerState(uid === undefined || uid === null ? null : String(uid));
      }
    } catch {
      // Network failure: the viewer stays unknown; an owned cart stays hidden.
      failed = true;
    }
    // One delayed retry, so a transient failure doesn't leave the owner
    // looking at an empty cart for the whole page view. Skipped if a newer
    // check (or setViewer) has superseded this one in the meantime.
    if (failed && !retried) {
      setTimeout(() => {
        if (viewerCheck.current === id) checkViewer(true);
      }, 1500);
    }
  }, []);

  useEffect(() => {
    checkViewer();
    const onRoute = () => checkViewer();
    router.events?.on('routeChangeComplete', onRoute);
    // A tab left open does not navigate when its account signs out or a
    // different one signs in -- in another tab, or on another device (which
    // revokes this session). Re-confirm the viewer whenever the tab comes back
    // into use, so a cart built by the previous account is withheld here too
    // rather than offered to whoever is signed in now.
    const onFocus = () => checkViewer();
    const onVisible = () => {
      if (document.visibilityState === 'visible') checkViewer();
    };
    // Another tab changed the stored cart (an edit, a checkout, a sign-out
    // discarding it): adopt what is stored now instead of keeping this tab's
    // copy -- and, just as important, instead of writing that stale copy back
    // over it on this tab's next edit. The viewer is re-checked too, since a
    // sign-out/sign-in elsewhere is the usual reason the cart changed.
    //
    // If the stored cart belongs to someone other than the viewer this tab
    // last confirmed, the viewer goes back to UNKNOWN until the re-check
    // answers: resolveCartOwnership then withholds the cart instead of
    // discarding it. Judged against this tab's stale viewer, the new
    // account's cart (written by the tab it signed in on) would be wiped.
    const onStorage = (e) => {
      if (e.storageArea && e.storageArea !== window.localStorage) return;
      if (e.key !== null && e.key !== STORAGE_KEY) return; // null = storage cleared
      const next = readStored();
      const known = viewerRef.current;
      if (known !== undefined && (next.owner ?? null) !== known) {
        viewerCheck.current += 1; // a check still in flight answers for the old state
        setViewerState(undefined);
      }
      setStored(next);
      checkViewer();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('storage', onStorage);
    return () => {
      router.events?.off('routeChangeComplete', onRoute);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('storage', onStorage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * A page that knows the signed-in account authoritatively (from its own
   * getServerSideProps session, or right after logging out) reports it here,
   * so the cart does not wait on the /api/auth/me round trip. null = signed
   * out. Supersedes any /api/auth/me check still in flight.
   */
  const setViewer = useCallback((uid) => {
    viewerCheck.current += 1;
    setViewerState(uid === undefined || uid === null ? null : String(uid));
  }, []);

  const resolved = useMemo(() => resolveCartOwnership(stored, viewer), [stored, viewer]);

  // Persist the adoption / discard the resolution decided.
  useEffect(() => {
    if (!storageRead) return;
    if (resolved.state !== stored) setStored(resolved.state);
  }, [resolved, stored, storageRead]);

  const items = resolved.visible;
  const hydrated = storageRead && resolved.ready;

  useEffect(() => {
    if (!storageRead) return; // don't overwrite storage with [] before the initial read lands
    try {
      if (!stored.items.length && stored.owner === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // localStorage can throw (private mode, quota, disabled) -- the cart
      // just doesn't persist across a refresh in that case, it still works
      // for this tab session since `stored` state is unaffected.
    }
  }, [stored, storageRead]);

  const viewerRef = useRef(viewer);
  viewerRef.current = viewer;

  // Every edit applies to the cart as the CURRENT viewer may see it
  // (lib/cart-ownership.js editCart): another account's cart is never edited
  // or extended, only replaced.
  const setItems = useCallback((fn) => {
    setStored((prev) => editCart(prev, viewerRef.current, fn));
  }, []);

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
    // `viewer`: the signed-in account id as last confirmed (undefined while
    // unknown, null when signed out). /cart compares it with its own SSR
    // session id and reloads when they differ.
    () => ({ items, add, remove, applyChanges, clear, has, subtotalCents, shippingCents, totalCents, needsShipping, hydrated, setViewer, viewer }),
    [items, add, remove, applyChanges, clear, has, subtotalCents, shippingCents, totalCents, needsShipping, hydrated, setViewer, viewer],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart() must be used inside <CartProvider>');
  return ctx;
}
