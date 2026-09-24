import { getSessionUser } from '../../../../lib/session';
import { query, rowToRecord } from '../../../../lib/db';
import { getListingById } from '../../../../lib/listings-store';

/**
 * GET /api/marketplace/orders/delivery?orderId=<id>
 *   -> 200 { orderId, listingId, title, removed: boolean, items: [{ type, src, aiGenerated }] }
 *   -> 401 not logged in; 404 not the caller's paid digital order
 *
 * How a buyer actually receives a digital purchase. Checkout charged the fan
 * and marked the order fulfilled, but nothing ever handed them the files.
 * Each `src` is an /api/media/... path; that route authorizes it again by the
 * same order, so the list itself grants nothing on its own.
 *
 * `removed: true` (with no items) when moderation took the listing down --
 * its files were deleted as part of that takedown.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'private, no-store');

  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });

  const orderId = typeof req.query.orderId === 'string' ? req.query.orderId : '';
  if (!/^[0-9]{1,18}$/.test(orderId)) return res.status(400).json({ error: 'Missing order id' });

  try {
    const { rows } = await query(
      `select id, data from orders
        where id = $1
          and data->>'buyerId' = $2
          and data->>'kind' = 'digital'
          and coalesce(data->>'status', '') in ('fulfilled', 'delivered')`,
      [orderId, String(user.id)],
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = rowToRecord(rows[0]);

    const listing = await getListingById(order.listingId);
    const removed = !listing || !!listing.moderationRemoved;
    const items = removed
      ? []
      : (Array.isArray(listing.media) ? listing.media : [])
          .filter((m) => m && typeof m.src === 'string' && m.src.startsWith('/api/media/'))
          .map((m) => ({
            type: m.type === 'video' ? 'video' : 'image',
            src: m.src,
            aiGenerated: !!(m.aiGenerated || listing.aiGenerated),
          }));
    return res.status(200).json({
      orderId: order.id,
      listingId: order.listingId,
      title: order.title || listing?.title || null,
      removed,
      items,
    });
  } catch (err) {
    console.error('[marketplace/orders/delivery] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
