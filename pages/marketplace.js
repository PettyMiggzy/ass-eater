import { useState } from 'react';
import Head from 'next/head';
import { getListings } from '../lib/listings-store';
import { getCreators } from '../lib/creators-store';

// This page is also served as the root ('/') of onlyass.shop via proxy.js's
// rewrite -- a relative href="/" there just re-renders this same page
// instead of leaving the domain (same reasoning as gateway.js's MAIN_SITE).
const MAIN_SITE = 'https://onlyass.fun';

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
  const [buying, setBuying] = useState(null);
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [tosAccepted, setTosAccepted] = useState(false);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const openBuy = (listing) => {
    setAgeConfirmed(false);
    setTosAccepted(false);
    setBuying(listing);
  };

  const confirmBuy = () => {
    // Once real marketplace checkout exists, this is where it fires with
    // { ageConfirmed: true, tosAccepted: true } -- the platform's own buy
    // endpoint requires both, recorded against the specific order (see
    // Section 6 of /terms). Not wiring a real charge yet since none exists.
    setBuying(null);
    showToast('Payments launch with the platform — check back soon.');
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

      {buying && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
          <div className="premium-card w-full max-w-sm p-6">
            <p className="font-bold text-white mb-1">Confirm purchase</p>
            <p className="text-xs text-gray-500 mb-4">
              "{buying.title}" — ${(buying.priceCents / 100).toFixed(2)}
              {buying.kind === 'physical' && buying.shippingCents ? ` + $${(buying.shippingCents / 100).toFixed(2)} shipping` : ''}
              , sold by {buying.creatorName}.
            </p>
            <label className="flex items-start gap-2 text-xs text-gray-400 mb-3">
              <input type="checkbox" checked={ageConfirmed} onChange={(e) => setAgeConfirmed(e.target.checked)} className="mt-0.5" />
              I am 18 years of age or older (or the age of majority in my jurisdiction, whichever is higher).
            </label>
            <label className="flex items-start gap-2 text-xs text-gray-400 mb-4">
              <input type="checkbox" checked={tosAccepted} onChange={(e) => setTosAccepted(e.target.checked)} className="mt-0.5" />
              I've read and agree to the{' '}
              <a href={`${MAIN_SITE}/terms#marketplace`} target="_blank" rel="noreferrer" className="text-brand-gold underline">
                Marketplace Terms
              </a>{' '}
              — this purchase is an agreement directly between me and the creator; Only Ass is not a party to
              the sale, does not hold funds in escrow, and is not responsible for shipping, delivery, item
              condition, or resolving disputes between us.
            </label>
            <div className="flex gap-2">
              <button type="button" onClick={() => setBuying(null)} className="flex-1 text-sm px-4 py-2 rounded-md border border-brand-purple/30 text-gray-300 hover:bg-white/5 transition">
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmBuy}
                disabled={!ageConfirmed || !tosAccepted}
                className="flex-1 premium-button text-sm disabled:opacity-50"
              >
                Continue
              </button>
            </div>
          </div>
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
                      onClick={() => openBuy(l)}
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
          <a href={MAIN_SITE} className="premium-button inline-block">Back to Only Ass</a>
        </div>
      </div>
    </>
  );
}
