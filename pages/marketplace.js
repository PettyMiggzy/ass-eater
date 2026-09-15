import { useState } from 'react';
import Head from 'next/head';
import { getListings } from '../lib/listings-store';
import { getCreators } from '../lib/creators-store';

export async function getServerSideProps() {
  const [listings, creators] = await Promise.all([getListings(), getCreators()]);
  const active = listings
    .filter((l) => l.status === 'active')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((l) => {
      const creator = creators.find((c) => String(c.id) === String(l.creatorId));
      return { ...l, creatorName: creator?.name || 'Unknown', creatorImg: creator?.img || '/images/mascot.png' };
    });
  return { props: { listings: active } };
}

export default function Marketplace({ listings }) {
  const [toast, setToast] = useState(null);
  const [reporting, setReporting] = useState(null);
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [q, setQ] = useState('');

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const submitReport = async (e) => {
    e.preventDefault();
    if (!reason.trim()) return;
    setSending(true);
    try {
      const res = await fetch('/api/marketplace/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listingId: reporting.id, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to report');
      showToast('Reported — our team will review it.');
      setReporting(null);
      setReason('');
    } catch (err) {
      showToast(err.message);
    } finally {
      setSending(false);
    }
  };

  const filtered = q.trim()
    ? listings.filter((l) => l.title.toLowerCase().includes(q.toLowerCase()) || (l.description || '').toLowerCase().includes(q.toLowerCase()))
    : listings;

  return (
    <>
      <Head>
        <title>Marketplace - Only Ass</title>
        <meta name="description" content="Only Ass Marketplace — creators sell images, videos, and more." />
        <meta name="rating" content="RTA-5042-1996-1400-1577-RTA" />
      </Head>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] px-6 py-3 rounded-full bg-brand-gold text-black font-bold shadow-luxury-lg">
          {toast}
        </div>
      )}

      {reporting && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
          <form onSubmit={submitReport} className="premium-card w-full max-w-sm p-6">
            <p className="font-bold text-white mb-1">Report "{reporting.title}"</p>
            <p className="text-xs text-gray-500 mb-4">Tell us what's wrong with this listing.</p>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Reason..."
              className="w-full px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm mb-4"
            />
            <div className="flex gap-2">
              <button type="button" onClick={() => setReporting(null)} className="flex-1 text-sm px-4 py-2 rounded-md border border-brand-purple/30 text-gray-300 hover:bg-white/5 transition">
                Cancel
              </button>
              <button type="submit" disabled={sending} className="flex-1 premium-button text-sm disabled:opacity-50">
                Submit
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="min-h-screen bg-gradient-luxury text-white pb-16">
        <div className="max-w-6xl mx-auto px-6 pt-12 text-center">
          <img src="/images/marketplace-header.png" alt="Only Ass Marketplace" className="w-full max-w-md h-auto mx-auto mb-4" />
          <p className="text-gray-400 max-w-xl mx-auto mb-6">
            Creators list their own content and merch here, at whatever price they set. 18+, subject to our
            marketplace terms. Buying launches with the platform's payment system — browsing is live now.
          </p>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search listings..."
            className="w-full max-w-md mx-auto block px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm mb-10"
          />
        </div>

        <div className="max-w-6xl mx-auto px-6">
          {filtered.length === 0 ? (
            <p className="text-center text-gray-500 py-20">
              {listings.length === 0 ? 'No listings yet — creators, be the first.' : 'No listings match your search.'}
            </p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {filtered.map((l) => (
                <div key={l.id} className="premium-card border border-brand-gold/20 overflow-hidden">
                  <div className="aspect-square relative bg-black/40">
                    {l.media?.[0] ? (
                      l.media[0].type === 'video' ? (
                        <video src={l.media[0].src} className="w-full h-full object-cover blur-md scale-110" muted />
                      ) : (
                        <img src={l.media[0].src} alt="" className="w-full h-full object-cover blur-md scale-110" />
                      )
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-gray-600 text-sm">No preview</div>
                    )}
                    <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                      <img src="/icons/lock.png" className="h-6 w-6" alt="" />
                    </div>
                    <button
                      onClick={() => setReporting(l)}
                      className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-white text-xs hover:bg-black/90 transition"
                      title="Report this listing"
                    >
                      ⚑
                    </button>
                  </div>
                  <div className="p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <img src={l.creatorImg} alt="" className="w-5 h-5 rounded-full object-cover object-top" />
                      <span className="text-xs text-gray-400 truncate">{l.creatorName}</span>
                    </div>
                    <p className="font-bold text-sm truncate mb-2">{l.title}</p>
                    <button
                      onClick={() => showToast('Payments launch with the platform — check back soon.')}
                      className="premium-button w-full text-xs py-2"
                    >
                      Buy — ${(l.priceCents / 100).toFixed(2)}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="text-center mt-16">
          <a href="/" className="premium-button inline-block">Back to Only Ass</a>
        </div>
      </div>
    </>
  );
}
