import Head from 'next/head';
import SiteNav from '../components/SiteNav';
import { getSessionUser } from '../lib/session';
import { publicUser } from '../lib/users-store';
import { getCreators, toPublicCreator, isPubliclyVisible } from '../lib/creators-store';
import { byPlacement } from '../lib/founding';
import { tokenGateLive } from '../lib/token-gate';
import { Icons, SolidIcons, Tagline } from '../components/Brand';
import DemoBadge from '../components/public/DemoBadge';
// `gated` on a card comes from isTokenGated (flag AND threshold) -- `locked`
// on its own is not a gate, see lib/token-gate.js.
import { toCreatorCard } from '../components/public/cards';

export async function getServerSideProps({ req }) {
  const sessionUser = publicUser(await getSessionUser(req));
  const all = await getCreators();
  const creators = all
    .filter(isPubliclyVisible)
    .sort(byPlacement) // Founding Creators first -- see lib/founding.js
    .slice(0, 8)
    // Cards only: the strip needs a name and an avatar, never galleries.
    .map((c) => toCreatorCard(toPublicCreator(c)));
  return { props: { creators, sessionUser, gatingLive: tokenGateLive() } };
}

// Every fixed marketing photograph on this page (the hero, the For Creators /
// For Fans cards and the closing-CTA background) is an AI-generated persona,
// and each carries this label. The live "Creators on OnlyOne" strip is not
// covered by it: it shows whatever avatar each creator uploaded, and demo
// creators there are marked with DemoBadge instead. Terms §7 makes
// an AI label mandatory for creators, under a suspension ladder; the
// platform's own marketing art can't be the one exception, and it must never
// read as real people. Same chip style as the gallery's "AI" badge.
function AiArtLabel({ className = '' }) {
  return (
    <span className={`pointer-events-none text-[10px] px-1.5 py-0.5 rounded bg-black/70 text-brand-pink font-bold ${className}`}>
      AI-generated
    </span>
  );
}

const PROMISES = [
  { Icon: Icons.shield, title: 'Safe & Secure', sub: 'Your privacy matters' },
  { Icon: Icons.bolt, title: 'USDG Payouts', sub: 'Paid on request' },
  { Icon: Icons.people, title: 'Real Connections', sub: 'More than just content' },
  { Icon: Icons.coin, title: '$ONLYONE', sub: 'Our own token', href: '/token' },
];

// Things that are actually built and actually different, not marketing filler.
// Real category browsing and the Founding Creator programme are both live
// today. Token gating (hold $ONLYONE, prove it with a wallet signature) is
// live exactly when the token is configured -- computed, not typed, so this
// section can't drift into overclaiming or underclaiming.
const differentiators = (gatingLive) => [
  { Icon: Icons.tag, title: 'Real Category Browsing', sub: 'Search and browse by tag', live: true },
  { Icon: Icons.crown, title: 'Founding Creators', sub: 'First 100 get permanent priority placement', live: true },
  { Icon: Icons.heart, title: 'Favorites', sub: 'Save the creators you follow', live: true },
  { Icon: Icons.coin, title: 'Crypto-Native', sub: 'Holding $ONLYONE unlocks gated creators', live: gatingLive },
];

const CREATOR_POINTS = [
  'Easy to use tools',
  'Keep more of what you earn',
  'Build a loyal fanbase',
  'Your rules, your content',
];

const FAN_POINTS = [
  'Exclusive content',
  'Direct messaging',
  'Support your favorite creators',
  'A more personal experience',
];

// `live: false` marks something the platform does not actually do yet. The
// row still shows it, because it is the roadmap, but it says "Coming soon"
// rather than listing it beside features that genuinely work -- an earlier
// audit caught this exact class of thing (a footer claiming every creator
// was identity-verified when no such check existed), and a homepage that
// advertises a payment feature this site cannot yet take money for is the
// same mistake.
const FEATURES = [
  { Icon: Icons.camera, title: 'Photos & Videos', sub: 'Exclusive content', live: true },
  { Icon: Icons.message, title: 'Direct Messaging', sub: 'Real conversations', live: true },
  { Icon: Icons.heart, title: 'Subscriptions', sub: 'Support creators', live: false },
  { Icon: Icons.star, title: 'Tips', sub: 'Show appreciation', live: false },
  { Icon: Icons.lock, title: 'PPV Content', sub: 'Unlock exclusives', live: false },
];

