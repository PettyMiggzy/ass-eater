import { useState } from 'react';
import Head from 'next/head';
import SiteNav from '../components/SiteNav';
import { getListings } from '../lib/listings-store';
import { getCreators } from '../lib/creators-store';
import { isPubliclyVisible } from '../lib/creator-status';
import { isFoundingCreator } from '../lib/founding';

// This page is also served as the root ('/') of onlyass.shop via proxy.js's
// rewrite -- a relative href="/" there just re-renders this same page
// instead of leaving the domain (same reasoning as gateway.js's MAIN_SITE).
const MAIN_SITE = 'https://joinonlyone.com'; // primary domain as of 2026-09-19 -- onlyass.fun still works as a mirror

const KINDS = [
  { value: 'all', label: 'All' },
  { value: 'photo', label: 'Photos' },
  { value: 'video', label: 'Video' },
  { value: 'physical', label: 'Merch' },
];

export async function getServerSideProps() {
  const [listings, creators] = await Promise.all([getListings(), getCreators()]);
  // A suspended or banned creator's listings come OFF the marketplace, not
  // just their name. Masking the seller to "Unknown" left a banned creator's
  // merch on sale with a working Buy button and a link to a profile that
  // renders "Creator not found" -- which is not what hiding them means.
  const visible = new Map(
    creators.filter(isPubliclyVisible).map((c) => [String(c.id), c]),
  );
  const active = listings
    .filter((l) => l.status === 'active' && visible.has(String(l.creatorId)))
    .map((l) => {
      const creator = visible.get(String(l.creatorId));
      return {
        ...l,
        creatorName: creator.name,
        creatorImg: creator.img || '/images/avatar-placeholder.png',
        creatorFounding: isFoundingCreator(creator),
      };
    })
    // "Priority placement in Marketplace" for Founding Creators, newest
    // first within each group. A real sort, not a label.
    .sort((a, b) => {
      const founding = (b.creatorFounding ? 1 : 0) - (a.creatorFounding ? 1 : 0);
      if (founding !== 0) return founding;
      return new Date(b.createdAt) - new Date(a.createdAt);
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
  const [kind, setKind] = useState('all');
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

  // Filters are derived, never stored -- a listing's kind/media is the source
  // of truth, so a mislabelled chip can't hide a real listing permanently.
  const byKind = listings.filter((l) => {
    if (kind === 'all') return true;
    if (kind === 'physical') return l.kind === 'physical';
    if (kind === 'video') return l.media?.[0]?.type === 'video';
    return l.kind !== 'physical' && l.media?.[0]?.type !== 'video';
  });
  const filtered = q.trim()
    ? byKind.filter((l) => l.title.toLowerCase().includes(q.toLowerCase()) || (l.description || '').toLowerCase().includes(q.toLowerCase()))
    : byKind;

  return (
    <>
      <Head>
        <title>Marketplace — OnlyOne</title>
        <meta name="description" content="Buy photo sets, video and merch direct from OnlyOne creators." />
        <meta name="rating" content="RTA-5042-1996-1400-1577-RTA" />
      </Head>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] px-6 py-3 rounded-full bg-brand-pink text-white font-bold shadow-lg">
          {toast}
        </div>
      )}

      {reporting && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
          <form onSubmit={submitReport} className="w-full max-w-sm p-6 rounded-2xl bg-brand-card border border-white/10">
            <p className="font-bold text-white mb-1">Report "{reporting.title}"</p>
            <p className="text-xs text-gray-500 mb-4">Tell us what's wrong with this listing.</p>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Reason..."
              className="w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-white text-sm mb-4 focus:outline-none focus:border-brand-pink/60"
            />
            <div className="flex gap-2">
              <button type="button" onClick={() => setReporting(null)} className="flex-1 text-sm px-4 py-2.5 rounded-full border border-white/15 text-gray-300 hover:bg-white/5 transition">
                Cancel
              </button>
              <button type="submit" disabled={sending} className="flex-1 text-sm px-4 py-2.5 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-bold transition disabled:opacity-50">
                Submit
              </button>
            </div>
          </form>
        </div>
      )}

      {buying && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
          <div className="w-full max-w-sm p-6 rounded-2xl bg-brand-card border border-white/10">
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
              <a href={`${MAIN_SITE}/terms#marketplace`} target="_blank" rel="noreferrer" className="text-brand-pink underline">
                Marketplace Terms
              </a>{' '}
              — this purchase is an agreement directly between me and the creator; OnlyOne is not a party to
              the sale, does not hold funds in escrow, and is not responsible for shipping, delivery, item
              condition, or resolving disputes between us.
            </label>
            <div className="flex gap-2">
              <button type="button" onClick={() => setBuying(null)} className="flex-1 text-sm px-4 py-2.5 rounded-full border border-white/15 text-gray-300 hover:bg-white/5 transition">
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmBuy}
                disabled={!ageConfirmed || !tosAccepted}
                className="flex-1 text-sm px-4 py-2.5 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-bold transition disabled:opacity-50"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="min-h-screen bg-brand-ink text-white pb-20">
        <SiteNav />

        {/* Header. Ambient glow only -- the listings themselves carry the
            imagery, and every preview is blurred until someone owns it. */}
        <div className="relative overflow-hidden border-b border-white/5">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            <div className="absolute left-1/2 -top-40 -translate-x-1/2 w-[800px] h-[500px] max-w-[160vw] rounded-full bg-brand-pink/10 blur-[130px]" />
          </div>
          <div className="relative max-w-6xl mx-auto px-6 py-12">
            <p className="text-[11px] tracking-[0.3em] text-brand-pink mb-3">MARKETPLACE</p>
            <h1 className="text-4xl sm:text-5xl font-black tracking-tight leading-none">
              BUY DIRECT FROM <span className="text-brand-pink">CREATORS</span>
            </h1>
            <p className="mt-4 text-sm text-gray-400 max-w-xl leading-relaxed">
              Photo sets, video, and physical merch — listed by creators at whatever price they set.
              Every purchase is between you and them.
            </p>

            {/* Said plainly and up front rather than discovered at checkout.
                Browsing is genuinely live; paying is not built yet. */}
            <div className="mt-6 inline-flex items-start gap-2 px-4 py-2.5 rounded-xl border border-brand-pink/25 bg-brand-pink/5 text-xs text-gray-300">
              <span className="text-brand-pink font-bold">Heads up:</span>
              <span>Browsing is live. Checkout opens when payments do — nothing here can charge you yet.</span>
            </div>

            <div className="mt-8 flex flex-col sm:flex-row gap-3 sm:items-center">
              <label className="relative flex-1 max-w-md">
                <span className="sr-only">Search listings</span>
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search listings..."
                  className="w-full px-4 py-3 rounded-full bg-white/5 border border-white/10 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-brand-pink/60"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                {KINDS.map((k) => (
                  <button
                    key={k.value}
                    onClick={() => setKind(k.value)}
                    className={`px-4 py-2 rounded-full text-xs tracking-wide transition border ${
                      kind === k.value
                        ? 'bg-brand-pink border-brand-pink text-white font-bold'
                        : 'border-white/10 text-gray-400 hover:text-white hover:border-white/25'
                    }`}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="max-w-6xl mx-auto px-6 pt-10">
          {filtered.length === 0 ? (
            <div className="text-center py-24">
              <p className="text-gray-400">
                {listings.length === 0 ? 'Nothing listed yet.' : 'Nothing matches that.'}
              </p>
              {listings.length === 0 && (
                <a href="/dashboard" className="mt-5 inline-block px-6 py-3 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-bold text-sm transition">
                  Creators — list the first thing
                </a>
              )}
            </div>
          ) : (
            <>
              <p className="text-xs text-gray-500 mb-4">
                {filtered.length} {filtered.length === 1 ? 'listing' : 'listings'}
              </p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {filtered.map((l) => (
                  <div key={l.id} className="group rounded-2xl overflow-hidden bg-white/5 border border-white/5 hover:border-brand-pink/40 transition flex flex-col">
                    <div className="aspect-square relative bg-black/40">
                      {l.media?.[0] ? (
                        l.media[0].type === 'video' ? (
                          <video src={l.media[0].src} className="w-full h-full object-cover blur-xl scale-110" muted />
                        ) : (
                          <img src={l.media[0].src} alt="" className="w-full h-full object-cover blur-xl scale-110" />
                        )
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-600 text-xs">No preview</div>
                      )}
                      <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                        <span className="w-10 h-10 rounded-full bg-black/60 border border-white/15 flex items-center justify-center text-base">🔒</span>
                      </div>

                      <div className="absolute top-2 left-2 flex flex-col gap-1 items-start">
                        {l.creatorFounding && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-brand-pink text-white font-black tracking-wide">FOUNDING</span>
                        )}
                        {l.aiGenerated && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-black/75 text-brand-pink font-bold">AI</span>
                        )}
                        {l.kind === 'physical' && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-black/75 text-gray-200 font-bold">SHIPS</span>
                        )}
                      </div>

                      <button
                        onClick={() => setReporting(l)}
                        className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/70 text-white text-xs opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-black/90 transition"
                        title="Report this listing"
                      >
                        ⚑
                      </button>
                    </div>

                    <div className="p-3 flex flex-col flex-1">
                      <a href={`/creator/${l.creatorId}`} className="flex items-center gap-2 mb-2 group/creator">
                        <img src={l.creatorImg} alt="" className="w-5 h-5 rounded-full object-cover object-top" />
                        <span className="text-[11px] text-gray-400 truncate group-hover/creator:text-brand-pink transition">
                          {l.creatorName}
                        </span>
                      </a>
                      <p className="font-bold text-sm leading-snug mb-3 line-clamp-2">{l.title}</p>
                      <button
                        onClick={() => openBuy(l)}
                        className="mt-auto w-full py-2.5 rounded-full bg-white/10 hover:bg-brand-pink text-sm font-bold transition"
                      >
                        ${(l.priceCents / 100).toFixed(2)}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <footer className="border-t border-white/5 mt-20 py-8 px-6">
          <div className="max-w-6xl mx-auto flex flex-wrap justify-center gap-x-5 gap-y-2 text-[11px] text-gray-600">
            <a href={MAIN_SITE} className="hover:text-brand-pink transition">OnlyOne</a>
            <a href={`${MAIN_SITE}/terms#marketplace`} className="hover:text-brand-pink transition">Marketplace Terms</a>
            <a href={`${MAIN_SITE}/privacy`} className="hover:text-brand-pink transition">Privacy</a>
            <a href={`${MAIN_SITE}/report-content`} className="text-red-400 hover:text-red-300 transition font-semibold">
              Report Non-Consensual Content
            </a>
          </div>
          <p className="text-[11px] text-gray-600 text-center mt-3">18+ only. Sales are between buyer and creator.</p>
        </footer>
      </div>
    </>
  );
}
