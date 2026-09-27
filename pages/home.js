import Head from 'next/head';
import SiteNav from '../components/SiteNav';
import { getSessionUser } from '../lib/session';
import { publicUser } from '../lib/users-store';
import { getCreators, toPublicCreator, isPubliclyVisible } from '../lib/creators-store';
import { byPlacement } from '../lib/founding';
import { tokenGateLive } from '../lib/token-gate';
import { Icons } from '../components/Brand';
import GatedHero from '../components/public/GatedHero';
import CategoryBar from '../components/public/CategoryBar';
import FeatureRow from '../components/public/FeatureRow';
import CreatorTile from '../components/public/CreatorTile';
import SiteFooter from '../components/public/SiteFooter';
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
// and each carries this label (the hero carries GatedHero's own line). The
// live "Creators on OnlyOne" strip is not covered by it: it shows whatever
// avatar each creator uploaded, and demo creators / AI house models there
// carry DemoBadge / AiModelBadge instead. Terms section 7 makes an AI label
// mandatory for creators; the platform's own marketing art can't be the one
// exception, and it must never read as real people.
function AiArtLabel({ className = '' }) {
  return (
    <span className={`pointer-events-none text-[10px] px-1.5 py-0.5 rounded bg-black/75 text-pink-300 font-bold ${className}`}>
      AI-generated
    </span>
  );
}

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

// The feature row is components/public/FeatureRow.js: LIVE features only.
// The old row here listed Subscriptions, Tips and PPV as "coming soon"; the
// restyle drops them rather than advertise what cannot be bought.

export default function Home({ creators, sessionUser, gatingLive }) {
  const DIFFERENTIATORS = differentiators(!!gatingLive);
  return (
    <>
      <Head>
        <title>OnlyOne — Creators</title>
        <meta
          name="description"
          content="A platform for creators and fans. Buy direct in the creator marketplace, message the creators you like, and pay with credits."
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="min-h-screen text-white overflow-x-hidden">
        <SiteNav signedIn={!!sessionUser} viewerAvatar={sessionUser?.img || null} />

        <GatedHero />

        <CategoryBar basePath="/creators" />

        {/* A Platform for Everyone */}
        <section className="py-16 px-4 sm:px-6">
          <div className="max-w-6xl mx-auto">
            <h2 className="font-brand font-extrabold text-3xl sm:text-4xl text-center mb-3">
              A Platform for <span className="text-brand-pink">Everyone</span>
            </h2>
            <p className="text-center text-gray-300 text-sm max-w-2xl mx-auto mb-10">
              Whether you&apos;re here to create or to explore, OnlyOne gives you the freedom to be yourself.
            </p>

            <div className="grid md:grid-cols-2 gap-5">
              {[
                { title: 'For Creators', copy: 'Take control of your content, your income and your freedom.', points: CREATOR_POINTS, cta: 'Start Creating', href: '/signup?role=creator', img: '/images/demo_male_1.jpg', primary: true },
                { title: 'For Fans', copy: 'Discover creators, exclusive content and genuine connections.', points: FAN_POINTS, cta: 'Start Exploring', href: '/creators', img: '/images/demo_female_2.jpg', primary: false },
              ].map((card) => (
                <div key={card.title} className="relative rounded-2xl overflow-hidden neon-edge bg-brand-card">
                  <img src={card.img} alt="" className="absolute left-0 top-0 h-full w-28 sm:w-40 object-cover opacity-70" />
                  <div className="absolute left-0 top-0 h-full w-28 sm:w-40 bg-gradient-to-r from-transparent to-brand-card" />
                  <AiArtLabel className="absolute left-2 bottom-2" />
                  <div className="relative pl-32 sm:pl-44 pr-4 sm:pr-6 py-7">
                    <h3 className="font-brand text-xl font-extrabold mb-2">{card.title}</h3>
                    <p className="text-sm text-gray-300 mb-4">{card.copy}</p>
                    <ul className="space-y-2 mb-6">
                      {card.points.map((pt) => (
                        <li key={pt} className="flex items-center gap-2 text-sm text-gray-200">
                          <Icons.check className="h-4 w-4 shrink-0 text-brand-pink" />
                          {pt}
                        </li>
                      ))}
                    </ul>
                    <a href={card.href} className={card.primary ? 'btn-pink text-sm' : 'btn-outline text-sm'}>
                      {card.cta} <Icons.arrowRight className="h-4 w-4" />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <FeatureRow />

        {/* What we do differently. Kept separate from the feature row
            rather than merged into it -- these aren't "the product," they're
            the reasons to pick this one over another platform. */}
        <section className="py-14 px-4 sm:px-6 border-t border-white/5">
          <div className="max-w-5xl mx-auto">
            <h2 className="font-brand text-2xl font-extrabold text-center mb-2">
              What We Do <span className="text-brand-pink">Differently</span>
            </h2>
            <p className="text-center text-gray-300 text-sm max-w-xl mx-auto mb-10">
              The stuff other platforms in this space don&apos;t have.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 text-center">
              {DIFFERENTIATORS.map((f) => (
                <div key={f.title}>
                  <f.Icon className="h-7 w-7 mb-3 text-brand-pink mx-auto" />
                  <p className="font-brand font-bold text-sm">{f.title}</p>
                  <p className="text-[11px] text-gray-400">{f.sub}</p>
                  {!f.live && <p className="text-[10px] text-gray-400 mt-0.5">Coming soon</p>}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Featured creators -- real accounts, not part of the mockup but the
            page would otherwise have no way into the actual product. */}
        {creators.length > 0 && (
          <section className="py-14 px-4 sm:px-6 border-t border-white/5">
            <div className="max-w-6xl mx-auto">
              <div className="flex items-end justify-between mb-6 gap-4">
                <h2 className="font-brand text-2xl font-extrabold">Creators on OnlyOne</h2>
                <a href="/creators" className="text-sm font-semibold text-brand-pink-light hover:underline shrink-0">See all</a>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {creators.map((c) => (
                  <CreatorTile key={c.id} c={c} />
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Closing CTA */}
        <section className="relative border-t border-brand-pink/15">
          <img src="/images/demo_male_avatar.jpg" alt="" className="absolute inset-0 w-full h-full object-cover object-center" />
          <div className="absolute inset-0 bg-[#08060a]/75" />
          <div className="absolute inset-0 bg-gradient-to-r from-[#08060a] via-[#08060a]/85 to-transparent" />
          <AiArtLabel className="absolute right-3 bottom-3" />
          <div className="relative max-w-6xl mx-auto px-4 sm:px-6 py-16 flex flex-col md:flex-row md:items-center md:justify-between gap-6">
            <div>
              <p className="tagline-caps text-[11px] text-gray-300 mb-3">It starts here</p>
              <p className="font-brand text-5xl sm:text-6xl font-extrabold tracking-tight">
                ONLY<span className="text-brand-pink">ONE</span>
              </p>
              <p className="tagline-caps text-[11px] text-gray-300 mt-3">Creators first. Fans closer.</p>
            </div>
            <a href="/signup" className="btn-pink self-start md:self-auto">
              Join Now <Icons.arrowRight className="h-4 w-4" />
            </a>
          </div>
        </section>

        <SiteFooter />
      </div>
    </>
  );
}