export default function Home({ creators, sessionUser, gatingLive }) {
  const DIFFERENTIATORS = differentiators(!!gatingLive);
  return (
    <>
      <Head>
        <title>OnlyOne — Creators</title>
        <meta
          name="description"
          content="The next generation platform for creators and fans. Share, connect and be part of a community without limits."
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="min-h-screen bg-brand-ink text-white overflow-x-hidden">
        <SiteNav signedIn={!!sessionUser} viewerAvatar={sessionUser?.img || null} />

        {/* Hero */}
        <section className="relative">
          <div className="max-w-6xl mx-auto grid lg:grid-cols-2 items-stretch">
            <div className="px-6 py-14 lg:py-24 flex flex-col justify-center">
              <p className="text-[11px] tracking-[0.25em] text-gray-400 mb-5">CREATORS FIRST. FANS CLOSER.</p>
              <h1 className="text-4xl sm:text-5xl lg:text-6xl font-black leading-[0.95] tracking-tight mb-6">
                MORE THAN<br />CONTENT.<br />
                <span className="text-brand-pink">IT&apos;S PERSONAL.</span>
              </h1>
              <p className="text-gray-300 max-w-md mb-8">
                OnlyOne is the next generation platform for creators and fans. Share, connect
                and be part of a community without limits.
              </p>
              <div className="flex flex-wrap gap-3">
                <a
                  href="/signup"
                  className="px-7 py-3.5 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-bold transition inline-flex items-center gap-2"
                >
                  Join OnlyOne <Icons.arrowRight className="inline-block h-4 w-4 align-[-0.15em]" />
                </a>
                <a
                  href="/creators"
                  className="px-7 py-3.5 rounded-full border border-white/20 hover:border-white/50 font-bold transition"
                >
                  Explore Creators
                </a>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-12 max-w-lg">
                {PROMISES.map((p) => {
                  const Tag = p.href ? 'a' : 'div';
                  return (
                    <Tag key={p.title} {...(p.href ? { href: p.href, className: 'group' } : {})}>
                      <p.Icon className="h-6 w-6 mb-3 text-brand-pink" />
                      <p className={`font-bold text-sm ${p.href ? 'group-hover:text-brand-pink transition' : ''}`}>{p.title}</p>
                      <p className="text-[11px] text-gray-500">{p.sub}</p>
                    </Tag>
                  );
                })}
              </div>
            </div>

            <div className="relative min-h-[320px] lg:min-h-[560px]">
              <img
                src="/images/home-hero.jpg"
                alt=""
                className="absolute inset-0 w-full h-full object-cover object-top"
              />
              <div className="absolute inset-0 bg-gradient-to-r from-brand-ink via-brand-ink/40 to-transparent lg:from-brand-ink lg:via-transparent" />
              <div className="absolute inset-0 bg-gradient-to-t from-brand-ink via-transparent to-transparent" />
              <Tagline className="absolute bottom-10 right-8 text-right">You&apos;re Not Alone Here</Tagline>
              <AiArtLabel className="absolute top-3 right-3" />
            </div>
          </div>
        </section>

        {/* A Platform for Everyone */}
        <section className="py-16 px-6 border-t border-white/5">
          <div className="max-w-6xl mx-auto">
            <h2 className="text-3xl sm:text-4xl font-black text-center mb-3">
              A Platform for <span className="text-brand-pink">Everyone</span>
            </h2>
            <p className="text-center text-gray-400 text-sm max-w-2xl mx-auto mb-10">
              Whether you&apos;re here to create or to explore, OnlyOne gives you the freedom to be yourself.
            </p>

            <div className="grid md:grid-cols-2 gap-5">
              {[
                { title: 'For Creators', copy: 'Take control of your content, your income and your freedom.', points: CREATOR_POINTS, cta: 'Start Creating', href: '/signup?role=creator', img: '/images/demo_male_1.jpg', primary: true },
                { title: 'For Fans', copy: 'Discover creators, exclusive content and genuine connections.', points: FAN_POINTS, cta: 'Start Exploring', href: '/creators', img: '/images/demo_female_2.jpg', primary: false },
              ].map((card) => (
                <div key={card.title} className="relative rounded-2xl overflow-hidden border border-white/10 bg-brand-card">
                  <img src={card.img} alt="" className="absolute left-0 top-0 h-full w-40 object-cover opacity-70" />
                  <div className="absolute left-0 top-0 h-full w-40 bg-gradient-to-r from-transparent to-brand-card" />
                  <AiArtLabel className="absolute left-2 bottom-2" />
                  <div className="relative pl-44 pr-6 py-7">
                    <h3 className="text-xl font-black mb-2">{card.title}</h3>
                    <p className="text-sm text-gray-400 mb-4">{card.copy}</p>
                    <ul className="space-y-2 mb-6">
                      {card.points.map((pt) => (
                        <li key={pt} className="flex items-center gap-2 text-sm text-gray-300">
                          <Icons.check className="h-4 w-4 shrink-0 text-brand-pink" />
                          {pt}
                        </li>
                      ))}
                    </ul>
                    <a
                      href={card.href}
                      className={`inline-flex items-center gap-2 px-6 py-2.5 rounded-full font-bold text-sm transition ${
                        card.primary
                          ? 'bg-brand-pink hover:bg-brand-pink-dark'
                          : 'border border-white/20 hover:border-white/50'
                      }`}
                    >
                      {card.cta} <Icons.arrowRight className="inline-block h-4 w-4 align-[-0.15em]" />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Feature row */}
        <section className="py-14 px-6 border-t border-white/5">
          <div className="max-w-5xl mx-auto grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-6 text-center">
            {FEATURES.map((f) => (
              <div key={f.title}>
                <f.Icon className="h-7 w-7 mb-3 text-brand-pink" />
                <p className="font-bold text-sm">{f.title}</p>
                {f.live ? (
                  <p className="text-[11px] text-gray-500">{f.sub}</p>
                ) : (
                  <p className="text-[11px] text-gray-600">Coming soon</p>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* What we do differently. Kept separate from FEATURES above rather
            than merged into it -- these aren't "the product," they're the
            reasons to pick this one over another platform, and burying that
            pitch in a generic feature grid would waste it. */}
        <section className="py-14 px-6 border-t border-white/5">
          <div className="max-w-5xl mx-auto">
            <h2 className="text-2xl font-black text-center mb-2">
              What We Do <span className="text-brand-pink">Differently</span>
            </h2>
            <p className="text-center text-gray-400 text-sm max-w-xl mx-auto mb-10">
              The stuff other platforms in this space don&apos;t have.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 text-center">
              {DIFFERENTIATORS.map((f) => (
                <div key={f.title}>
                  <f.Icon className="h-7 w-7 mb-3 text-brand-pink mx-auto" />
                  <p className="font-bold text-sm">{f.title}</p>
                  {f.live ? (
                    <p className="text-[11px] text-gray-500">{f.sub}</p>
                  ) : (
                    <>
                      <p className="text-[11px] text-gray-500">{f.sub}</p>
                      <p className="text-[10px] text-gray-600 mt-0.5">Coming soon</p>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Featured creators -- real accounts, not part of the mockup but the
            page would otherwise have no way into the actual product. */}
        {creators.length > 0 && (
          <section className="py-14 px-6 border-t border-white/5">
            <div className="max-w-6xl mx-auto">
              <div className="flex items-end justify-between mb-6">
                <h2 className="text-2xl font-black">Creators on OnlyOne</h2>
                <a href="/creators" className="text-sm text-brand-pink hover:underline">See all</a>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {creators.map((c) => (
                  <a
                    key={c.id}
                    href={`/creator/${c.id}`}
                    className="group relative aspect-[3/4] rounded-xl overflow-hidden border border-white/10 hover:border-brand-pink/60 transition"
                  >
                    <img
                      src={c.img}
                      alt={c.name}
                      className={`w-full h-full object-cover object-top transition group-hover:scale-105 ${c.gated ? 'blur-sm' : ''}`}
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent" />
                    <div className="absolute bottom-0 left-0 right-0 p-3">
                      <p className="font-bold text-sm truncate">{c.name}</p>
                      <p className="text-[11px] text-gray-400 truncate">{c.handle}</p>
                    </div>
                    <div className="absolute top-2 left-2 flex flex-col items-start gap-1">
                      {c.founding && (
                        <span className="text-[9px] tracking-wider px-2 py-0.5 rounded-full bg-brand-pink text-white font-black">
                          FOUNDING
                        </span>
                      )}
                      {c.demo && <DemoBadge short />}
                    </div>
                    {c.gated && (
                      <span title={`Hold ${c.gateLabel} to unlock`} className="absolute top-2 right-2 p-1.5 rounded-full bg-black/70 text-brand-pink">
                        <SolidIcons.lock className="h-3.5 w-3.5" />
                      </span>
                    )}
                  </a>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Closing CTA */}
        <section className="relative border-t border-white/5">
          <img src="/images/demo_male_avatar.jpg" alt="" className="absolute inset-0 w-full h-full object-cover object-center" />
          <div className="absolute inset-0 bg-brand-ink/70" />
          <div className="absolute inset-0 bg-gradient-to-r from-brand-ink via-brand-ink/85 to-transparent" />
          <AiArtLabel className="absolute right-3 bottom-3" />
          <div className="relative max-w-6xl mx-auto px-6 py-16 flex flex-col md:flex-row md:items-center md:justify-between gap-6">
            <div>
              <p className="text-[11px] tracking-[0.25em] text-gray-400 mb-3">IT STARTS HERE</p>
              <p className="text-4xl sm:text-5xl font-black tracking-tight">
                ONLY<span className="text-brand-pink">ONE</span>
              </p>
              <p className="text-[11px] tracking-[0.25em] text-gray-400 mt-3">CREATORS FIRST. FANS CLOSER.</p>
            </div>
            <a
              href="/signup"
              className="self-start md:self-auto px-8 py-4 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-bold transition inline-flex items-center gap-2"
            >
              Join Now <Icons.arrowRight className="inline-block h-4 w-4 align-[-0.15em]" />
            </a>
          </div>
        </section>

        {/* Footer -- these links are not decoration. The takedown form is
            required to be posted conspicuously under the federal TAKE IT
            DOWN Act, and the rest are the legal pages a processor asks for.
            Do not drop them in a redesign. */}
        <footer className="py-10 px-6 border-t border-white/5">
          <div className="max-w-5xl mx-auto">
            <div className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs text-gray-500 mb-6">
              <a href="/terms" className="hover:text-brand-pink transition">Terms of Service</a>
              <a href="/privacy" className="hover:text-brand-pink transition">Privacy Policy</a>
              {/* Each of these points at the section that actually covers it.
                  They all pointed at bare /terms, and two of them -- the
                  §2257 statement and a cookie policy -- had no such section
                  to point at in the first place. */}
              <a href="/privacy#cookies" className="hover:text-brand-pink transition">Cookie Policy</a>
              <a href="/2257" className="hover:text-brand-pink transition">18 U.S.C. §2257 Statement</a>
              <a href="/terms#content-removal" className="hover:text-brand-pink transition">DMCA / Takedown</a>
              <a href="/terms#complaints" className="hover:text-brand-pink transition">Complaints Policy</a>
              <a href="/terms#prohibited" className="hover:text-brand-pink transition">Acceptable Use</a>
              <a href="/token" className="hover:text-brand-pink transition">$ONLYONE</a>
              <a href="/report-content" className="text-red-400 hover:text-red-300 transition font-semibold">
                Report Non-Consensual Content
              </a>
              <a href="mailto:team@onlyone1.fun" className="hover:text-brand-pink transition">Contact</a>
            </div>
            <p className="text-gray-500 text-xs max-w-2xl mx-auto mb-2 text-center">
              18+ only. This site contains adult content. $ONLYONE is a meme token for entertainment purposes —
              not an investment, and not financial advice.
            </p>
            <p className="text-gray-600 text-xs text-center">© 2026 OnlyOne</p>
          </div>
        </footer>
      </div>
    </>
  );
}
