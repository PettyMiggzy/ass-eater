import { useState } from 'react';
import Head from 'next/head';

export default function OnlyAss() {
  const [activeFilter, setActiveFilter] = useState('all');

  const creators = [
    { id: 1, name: 'Mascot Official', handle: '@asseater', img: '/images/mascot.png', subs: '2.4K', price: 'Free' },
    { id: 2, name: 'Sunset Collection', handle: '@sunsetgirl', img: '/images/gallery3.jpg', subs: '1.8K', price: '50 $ASSEAT' },
    { id: 3, name: 'Street Style', handle: '@urbanvibe', img: '/images/gallery2.jpg', subs: '1.2K', price: '50 $ASSEAT' },
    { id: 4, name: 'Pool Days', handle: '@poolsidebabe', img: '/images/gallery4.jpg', subs: '3.1K', price: '75 $ASSEAT' },
    { id: 5, name: 'Fit Life', handle: '@gymqueen', img: '/images/gallery5.jpg', subs: '980', price: '50 $ASSEAT' },
    { id: 6, name: 'Night Owl', handle: '@neonights', img: '/images/gallery6.jpg', subs: '1.5K', price: '60 $ASSEAT' },
  ];

  return (
    <>
      <Head>
        <title>Only Ass - Exclusive Creator Content</title>
        <meta name="description" content="Token-gated exclusive content platform" />
      </Head>

      <div className="min-h-screen bg-gradient-luxury text-white">
        {/* Header */}
        <nav className="w-full bg-brand-dark/95 backdrop-blur-xl border-b border-brand-gold/20 sticky top-0 z-50">
          <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
            <a href="/" className="flex items-center gap-3">
              <img src="/images/mascot.png" alt="logo" className="h-10 w-10 object-contain object-top rounded-full" />
              <span className="text-xl font-bold tracking-widest text-brand-gold">ASS EATER</span>
            </a>
            <div className="flex items-center gap-6 text-sm font-medium">
              <a href="/" className="hover:text-brand-gold transition">Home</a>
              <span className="text-brand-gold font-bold">Only Ass</span>
              <button className="premium-button text-sm px-6 py-2">Connect Wallet</button>
            </div>
          </div>
        </nav>

        {/* Hero Banner */}
        <section className="relative py-16 px-6 border-b border-brand-gold/20">
          <div className="max-w-7xl mx-auto text-center">
            <h1 className="text-6xl md:text-7xl font-black mb-3 premium-title">ONLY ASS</h1>
            <p className="text-brand-secondary font-bold text-lg mb-2">Exclusive Content. Token-Gated Access.</p>
            <p className="text-gray-400 max-w-xl mx-auto">
              Hold $ASSEAT to unlock premium galleries, chat with our characters, and get early drops. Not affiliated with any other platform — built on our own token.
            </p>
          </div>
        </section>

        {/* Filter Bar */}
        <div className="sticky top-[73px] z-40 bg-brand-dark/90 backdrop-blur border-b border-brand-gold/10 py-4">
          <div className="max-w-7xl mx-auto px-6 flex gap-3 overflow-x-auto">
            {['all', 'free', 'premium', 'new'].map((f) => (
              <button
                key={f}
                onClick={() => setActiveFilter(f)}
                className={`px-5 py-2 rounded-full text-sm font-bold whitespace-nowrap transition ${
                  activeFilter === f
                    ? 'bg-gradient-to-r from-brand-gold to-brand-secondary text-black'
                    : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                }`}
              >
                {f.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* Creator Grid */}
        <section className="py-12 px-6">
          <div className="max-w-7xl mx-auto">
            <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-6">
              {creators.map((c) => (
                <div key={c.id} className="premium-card overflow-hidden border-2 border-brand-gold/30 hover:border-brand-gold/60 transition group cursor-pointer">
                  <div className="aspect-[4/5] relative overflow-hidden">
                    <img src={c.img} alt={c.name} className="w-full h-full object-cover group-hover:scale-105 transition duration-500" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black via-black/20 to-transparent"></div>
                    <div className="absolute top-3 right-3 px-3 py-1 rounded-full bg-black/70 backdrop-blur text-brand-gold text-xs font-bold">
                      {c.price}
                    </div>
                    <div className="absolute bottom-0 left-0 right-0 p-4">
                      <p className="font-black text-lg text-white">{c.name}</p>
                      <p className="text-brand-secondary text-sm font-medium">{c.handle}</p>
                      <p className="text-gray-300 text-xs mt-1">{c.subs} subscribers</p>
                    </div>
                  </div>
                  <div className="p-4 flex gap-2">
                    <button className="flex-1 premium-button text-sm py-2">Subscribe</button>
                    <button className="px-4 py-2 border border-brand-gold/40 rounded-md text-brand-gold text-sm hover:bg-brand-gold/10 transition">
                      Preview
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Bottom CTA */}
        <section className="py-16 px-6 border-t border-brand-gold/20">
          <div className="max-w-2xl mx-auto text-center premium-card p-10 border-2 border-brand-gold/40">
            <h2 className="text-3xl font-black text-brand-gold mb-3">Become a Subscriber</h2>
            <p className="text-gray-300 mb-6">Connect your wallet and hold $ASSEAT to unlock exclusive content across all creators.</p>
            <button className="premium-button">Connect Wallet to Unlock</button>
          </div>
        </section>

        <footer className="border-t border-brand-gold/20 py-8 px-6 text-center text-gray-500 text-sm">
          <p>Only Ass — an independent platform. Not affiliated with any other service.</p>
        </footer>
      </div>
    </>
  );
}
