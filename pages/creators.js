import { useState, useMemo, useEffect } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { getCreators } from '../lib/creators-store';
import { toPublicCreator, isPubliclyVisible } from '../lib/creator-status';
import { byPlacement } from '../lib/founding';
import { isTokenGated, formatGate, tokenGateLive } from '../lib/token-gate';
import { getSessionUser } from '../lib/session';
import { Lockup } from '../components/Brand';
import { publicUser } from '../lib/users-store';
import { VIP_PRICE_USD, VIP_PERKS } from '../lib/brand';

export async function getServerSideProps({ req }) {
  const creators = await getCreators();
  const sessionUser = publicUser(await getSessionUser(req));
  return {
    props: {
      // "Priority placement in Explore" -- Founding Creators lead every
      // listing on this page. See lib/founding.js.
      creators: creators.filter(isPubliclyVisible).sort(byPlacement).map(toPublicCreator),
      sessionUser,
    },
  };
}

export default function Creators({ creators, sessionUser }) {
  const router = useRouter();
  const [activeFilter, setActiveFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [showSplash, setShowSplash] = useState(true);
  const [splashFading, setShowSplashFading] = useState(false);
  const [toast, setToast] = useState(null);

  const showComingSoon = (msg) => {
    setToast(msg || 'Not live yet — wallet features open when $ONLYONE launches.');
    setTimeout(() => setToast(null), 3000);
  };

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

  // Real content count across the roster, for the stats bar.
  const totalPosts = creators.reduce(
    (n, c) => n + (Array.isArray(c.gallery) ? c.gallery.length : 0),
    0,
  );

  return (
    <>
      <Head>
        <title>OnlyOne - Exclusive Creator Content</title>
        <meta name="description" content="Token-gated exclusive content platform" />
      </Head>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] px-6 py-3 rounded-full bg-brand-gold text-black font-bold shadow-luxury-lg animate-pulse">
          {toast}
        </div>
      )}

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
            <h1 className="text-6xl md:text-8xl font-black mb-4 premium-title">ONLY<span className="text-brand-pink">ONE</span></h1>
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
            <a href="/" className="flex items-center">
              <Lockup className="h-7 md:h-8" />
            </a>
            <div className="hidden md:flex items-center gap-8 text-sm font-medium text-gray-300">
              <a href="#creators" className="hover:text-brand-gold transition">Creators</a>
              <a href="#pricing" className="hover:text-brand-gold transition">Pricing</a>
              <a href="#dashboard" className="hover:text-brand-gold transition">Dashboard</a>
              <a href="/token" className="hover:text-brand-gold transition">Roadmap</a>
              <a href="/marketplace" className="hover:text-brand-gold transition">Marketplace</a>
              <a href="/search" className="hover:text-brand-gold transition">Search</a>
              <a href="/favorites" className="hover:text-brand-gold transition">Favorites</a>
            </div>
            <div className="flex items-center gap-3">
              <a href="/" className="text-sm text-gray-400 hover:text-brand-gold transition hidden sm:block">Home</a>
              {sessionUser ? (
                <a href="/dashboard" className="text-sm text-gray-300 hover:text-brand-gold transition hidden sm:block">
                  {sessionUser.role === 'creator' ? 'Creator Dashboard' : 'My Account'}
                </a>
              ) : (
                <>
                  <a href="/login" className="text-sm text-gray-400 hover:text-brand-gold transition hidden sm:block">Log In</a>
                  <a href="/signup" className="text-sm text-gray-300 hover:text-brand-gold transition hidden sm:block">Sign Up</a>
                </>
              )}
              <button onClick={() => showComingSoon()} className="premium-button text-sm px-6 py-2">Connect Wallet</button>
            </div>
          </div>
        </nav>

        {/* Hero Banner */}
        <section className="relative py-20 px-6 border-b border-brand-gold/20 overflow-hidden">
          <div className="absolute top-1/2 left-1/3 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[700px] bg-brand-purple/15 rounded-full blur-3xl"></div>
          <div className="absolute top-1/2 left-2/3 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-brand-gold/10 rounded-full blur-3xl"></div>
          <div className="max-w-7xl mx-auto text-center relative z-10">
            <div className="inline-block px-4 py-1 rounded-full bg-brand-gold/20 text-brand-gold text-xs font-bold tracking-widest mb-6">
              18+ EXCLUSIVE PLATFORM
            </div>
            <h1 className="text-7xl md:text-8xl font-black mb-3 premium-title">ONLY<span className="text-brand-pink">ONE</span></h1>
            <p className="text-brand-secondary font-bold text-xl mb-3">Support the creators you actually love.</p>
            <p className="text-gray-400 max-w-xl mx-auto mb-10">
              Subscribe, tip and unlock with credits — one credit, one dollar, no guesswork. No ads, no algorithm, just the creators you actually came for.
            </p>

            {/* Stats Bar */}
            {/* Counted from the real roster. These used to be invented
                numbers -- "12.4K Members", "340+ Exclusive Drops", and a
                creator count of 6 against a roster of 2. */}
            <div className="flex flex-wrap justify-center gap-6 md:gap-12 mb-12">
              <div className="text-center">
                <p className="text-3xl font-black text-brand-gold">{creators.length}</p>
                <p className="text-xs text-gray-400 uppercase tracking-wide">Creators</p>
              </div>
              <div className="text-center">
                <p className="text-3xl font-black text-brand-gold">{totalPosts}</p>
                <p className="text-xs text-gray-400 uppercase tracking-wide">Pieces of Content</p>
              </div>
              <div className="text-center">
                <p className="text-3xl font-black text-brand-gold">10%</p>
                <p className="text-xs text-gray-400 uppercase tracking-wide">Platform Fee</p>
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
                  <div
                    key={c.id}
                    onClick={() => router.push(`/creator/${c.id}`)}
                    className="premium-card overflow-visible border-2 border-brand-gold/30 hover:border-brand-gold/60 transition group cursor-pointer pt-10"
                  >
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
                          className={`w-full h-full object-cover group-hover:scale-105 transition duration-500 ${isTokenGated(c) ? 'blur-md scale-110' : ''}`}
                        />
                      ) : (
                        <img
                          src={c.img}
                          alt={c.name}
                          className={`w-full h-full object-cover group-hover:scale-105 transition duration-500 ${isTokenGated(c) ? 'blur-md scale-110' : ''}`}
                        />
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/20 to-transparent"></div>

                      {c.founding ? (
                        <div className="absolute top-3 left-3 px-3 py-1 rounded-full bg-brand-pink text-white text-xs font-black">
                          FOUNDING
                        </div>
                      ) : c.trending ? (
                        <div className="absolute top-3 left-3 px-3 py-1 rounded-full bg-brand-gold/90 text-black text-xs font-black flex items-center gap-1">
                          <img src="/icons/fire.png" className="h-3 w-3" alt="" /> TRENDING
                        </div>
                      ) : null}

                      <div className="absolute top-3 right-3 px-3 py-1 rounded-full bg-black/70 backdrop-blur text-brand-gold text-xs font-bold">
                        {c.price}
                      </div>

                      {isTokenGated(c) && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                          <div className="bg-black/60 backdrop-blur-sm rounded-full p-5 border border-brand-gold/40">
                            <img src="/icons/lock.png" className="h-8 w-8" alt="" />
                          </div>
                          <p className="text-[11px] text-brand-gold font-bold bg-black/70 px-2 py-0.5 rounded-full">
                            {formatGate(c)}
                          </p>
                        </div>
                      )}
                    </div>

                    <div className="p-4 text-center">
                      <p className="font-black text-lg text-white flex items-center justify-center gap-1">
                        {c.name}
                        {c.premium && <img src="/icons/check.png" alt="Premium" className="h-4 w-4" title="Premium" />}
                      </p>
                      <p className="text-brand-secondary text-sm font-medium mb-1">{c.handle}</p>
                      <p className="text-gray-400 text-xs mb-4">{c.subs} subscribers</p>
                      <div className="flex gap-2">
                        {/* A gated creator gets an honest label, not a button
                            that can't do its job yet. Holding the tokens is how
                            you get in -- nothing is spent, so there is nothing
                            to "buy" here even once it's live. */}
                        {isTokenGated(c) && !tokenGateLive() ? (
                          <span className="flex-1 text-sm py-2 px-3 rounded-md border border-brand-gold/30 text-brand-gold/80 text-center">
                            Unlocks at launch
                          </span>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); router.push(`/creator/${c.id}`); }}
                            className="flex-1 premium-button text-sm py-2"
                          >
                            {isTokenGated(c) ? 'Hold to Unlock' : 'View'}
                          </button>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); router.push(`/creator/${c.id}`); }}
                          className="px-4 py-2 border border-brand-gold/40 rounded-md text-brand-gold text-sm hover:bg-brand-gold/10 transition"
                        >
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

        {/* What it costs a fan.

            This replaced three invented subscription tiers -- STARTER $9.99
            "Access to 3 creators", ALL ACCESS $19.99 "All creators
            unlocked", VIP $49.99 -- which were not just unbuilt but
            unbuildable. Creators set their own subscription prices, so a
            flat platform-priced "all creators unlocked" is the platform
            promising content it does not own at a price it does not
            control: fifty creators averaging $15 would owe $750 out of one
            $19.99 charge. It is the same shape as every other
            fixed-price-against-a-price-you-do-not-set idea this project has
            rejected, and it gets worse the more creators sign up.

            What is below is what is actually decided and built in server/:
            free to join, creators price their own work, credits are dollars,
            and VIP is perks only at a flat $20 with no content and no
            discount attached to it. */}
        <section id="pricing" className="py-16 px-6 border-t border-white/10">
          <div className="max-w-5xl mx-auto">
            <h2 className="text-4xl font-black text-center mb-2 premium-title">WHAT IT COSTS</h2>
            <p className="text-center text-gray-400 mb-12">
              Joining is free. Creators set their own prices — we never set them for them.
            </p>

            <div className="grid md:grid-cols-3 gap-6 items-start">
              <div className="premium-card p-8">
                <p className="text-brand-pink font-bold text-sm tracking-widest mb-3">JOIN</p>
                <p className="text-4xl font-black mb-1">Free</p>
                <p className="text-gray-400 text-sm mb-6">always</p>
                <ul className="text-sm text-gray-300 space-y-3">
                  <li>Browse and search every creator</li>
                  <li>Save the ones you like</li>
                  <li>No card to sign up, no monthly fee to exist here</li>
                </ul>
              </div>

              <div className="premium-card p-8">
                <p className="text-brand-pink font-bold text-sm tracking-widest mb-3">CREDITS</p>
                <p className="text-4xl font-black mb-1">$1</p>
                <p className="text-gray-400 text-sm mb-6">= 1 credit</p>
                <ul className="text-sm text-gray-300 space-y-3">
                  <li>Top up once, spend it on whatever you want</li>
                  <li>Subscriptions, tips, unlocks, marketplace</li>
                  <li>Each creator sets their own price — some are free</li>
                  <li className="text-gray-400">Topping up costs 2%: $100 lands as 98 credits</li>
                </ul>
              </div>

              <div className="premium-card p-8 border border-brand-pink/40">
                <p className="text-brand-pink font-bold text-sm tracking-widest mb-3">VIP</p>
                <p className="text-4xl font-black mb-1">${VIP_PRICE_USD}</p>
                <p className="text-gray-400 text-sm mb-6">per month, optional</p>
                <ul className="text-sm text-gray-300 space-y-3">
                  {VIP_PERKS.map((perk) => (
                    <li key={perk}>{perk}</li>
                  ))}
                </ul>
                {/* Said plainly and on purpose. A "VIP" tier that sounds like
                    it includes content is how a chargeback starts. */}
                <p className="text-xs text-gray-500 mt-6 leading-relaxed">
                  VIP does not include any creator&apos;s content and does not discount
                  anything. You still pay each creator their own price.
                </p>
              </div>
            </div>

            <p className="text-center text-sm text-gray-500 mt-10">
              Payments are not switched on yet — nothing here can charge you today.
            </p>
          </div>
        </section>

        {/* What a creator actually gets. This used to be a fabricated
            "Creator Dashboard" showing 4.2M earnings, 312 subscribers and an
            invented subscriber table, under the words "track your earnings in
            real time" -- numbers no account on this platform has ever had. */}
        <section id="dashboard" className="py-16 px-6 border-t border-brand-gold/20">
          <div className="max-w-4xl mx-auto">
            <h2 className="text-4xl font-black text-center mb-2 premium-title">CREATE ON ONLYONE</h2>
            <p className="text-center text-gray-400 mb-10">
              Your page, your prices, your content. We take 10% — nothing else.
            </p>

            <div className="grid sm:grid-cols-3 gap-4 mb-10">
              <div className="premium-card p-6">
                <p className="font-bold mb-2">Your own page</p>
                <p className="text-gray-400 text-sm">
                  Photos, video, a bio, tags and links. Fans find you through search and browse by tag.
                </p>
              </div>
              <div className="premium-card p-6">
                <p className="font-bold mb-2">Sell in the marketplace</p>
                <p className="text-gray-400 text-sm">
                  List digital or physical items at any price. Your listings also show on your own page.
                </p>
              </div>
              <div className="premium-card p-6">
                <p className="font-bold mb-2">Talk to your fans</p>
                <p className="text-gray-400 text-sm">
                  Direct messages and a public wall on your page, both live today.
                </p>
              </div>
            </div>

            <div className="premium-card p-6 mb-8">
              <p className="font-bold mb-2">Not live yet, and worth saying plainly</p>
              <p className="text-gray-400 text-sm">
                Payments are not switched on. Subscriptions, tips and marketplace checkout are built
                but not taking money yet, so there are no earnings to show you. Set your page up now
                and it is ready the day they open.
              </p>
            </div>

            <div className="text-center">
              <a href="/become-creator" className="inline-block premium-button text-sm">Apply to Become a Creator</a>
            </div>
          </div>
        </section>

        {/* Bottom CTA */}
        <section className="py-16 px-6 border-t border-brand-gold/20">
          <div className="max-w-2xl mx-auto text-center premium-card p-10 border-2 border-brand-gold/40">
            <h2 className="text-3xl font-black text-brand-gold mb-3">Become a Subscriber</h2>
            <p className="text-gray-300 mb-6">Top up with dollars and spend credits on the creators you want. No token required.</p>
            <button onClick={() => showComingSoon()} className="premium-button">Buy Credits</button>
          </div>
        </section>

        <footer className="border-t border-brand-gold/20 py-8 px-6 text-center text-gray-500 text-sm">
          <div className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs mb-4">
            <a href="/terms" className="hover:text-brand-gold transition">Terms of Service</a>
            <a href="/privacy" className="hover:text-brand-gold transition">Privacy Policy</a>
            <a href="/report-content" className="text-red-400 hover:text-red-300 transition font-semibold">Report Non-Consensual Content</a>
          </div>
          <p>OnlyOne — an independent platform. Not affiliated with any other service. 18+ only; every creator profile is reviewed before it goes live.</p>
        </footer>
      </div>
    </>
  );
}
