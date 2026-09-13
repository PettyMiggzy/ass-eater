import { useState, useMemo, useEffect } from 'react';
import Head from 'next/head';

export default function OnlyAss() {
  const [activeFilter, setActiveFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [dashTab, setDashTab] = useState('Overview');
  const [showSplash, setShowSplash] = useState(true);
  const [splashFading, setShowSplashFading] = useState(false);

  useEffect(() => {
    const fadeTimer = setTimeout(() => setShowSplashFading(true), 3200);
    const hideTimer = setTimeout(() => setShowSplash(false), 3700);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(hideTimer);
    };
  }, []);

  const skipSplash = () => {
    setShowSplashFading(true);
    setTimeout(() => setShowSplash(false), 400);
  };

  const creators = [
    { id: 1, name: 'Mascot Official', handle: '@asseater', img: '/images/mascot.png', video: null, subs: '2.4K', price: 'Free', locked: false, trending: true },
    { id: 2, name: 'Sunset Collection', handle: '@sunsetgirl', img: '/images/gallery3.jpg', video: '/videos/sunset.mp4', subs: '1.8K', price: '1M $ASSEAT', locked: true, trending: true },
    { id: 3, name: 'Street Style', handle: '@urbanvibe', img: '/images/gallery2.jpg', video: '/videos/street.mp4', subs: '1.2K', price: '1M $ASSEAT', locked: true, trending: false },
    { id: 4, name: 'Pool Days', handle: '@poolsidebabe', img: '/images/gallery4.jpg', video: '/videos/pool.mp4', subs: '3.1K', price: '1.5M $ASSEAT', locked: true, trending: true },
    { id: 5, name: 'Fit Life', handle: '@gymqueen', img: '/images/gallery5.jpg', video: '/videos/gym.mp4', subs: '980', price: '1M $ASSEAT', locked: true, trending: false },
    { id: 6, name: 'Night Owl', handle: '@neonights', img: '/images/gallery6.jpg', video: '/videos/night.mp4', subs: '1.5K', price: '1.2M $ASSEAT', locked: true, trending: false },
  ];

  const filtered = useMemo(() => {
    return creators.filter((c) => {
      const matchesFilter =
        activeFilter === 'all' ||
        (activeFilter === 'free' && c.price === 'Free') ||
        (activeFilter === 'premium' && c.price !== 'Free') ||
        (activeFilter === 'trending' && c.trending);
      const matchesSearch =
        search === '' ||
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        c.handle.toLowerCase().includes(search.toLowerCase());
      return matchesFilter && matchesSearch;
    });
  }, [activeFilter, search]);

  const subscribers = [
    { name: 'degen_mike', plan: 'All Access', amount: '3M', status: 'Active' },
    { name: 'sara.eth', plan: 'VIP', amount: '8M', status: 'Active' },
    { name: 'apeking99', plan: 'Starter', amount: '1M', status: 'Expiring' },
    { name: 'crypto_chad', plan: 'All Access', amount: '3M', status: 'Active' },
  ];

  return (
    <>
      <Head>
        <title>Only Ass - Exclusive Creator Content</title>
        <meta name="description" content="Token-gated exclusive content platform" />
      </Head>

      {showSplash && (
        <div
          className={`fixed inset-0 z-[100] bg-black flex items-center justify-center transition-opacity duration-500 ${
            splashFading ? 'opacity-0' : 'opacity-100'
          }`}
        >
          <video
            src="/videos/splash.mp4"
            autoPlay
            muted
            playsInline
            className="absolute inset-0 w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-black/60"></div>
          <div className="relative z-10 text-center px-6">
            <h1 className="text-6xl md:text-8xl font-black mb-4 premium-title">ONLY ASS</h1>
            <p className="text-brand-secondary font-bold tracking-widest eyebrow">18+ Exclusive Platform</p>
          </div>
          <button
            onClick={skipSplash}
            className="absolute bottom-8 right-8 px-5 py-2 rounded-full border border-brand-gold/40 text-brand-gold text-sm font-bold hover:bg-brand-gold/10 transition"
          >
            Skip
          </button>
        </div>
      )}

      <div className="min-h-screen bg-gradient-luxury text-white">
        {/* Header */}
        <nav className="w-full bg-brand-dark/95 backdrop-blur-xl border-b border-brand-gold/20 sticky top-0 z-50">
          <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
            <a href="/" className="flex items-center gap-3">
              <img src="/images/mascot.png" alt="logo" className="h-10 w-10 object-contain object-top rounded-full" />
              <span className="text-xl font-bold tracking-widest text-brand-gold">ASS EATER</span>
            </a>
            <div className="hidden md:flex items-center gap-8 text-sm font-medium text-gray-300">
              <a href="#creators" className="hover:text-brand-gold transition">Creators</a>
              <a href="#pricing" className="hover:text-brand-gold transition">Pricing</a>
              <a href="#dashboard" className="hover:text-brand-gold transition">Dashboard</a>
            </div>
            <div className="flex items-center gap-3">
              <a href="/" className="text-sm text-gray-400 hover:text-brand-gold transition hidden sm:block">Home</a>
              <button className="premium-button text-sm px-6 py-2">Connect Wallet</button>
            </div>
          </div>
        </nav>

        {/* Hero Banner */}
        <section className="relative py-20 px-6 border-b border-brand-gold/20 overflow-hidden">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[700px] bg-brand-gold/10 rounded-full blur-3xl"></div>
          <div className="max-w-7xl mx-auto text-center relative z-10">
            <div className="inline-block px-4 py-1 rounded-full bg-brand-gold/20 text-brand-gold text-xs font-bold tracking-widest mb-6">
              18+ EXCLUSIVE PLATFORM
            </div>
            <h1 className="text-7xl md:text-8xl font-black mb-3 premium-title">ONLY ASS</h1>
            <p className="text-brand-secondary font-bold text-xl mb-3">Support the creators you actually love.</p>
            <p className="text-gray-400 max-w-xl mx-auto mb-10">
              Hold $ASSEAT to unlock premium galleries, chat with our characters, and get early drops. No ads, no algorithm — just exclusive content on our own token.
            </p>

            {/* Stats Bar */}
            <div className="flex flex-wrap justify-center gap-6 md:gap-12 mb-12">
              <div className="text-center">
                <p className="text-3xl font-black text-brand-gold">12.4K</p>
                <p className="text-xs text-gray-400 uppercase tracking-wide">Members</p>
              </div>
              <div className="text-center">
                <p className="text-3xl font-black text-brand-gold">340+</p>
                <p className="text-xs text-gray-400 uppercase tracking-wide">Exclusive Drops</p>
              </div>
              <div className="text-center">
                <p className="text-3xl font-black text-brand-gold">6</p>
                <p className="text-xs text-gray-400 uppercase tracking-wide">Creators</p>
              </div>
              <div className="text-center">
                <p className="text-3xl font-black text-brand-gold">24/7</p>
                <p className="text-xs text-gray-400 uppercase tracking-wide">New Content</p>
              </div>
            </div>

            {/* Search */}
            <div className="max-w-md mx-auto">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search creators..."
                className="w-full px-6 py-3 rounded-full bg-black/40 border border-brand-gold/30 text-white placeholder-gray-500 focus:outline-none focus:border-brand-gold transition"
              />
            </div>
          </div>
        </section>

        {/* Filter Bar */}
        <div id="creators" className="sticky top-[73px] z-40 bg-brand-dark/90 backdrop-blur border-b border-brand-gold/10 py-4">
          <div className="max-w-7xl mx-auto px-6 flex gap-3 overflow-x-auto">
            {['all', 'trending', 'free', 'premium'].map((f) => (
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
            {filtered.length === 0 ? (
              <p className="text-center text-gray-500 py-12">No creators match your search.</p>
            ) : (
              <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-8 pt-10">
                {filtered.map((c) => (
                  <div key={c.id} className="premium-card overflow-visible border-2 border-brand-gold/30 hover:border-brand-gold/60 transition group cursor-pointer pt-10">
                    {/* Avatar overlapping the top of the card */}
                    <div className="absolute -top-8 left-1/2 -translate-x-1/2 w-16 h-16 rounded-full border-4 border-gray-900 overflow-hidden bg-gray-800 z-10 shadow-luxury">
                      <img src={c.img} alt={c.name} className="w-full h-full object-cover object-top" />
                    </div>

                    <div className="aspect-[4/5] relative overflow-hidden rounded-t-lg mx-3">
                      {c.video ? (
                        <video
                          src={c.video}
                          autoPlay
                          loop
                          muted
                          playsInline
                          className={`w-full h-full object-cover group-hover:scale-105 transition duration-500 ${c.locked ? 'blur-md scale-110' : ''}`}
                        />
                      ) : (
                        <img
                          src={c.img}
                          alt={c.name}
                          className={`w-full h-full object-cover group-hover:scale-105 transition duration-500 ${c.locked ? 'blur-md scale-110' : ''}`}
                        />
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/20 to-transparent"></div>

                      {c.trending && (
                        <div className="absolute top-3 left-3 px-3 py-1 rounded-full bg-brand-gold/90 text-black text-xs font-black flex items-center gap-1">
                          <img src="/icons/fire.png" className="h-3 w-3" alt="" /> TRENDING
                        </div>
                      )}

                      <div className="absolute top-3 right-3 px-3 py-1 rounded-full bg-black/70 backdrop-blur text-brand-gold text-xs font-bold">
                        {c.price}
                      </div>

                      {c.locked && (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="bg-black/60 backdrop-blur-sm rounded-full p-5 border border-brand-gold/40">
                            <img src="/icons/lock.png" className="h-8 w-8" alt="" />
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="p-4 text-center">
                      <p className="font-black text-lg text-white">{c.name}</p>
                      <p className="text-brand-secondary text-sm font-medium mb-1">{c.handle}</p>
                      <p className="text-gray-400 text-xs mb-4">{c.subs} subscribers</p>
                      <div className="flex gap-2">
                        <button className="flex-1 premium-button text-sm py-2">
                          {c.locked ? 'Unlock Now' : 'View'}
                        </button>
                        <button className="px-4 py-2 border border-brand-gold/40 rounded-md text-brand-gold text-sm hover:bg-brand-gold/10 transition">
                          Preview
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Subscription Tiers */}
        <section id="pricing" className="py-16 px-6 border-t border-brand-gold/20">
          <div className="max-w-5xl mx-auto">
            <h2 className="text-4xl font-black text-center mb-2 premium-title">CHOOSE YOUR TIER</h2>
            <p className="text-center text-gray-400 mb-12">Simple, transparent pricing</p>
            <div className="grid md:grid-cols-3 gap-6">
              <div className="premium-card p-8 border-2 border-brand-gold/30 text-center">
                <p className="text-brand-secondary font-bold text-sm tracking-widest mb-3">STARTER</p>
                <p className="text-4xl font-black text-brand-gold mb-1">1M</p>
                <p className="text-gray-400 text-sm mb-6">$ASSEAT / month</p>
                <ul className="text-sm text-gray-300 space-y-2 mb-8 text-left">
                  <li className="flex items-center gap-2"><img src="/icons/check.png" className="h-4 w-4" alt="" /> Access to 3 creators</li>
                  <li className="flex items-center gap-2"><img src="/icons/check.png" className="h-4 w-4" alt="" /> Weekly content drops</li>
                </ul>
                <button className="w-full premium-button text-sm">Select</button>
              </div>
              <div className="premium-card p-8 border-2 border-brand-gold text-center relative scale-105 shadow-luxury-lg">
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-brand-gold text-black text-xs font-black rounded-full">MOST POPULAR</div>
                <p className="text-brand-secondary font-bold text-sm tracking-widest mb-3">ALL ACCESS</p>
                <p className="text-4xl font-black text-brand-gold mb-1">3M</p>
                <p className="text-gray-400 text-sm mb-6">$ASSEAT / month</p>
                <ul className="text-sm text-gray-300 space-y-2 mb-8 text-left">
                  <li className="flex items-center gap-2"><img src="/icons/check.png" className="h-4 w-4" alt="" /> All creators unlocked</li>
                  <li className="flex items-center gap-2"><img src="/icons/check.png" className="h-4 w-4" alt="" /> Daily content drops</li>
                  <li className="flex items-center gap-2"><img src="/icons/check.png" className="h-4 w-4" alt="" /> AI character chat access</li>
                </ul>
                <button className="w-full premium-button text-sm">Select</button>
              </div>
              <div className="premium-card p-8 border-2 border-brand-gold/30 text-center">
                <p className="text-brand-secondary font-bold text-sm tracking-widest mb-3">VIP</p>
                <p className="text-4xl font-black text-brand-gold mb-1">8M</p>
                <p className="text-gray-400 text-sm mb-6">$ASSEAT / month</p>
                <ul className="text-sm text-gray-300 space-y-2 mb-8 text-left">
                  <li className="flex items-center gap-2"><img src="/icons/check.png" className="h-4 w-4" alt="" /> Everything in All Access</li>
                  <li className="flex items-center gap-2"><img src="/icons/check.png" className="h-4 w-4" alt="" /> Priority requests</li>
                  <li className="flex items-center gap-2"><img src="/icons/check.png" className="h-4 w-4" alt="" /> Early mascot NFT access</li>
                </ul>
                <button className="w-full premium-button text-sm">Select</button>
              </div>
            </div>
          </div>
        </section>

        {/* Creator Dashboard Preview */}
        <section id="dashboard" className="py-16 px-6 border-t border-brand-gold/20">
          <div className="max-w-5xl mx-auto">
            <h2 className="text-4xl font-black text-center mb-2 premium-title">CREATOR DASHBOARD</h2>
            <p className="text-center text-gray-400 mb-12">Become a creator and track your earnings in real time</p>

            <div className="premium-card border-2 border-brand-gold/30 p-6 grid md:grid-cols-[200px_1fr] gap-6">
              {/* Sidebar */}
              <div className="bg-black/30 rounded-lg p-3 flex md:flex-col gap-2 overflow-x-auto">
                {['Overview', 'Content', 'Subscribers', 'Payouts'].map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setDashTab(tab)}
                    className={`px-4 py-2 rounded-md text-sm text-left whitespace-nowrap transition ${
                      dashTab === tab
                        ? 'bg-gradient-to-r from-brand-gold to-brand-secondary text-black font-bold'
                        : 'text-gray-400 hover:text-white'
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>

              {/* Panel */}
              <div className="bg-black/20 rounded-lg p-6">
                <div className="flex flex-wrap gap-4 mb-6">
                  <div className="bg-black/30 rounded-lg px-6 py-4 flex-1 min-w-[140px]">
                    <p className="text-2xl font-black text-brand-gold">4.2M</p>
                    <p className="text-xs text-gray-400">Earnings (30d)</p>
                  </div>
                  <div className="bg-black/30 rounded-lg px-6 py-4 flex-1 min-w-[140px]">
                    <p className="text-2xl font-black text-brand-gold">312</p>
                    <p className="text-xs text-gray-400">Subscribers</p>
                  </div>
                  <div className="bg-black/30 rounded-lg px-6 py-4 flex-1 min-w-[140px]">
                    <p className="text-2xl font-black text-brand-gold">18</p>
                    <p className="text-xs text-gray-400">New This Week</p>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-gray-400 border-b border-brand-gold/20">
                        <th className="text-left py-2">Subscriber</th>
                        <th className="text-left py-2">Plan</th>
                        <th className="text-left py-2">Amount</th>
                        <th className="text-left py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {subscribers.map((s, i) => (
                        <tr key={i} className="border-b border-brand-gold/10">
                          <td className="py-3 text-white">{s.name}</td>
                          <td className="py-3 text-gray-300">{s.plan}</td>
                          <td className="py-3 text-brand-gold font-bold">{s.amount}</td>
                          <td className={`py-3 font-bold ${s.status === 'Active' ? 'text-green-400' : 'text-yellow-400'}`}>
                            {s.status}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
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
          <p>Only Ass — an independent platform. Not affiliated with any other service. 18+ only, all creators verify identity & age.</p>
        </footer>
      </div>
    </>
  );
}
