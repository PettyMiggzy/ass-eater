import { useEffect, useState } from 'react';
import Head from 'next/head';
import SiteNav from '../components/SiteNav';
import { getSessionUser } from '../lib/session';
import { publicUser } from '../lib/users-store';

export async function getServerSideProps({ req }) {
  const sessionUser = publicUser(await getSessionUser(req));
  if (!sessionUser) {
    return { redirect: { destination: '/login?next=/orders', permanent: false } };
  }
  return { props: { sessionUser } };
}

const STATUS_LABEL = {
  fulfilled: 'Delivered',
  pending_shipment: 'Preparing to ship',
  shipped: 'Shipped',
};

// The fan-facing half of order history -- the API this calls
// (GET /api/marketplace/orders/mine) already existed and worked, it just had
// no page anywhere pointing at it, so a fan had no way to see what they'd
// bought once the one-time "Payment confirmed" screen on /cart was gone.
export default function OrdersPage({ sessionUser }) {
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/marketplace/orders/mine')
      .then((r) => r.json())
      .then((d) => setOrders(d.orders || []))
      .catch(() => setError('Could not load your orders'));
  }, []);

  return (
    <>
      <Head>
        <title>Your Orders — OnlyOne</title>
      </Head>
      <div className="min-h-screen bg-brand-ink text-white pb-24">
        <SiteNav signedIn viewerAvatar={sessionUser?.img || null} />
        <div className="max-w-2xl mx-auto px-6 py-10">
          <h1 className="text-3xl font-black mb-6">Your Orders</h1>

          {error && <p className="text-sm text-red-400">{error}</p>}

          {orders === null && !error ? (
            <p className="text-gray-500 text-sm">Loading…</p>
          ) : orders && orders.length === 0 ? (
            <div className="text-center py-20">
              <p className="text-gray-400 mb-5">You haven't bought anything yet.</p>
              <a href="/marketplace" className="inline-block px-6 py-3 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-bold text-sm transition">
                Browse the marketplace
              </a>
            </div>
          ) : (
            <div className="space-y-3">
              {orders?.map((o) => (
                <div key={o.id} className="rounded-xl bg-white/5 border border-white/5 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-bold text-sm truncate">{o.title || `Listing #${o.listingId}`}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {o.createdAt ? new Date(o.createdAt).toLocaleDateString() : ''} · {o.kind === 'physical' ? 'Ships to you' : 'Digital'}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-bold text-sm">${(((o.priceCents || 0) + (o.shippingCents || 0)) / 100).toFixed(2)}</p>
                      <p className="text-[11px] text-gray-400 mt-0.5">{STATUS_LABEL[o.status] || o.status}</p>
                    </div>
                  </div>
                  {o.kind === 'physical' && o.status === 'shipped' && (o.carrier || o.trackingNumber) && (
                    <p className="text-xs text-gray-400 mt-2 pt-2 border-t border-white/10">
                      {o.carrier ? `${o.carrier} — ` : ''}{o.trackingNumber || 'No tracking number provided'}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
