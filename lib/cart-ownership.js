/**
 * Who a cart may be shown to, given the signed-in account (`viewer`:
 * undefined = not yet known, null = signed out, else the account id).
 *
 * - An anonymous cart (owner null) is shown to whoever is here, and is
 *   ADOPTED by the first account seen signed in on this browser.
 * - An owned cart is shown only once the viewer is confirmed to be its owner.
 *   While the viewer is unknown it is withheld (not deleted); once the viewer
 *   is known to be someone else -- a different account, or nobody (signed
 *   out) -- it is discarded, never carried across.
 *
 * Pure, and kept out of lib/cart.js (JSX, next/router) so it can be tested
 * with plain node.
 */
export function resolveCartOwnership(stored, viewer) {
  const owner = stored?.owner ?? null;
  const items = Array.isArray(stored?.items) ? stored.items : [];
  if (viewer === undefined) {
    return { state: stored, visible: owner === null ? items : [], ready: owner === null };
  }
  const v = viewer === null ? null : String(viewer);
  if (owner === null) {
    // Adopt an anonymous cart into the account that is now signed in.
    const next = v === null || items.length === 0 ? stored : { owner: v, items };
    return { state: next, visible: items, ready: true };
  }
  if (v === owner) return { state: stored, visible: items, ready: true };
  // Signed out, or someone else signed in: the previous account's cart goes.
  return { state: { owner: v, items: [] }, visible: [], ready: true };
}

/**
 * One cart edit (`fn` maps the visible items to the new items) applied for
 * `viewer`. Once the viewer is known, a cart belonging to someone else is
 * never edited or extended: the edit starts from the viewer's own (empty)
 * cart and the result is owned by the viewer (or anonymous, signed out).
 * Before the viewer is known, the edit applies to the stored cart under its
 * EXISTING owner, so the resolution that follows either shows it (same
 * account) or discards it (anyone else) -- it is never re-attributed.
 */
export function editCart(prev, viewer, fn) {
  const stored = prev && Array.isArray(prev.items) ? prev : { owner: null, items: [] };
  if (viewer === undefined) {
    const next = fn(stored.items);
    return next === stored.items ? stored : { owner: stored.owner ?? null, items: next };
  }
  const r = resolveCartOwnership(stored, viewer);
  const next = fn(r.visible);
  if (next === r.visible) return r.state;
  return { owner: viewer === null ? null : String(viewer), items: next };
}
