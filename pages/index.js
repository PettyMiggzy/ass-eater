import { useEffect, useState } from 'react';
import Head from 'next/head';

export default function Home() {
  const [time, setTime] = useState({ days: 4, hours: 0, minutes: 0, seconds: 0 });
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const t = setInterval(() => {
      setTime((p) => {
        let { days, hours, minutes, seconds } = p;
        if (seconds > 0) seconds--;
        else if (minutes > 0) { minutes--; seconds = 59; }
        else if (hours > 0) { hours--; minutes = 59; seconds = 59; }
        else if (days > 0) { days--; hours = 23; minutes = 59; seconds = 59; }
        return { days, hours, minutes, seconds };
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const featured = [
    '/images/content_sunset_4.jpg',
    '/images/content_street_5.jpg',
    '/images/content_pool_4.jpg',
    '/images/content_gym_4.jpg',
    '/images/content_night_4.jpg',
    '/images/content_lingerie_1.jpg',
  ];

  return (
    <>
      <Head>
        <title>Only Ass - Premium Adult Token</title>
        <meta name="description" content="Only Ass - a premium adult crypto token and creator platform" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="min-h-screen bg-gradient-luxury text-white overflow-x-hidden">
        {/* Nav */}
        <nav className={`fixed w-full top-0 z-50 transition-all ${scrolled ? 'bg-black/90 backdrop-blur-xl border-b border-brand-purple/20' : 'bg-transparent'}`}>
          <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
            <img src="/images/logo-final.png" alt="Only Ass" className="h-12 w-auto" />
            <div className="hidden md:flex items-center gap-7 text-sm text-gray-300">
              <a href="#about" className="hover:text-brand-gold transition">About</a>
              <a href="#gallery" className="hover:text-brand-gold transition">Gallery</a>
              <a href="#roadmap" className="hover:text-brand-gold transition">Roadmap</a>
              <a href="/onlyass" className="px-4 py-1.5 rounded-full bg-gradient-to-r from-brand-gold to-brand-purple text-black font-bold hover:scale-105 transition">
                Enter Platform
              </a>
            </div>
          </div>
        </nav>

        {/* Hero - split layout */}
        <section className="pt-32 pb-20 px-6 relative">
          <div className="absolute top-20 left-0 w-[500px] h-[500px] bg-brand-purple/15 rounded-full blur-3xl"></div>
          <div className="absolute top-40 right-0 w-[400px] h-[400px] bg-brand-gold/10 rounded-full blur-3xl"></div>

          <div className="max-w-6xl mx-auto grid md:grid-cols-2 gap-12 items-center relative z-10">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-brand-purple/20 border border-brand-purple/30 text-brand-purple text-xs font-bold tracking-wide mb-6">
                <span className="w-2 h-2 rounded-full bg-brand-purple animate-pulse"></span>
                18+ ADULT TOKEN — LAUNCHING SOON
              </div>
              <h1 className="text-6xl md:text-7xl font-black leading-[0.95] mb-6 premium-title">
                ONLY ASS
              </h1>
              <p className="text-lg text-gray-300 mb-8 max-w-md">
                A degen-run token with a real platform behind it. Hold $ASSEAT, unlock exclusive creator content, and get in before launch.
              </p>

              <div className="flex flex-wrap gap-4 mb-10">
                <a
                  href={process.env.NEXT_PUBLIC_LAUNCHPAD_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="premium-button"
                >
                  Join Auction
                </a>
                <a href="/onlyass" className="px-8 py-3 rounded-md border-2 border-brand-purple/50 text-brand-purple font-bold hover:bg-brand-purple/10 transition">
                  Explore Platform
                </a>
              </div>

              <div className="grid grid-cols-4 gap-3 max-w-sm">
                {[['Days', time.days], ['Hrs', time.hours], ['Min', time.minutes], ['Sec', time.seconds]].map(([label, val]) => (
                  <div key={label} className="text-center bg-black/40 border border-brand-purple/20 rounded-lg py-3">
                    <div className="text-2xl font-black text-brand-gold">{String(val).padStart(2, '0')}</div>
                    <div className="text-[10px] uppercase text-gray-500 tracking-wide">{label}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="relative">
              <div className="absolute inset-0 bg-gradient-to-tr from-brand-purple/20 to-brand-gold/20 rounded-3xl blur-2xl"></div>
              <img src="/images/logo-final.png" alt="Only Ass" className="relative w-full max-w-sm mx-auto drop-shadow-2xl" />
            </div>
          </div>
        </section>

        {/* Featured content strip */}
        <section id="gallery" className="py-16 px-6 border-t border-brand-purple/10">
          <div className="max-w-6xl mx-auto">
            <div className="flex items-end justify-between mb-8">
              <div>
                <p className="eyebrow text-brand-purple text-xs mb-2">The Culture</p>
                <h2 className="text-3xl md:text-4xl font-black premium-title">Featured Content</h2>
              </div>
              <a href="/onlyass" className="text-sm text-brand-gold hover:underline hidden sm:block">See all creators →</a>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {featured.map((src, i) => (
                <div key={i} className="aspect-[4/5] rounded-xl overflow-hidden border border-brand-purple/20 hover:border-brand-gold/50 transition group">
                  <img src={src} alt="" className="w-full h-full object-cover group-hover:scale-105 transition duration-500" />
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* About / token info */}
        <section id="about" className="py-16 px-6 border-t border-brand-purple/10">
          <div className="max-w-6xl mx-auto grid md:grid-cols-3 gap-6">
            <div className="premium-card p-8">
              <img src="/icons/rocket.png" className="h-10 w-10 mb-4" alt="" />
              <h3 className="text-xl font-black text-brand-gold mb-2">Live Auction</h3>
              <p className="text-gray-400 text-sm">4-day fair launch on KekFun. No presale, no VC allocation.</p>
            </div>
            <div className="premium-card p-8">
              <img src="/icons/lock.png" className="h-10 w-10 mb-4" alt="" />
              <h3 className="text-xl font-black text-brand-gold mb-2">Real Platform</h3>
              <p className="text-gray-400 text-sm">Only Ass isn't just a coin — it's a token-gated creator platform, live at launch.</p>
            </div>
            <div className="premium-card p-8">
              <img src="/icons/crown.png" className="h-10 w-10 mb-4" alt="" />
              <h3 className="text-xl font-black text-brand-gold mb-2">Holder Perks</h3>
              <p className="text-gray-400 text-sm">Hold $ASSEAT for exclusive content, chat access, and creator drops.</p>
            </div>
          </div>

          <div className="max-w-6xl mx-auto mt-6 premium-card p-8">
            <div className="grid md:grid-cols-2 gap-6 text-sm">
              <div className="flex justify-between border-b border-brand-purple/10 pb-3">
                <span className="text-gray-400">Contract</span>
                <span className="text-brand-gold font-mono">{process.env.NEXT_PUBLIC_CONTRACT_ADDRESS}</span>
              </div>
              <div className="flex justify-between border-b border-brand-purple/10 pb-3">
                <span className="text-gray-400">Network</span>
                <span className="text-brand-gold font-bold">Ethereum</span>
              </div>
            </div>
          </div>
        </section>

        {/* Roadmap */}
        <section id="roadmap" className="py-16 px-6 border-t border-brand-purple/10">
          <div className="max-w-4xl mx-auto">
            <p className="eyebrow text-brand-purple text-xs mb-2 text-center">What's Next</p>
            <h2 className="text-3xl md:text-4xl font-black premium-title text-center mb-12">Roadmap</h2>
            <div className="space-y-4">
              {[
                { phase: 'Genesis', status: 'LIVE', desc: '4-day auction, community building, brand launch' },
                { phase: 'Platform', status: 'IN 4 DAYS', desc: 'Only Ass creator platform goes live for holders' },
                { phase: 'Creators', status: 'NEXT', desc: 'Open creator onboarding with ID-verified real creators' },
                { phase: 'Launchpad', status: 'FUTURE', desc: 'Community-launched creator characters via bonding curve' },
              ].map((p, i) => (
                <div key={i} className="premium-card p-6 flex items-center justify-between gap-4">
                  <div>
                    <h3 className="font-black text-lg text-white">{p.phase}</h3>
                    <p className="text-gray-400 text-sm">{p.desc}</p>
                  </div>
                  <span className={`shrink-0 px-3 py-1 rounded-full text-xs font-black tracking-wide ${i === 0 ? 'bg-green-900/50 text-green-300' : 'bg-brand-purple/20 text-brand-purple'}`}>
                    {p.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Only Ass promo */}
        <section className="py-20 px-6 border-t border-brand-purple/10">
          <div className="max-w-4xl mx-auto text-center premium-card p-12">
            <img src="/icons/onlyass-coin-logo.png" alt="" className="h-32 mx-auto mb-6" />
            <h2 className="text-3xl md:text-4xl font-black premium-title mb-4">The Platform Is Already Built</h2>
            <p className="text-gray-300 mb-8 max-w-xl mx-auto">
              Browse creators, see the pricing tiers, and preview what unlocks when $ASSEAT holders get access.
            </p>
            <a href="/onlyass" className="premium-button inline-block">Explore Only Ass →</a>
          </div>
        </section>

        {/* Disclaimer + Footer */}
        <footer className="py-10 px-6 border-t border-brand-purple/10 text-center">
          <p className="text-gray-500 text-xs max-w-2xl mx-auto mb-4">
            18+ only. This site contains adult content. Cryptocurrency carries risk — this is a meme token for entertainment, not financial advice.
          </p>
          <p className="text-gray-600 text-xs">© 2026 Only Ass</p>
        </footer>
      </div>
    </>
  );
}
