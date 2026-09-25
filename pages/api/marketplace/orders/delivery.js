import { getSessionUser } from '../../../../lib/session';
import { query, rowToRecord } from '../../../../lib/db';
import { getListingById } from '../../../../lib/listings-store';
import { preservedSubset } from '../../../../lib/media-preservation';
import { blobPathnameFromSrc } from '../../../../lib/blob-cleanup';

/**
 * GET /api/marketplace/orders/delivery?orderId=<id>
 *   -> 200 { orderId, listingId, title, removed: boolean,
 *            removedReason: null | 'moderation' | 'creator_deleted' | 'deleted',
 *            withheld: number,
 *            items: [{ type, src, aiGenerated }] }
 *   -> 401 not logged in; 404 not the caller's paid digital order
 *
 * How a buyer actually receives a digital purchase. Checkout charged the fan
 * and marked the order fulfilled, but nothing ever handed them the files.
 * Each `src` is an /api/media/... path; that route authorizes it again by the
 * same order, so the list itself grants nothing on its own.
 *
 * `removed` is keyed off whether the files are actually GONE
 * (`mediaDeletedAt`), not off `moderationRemoved`:
 *  - a listing taken down for its content (a report, a TAKE IT DOWN request,
 *    a content-violation ban) has its files deleted -> removedReason
 *    'moderation';
 *  - a seller deleted with files nobody had paid for -> 'creator_deleted';
 *  - the listing row itself missing -> 'deleted'.
 * A seller banned by hand, or deleted, keeps the files of listings buyers
 * paid for (lib/listings-store.js removeListingsForCreator keepPaid), so those
 * orders still deliver even though the listing is off sale. Before, a deleted
 * seller's order answered removed:false with srcs whose files were gone, and
 * /orders drew broken tiles with no explanation.
 *
 * Files quarantined as evidence (lib/media-preservation.js) are never served,
 * to buyers either, so they are left out of `items` and counted in `withheld`
 * rather than listed as tiles that 404; when every file is withheld the order
 * reads removed with removedReason 'moderation'.
 *
 * Items the creator removed from the listing AFTER this order was placed
 * (`retainedMedia`, removedAt later than the order) are still delivered; ones
 * removed before it are not -- the buyer never bought them.
 */
function orderTime(order) {
  const t = Date.parse(order?.createdAt || '');
  return Number.isNaN(t) ? null : t;
}

function toItem(m, listing) {
  return {
    type: m.type === 'video' ? 'video' : 'image',
    src: m.src,
    aiGenerated: !!(m.aiGenerated || listing.aiGenerated),
  };
}

const isOurs = (m) => m && typeof m.src === 'string' && m.src.startsWith('/api/media/');

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
    let removedReason = null;
    if (!listing) removedReason = 'deleted';
    else if (listing.mediaDeletedAt) removedReason = listing.moderationRemoved ? 'moderation' : 'creator_deleted';
    const removed = removedReason !== null;

    let items = [];
    let withheld = 0;
    if (!removed) {
      const placed = orderTime(order);
      const live = (Array.isArray(listing.media) ? listing.media : []).filter(isOurs);
      const retained = (Array.isArray(listing.retainedMedia) ? listing.retainedMedia : [])
        .filter(isOurs)
        .filter((m) => {
          const gone = Date.parse(m.removedAt || '');
          return placed !== null && !Number.isNaN(gone) && placed <= gone;
        });
      const all = [...live, ...retained];
      const preserved = await preservedSubset(all.map((m) => blobPathnameFromSrc(m.src)).filter(Boolean));
      const served = all.filter((m) => !preserved.has(blobPathnameFromSrc(m.src)));
      withheld = all.length - served.length;
      items = served.map((m) => toItem(m, listing));
      if (withheld && !items.length) removedReason = 'moderation';
    }
    return res.status(200).json({
      orderId: order.id,
      listingId: order.listingId,
      title: order.title || listing?.title || null,
      removed: removedReason !== null,
      removedReason,
      withheld,
      items,
    });
  } catch (err) {
    console.error('[marketplace/orders/delivery] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
