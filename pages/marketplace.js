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
  const showComingSoon = (msg) => {
    setToast(msg || 'Payments launch with the platform — check back soon.');
    setTimeout(() => setToast(null), 3000);
  };

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

      <div className="min-h-screen bg-gradient-luxury text-white pb-16">
        <div className="max-w-6xl mx-auto px-6 pt-12 text-center">
          <img src="/images/marketplace-header.png" alt="Only Ass Marketplace" className="w-full max-w-md h-auto mx-auto mb-4" />
          <p className="text-gray-400 max-w-xl mx-auto mb-10">
            Creators list their own content and merch here, at whatever price they set. 18+, subject to our
            marketplace terms. Buying launches with the platform's payment system — browsing is live now.
          </p>
        </div>

        <div className="max-w-6xl mx-auto px-6">
          {listings.length === 0 ? (
            <p className="text-center text-gray-500 py-20">No listings yet — creators, be the first.</p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {listings.map((l) => (
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
                  </div>
                  <div className="p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <img src={l.creatorImg} alt="" className="w-5 h-5 rounded-full object-cover object-top" />
                      <span className="text-xs text-gray-400 truncate">{l.creatorName}</span>
                    </div>
                    <p className="font-bold text-sm truncate mb-2">{l.title}</p>
                    <button
                      onClick={() => showComingSoon()}
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
