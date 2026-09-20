import { useState, useMemo, useEffect } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { getCreators } from '../lib/creators-store';
import { toPublicCreator, isPubliclyVisible } from '../lib/creator-status';
import { byPlacement } from '../lib/founding';
import { isTokenGated, formatGate, tokenGateLive } from '../lib/token-gate';
import { getSessionUser } from '../lib/session';
import { Icons, Lockup, SolidIcons } from '../components/Brand';
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

/**
 * The three ways money does or does not change hands here, as data rather
 * than three near-identical blocks of JSX -- the old version was copy-pasted
 * three times and had already drifted (different border treatments, one card
 * scaled and the others not).
 *
 * `featured` is VIP because it is the only one that is a product we sell.
 * Joining is free and credits are just dollars in a different coat.
 */
const PRICING_TIERS = [
  {
    name: 'JOIN',
    Icon: Icons.people,
    price: 'Free',
    unit: 'always',
    lines: [
      'Browse and search every creator',
      'Save the ones you like',
      'No card to sign up, no monthly fee to exist here',
    ],
  },
  {
    name: 'CREDITS',
    Icon: Icons.coin,
    price: '$1',
    unit: '= 1 credit',
    lines: [
      'Top up once, spend it on whatever you want',
      'Subscriptions, tips, unlocks, marketplace',
      'Each creator sets their own price — some are free',
    ],
    footnote: 'Topping up costs 2%: $100 lands as 98 credits.',
  },
  {
    name: 'VIP',
    Icon: Icons.crown,
    price: `$${VIP_PRICE_USD}`,
    unit: 'per month, optional',
    featured: true,
    lines: VIP_PERKS,
    // Said outright, on the card, not buried in terms. A tier called VIP
    // that merely sounds like it includes content is how a chargeback starts.
    footnote:
      'VIP includes no creator’s content and discounts nothing. You still pay each creator their own price.',
  },
];

function PricingCard({ tier }) {
  const { Icon, featured } = tier;
  return (
    // Gradient hairline border: a 1px gradient-filled wrapper with the card
    // painted back on top. A plain border-colour cannot fade along its own
    // length, and a fading edge is most of what reads as "premium" here.
    <div
      className={`rounded-2xl p-px h-full ${
        featured
          ? 'bg-gradient-to-b from-brand-pink via-brand-pink/30 to-transparent shadow-[0_0_60px_-15px_rgba(255,45,120,0.45)]'
          : 'bg-gradient-to-b from-white/15 to-transparent'
      }`}
    >
      <div className="relative h-full rounded-2xl bg-brand-ink/90 backdrop-blur p-8 flex flex-col">
        {featured ? (
          <span className="absolute -top-px left-1/2 -translate-x-1/2 h-px w-2/3 bg-gradient-to-r from-transparent via-brand-pink to-transparent" />
        ) : null}

        <span
          className={`inline-flex items-center justify-center h-11 w-11 rounded-xl mb-6 ${
            featured ? 'bg-brand-pink/15 text-brand-pink' : 'bg-white/5 text-gray-300'
          }`}
        >
          <Icon className="h-5 w-5" />
        </span>

        <p className="text-[11px] font-bold tracking-[0.25em] text-gray-400 mb-3">{tier.name}</p>

        <p
          className={`text-5xl font-black tracking-tight leading-none ${
            featured
              ? 'bg-gradient-to-br from-white to-brand-pink-light bg-clip-text text-transparent'
              : 'text-white'
          }`}
        >
          {tier.price}
        </p>
        <p className="text-sm text-gray-500 mt-2 mb-7">{tier.unit}</p>

        <ul className="space-y-3.5 text-sm text-gray-300">
          {tier.lines.map((line) => (
            <li key={line} className="flex gap-3">
              <Icons.check
                className={`h-4 w-4 mt-0.5 shrink-0 ${featured ? 'text-brand-pink' : 'text-gray-500'}`}
              />
              <span className="leading-relaxed">{line}</span>
            </li>
          ))}
        </ul>

        {tier.footnote ? (
          <p className="text-xs text-gray-500 leading-relaxed mt-auto pt-7">{tier.footnote}</p>
        ) : null}
      </div>
    </div>
  );
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
                          <SolidIcons.fire className="h-3 w-3" /> TRENDING
                        </div>
                      ) : null}

                      <div className="absolute top-3 right-3 px-3 py-1 rounded-full bg-black/70 backdrop-blur text-brand-gold text-xs font-bold">
                        {c.price}
                      </div>

                      {isTokenGated(c) && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                          <div className="bg-black/60 backdrop-blur-sm rounded-full p-5 border border-brand-gold/40">
                            <SolidIcons.lock className="h-8 w-8 text-white/80" />
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
                        {c.premium && <SolidIcons.verified className="h-4 w-4 text-brand-pink" title="Premium" />}
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
            selling content it does not own at a price it does not control:
            fifty creators averaging $15 would owe $750 out of one $19.99
            charge, and it gets worse with every signup. Same shape as every
            other fixed-price-against-a-price-you-do-not-set idea this
            project has already rejected.

            What is below is what is actually decided and built in server/:
            free to join, creators price their own work, credits are dollars,
            and VIP is perks only at a flat $20 with no content and no
            discount attached. */}
        <section id="pricing" className="relative scroll-mt-36 py-24 px-6 border-t border-white/10 overflow-hidden">
          {/* Light falling from above the cards rather than a flat panel --
              the cheapest way to give a dark section depth without art. */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            <div className="absolute left-1/2 -top-24 -translate-x-1/2 w-[900px] h-[520px] max-w-[150vw] rounded-full bg-brand-pink/10 blur-[130px]" />
          </div>

          <div className="relative max-w-6xl mx-auto">
            <p className="text-center text-[11px] font-bold tracking-[0.3em] text-brand-pink/80 mb-4">
              WHAT IT COSTS
            </p>
            <h2 className="text-4xl md:text-5xl font-black text-center tracking-tight mb-4">
              Free to join.<br className="sm:hidden" />{' '}
              <span className="bg-gradient-to-r from-brand-pink to-brand-pink-light bg-clip-text text-transparent">
                Pay only for what you want.
              </span>
            </h2>
            <p className="text-center text-gray-400 max-w-xl mx-auto mb-16">
              Creators set their own prices — we never set them for them, and we never
              resell their work in a bundle.
            </p>

            <div className="grid md:grid-cols-3 gap-6 items-stretch">
              {PRICING_TIERS.map((tier) => (
                <PricingCard key={tier.name} tier={tier} />
              ))}
            </div>

            <p className="text-center text-sm text-gray-500 mt-14">
              Payments are not switched on yet — nothing here can charge you today.
            </p>
          </div>
        </section>

        {/* What a creator actually gets. This used to be a fabricated
            "Creator Dashboard" showing 4.2M earnings, 312 subscribers and an
            invented subscriber table, under the words "track your earnings in
            real time" -- numbers no account on this platform has ever had. */}
        <section id="dashboard" className="scroll-mt-36 py-16 px-6 border-t border-brand-gold/20">
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
