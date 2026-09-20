import Head from 'next/head';
import { SOCIAL_LINKS } from '../lib/social';
import { Mark } from '../components/Brand';
import WaitlistForm from '../components/WaitlistForm';

/**
 * What the public sees before launch, and what anyone without an invite
 * link sees at any URL on the site (proxy.js rewrites to here).
 *
 * THE RULE THIS PAGE HAS TO KEEP, same as pages/index.js: nothing explicit,
 * ever. No creator photos, no content grid, no blurred-but-obvious
 * thumbnail. It is exempt from the state age-verification gate on exactly
 * that basis -- it has to be, since it is what a blocked-state visitor gets
 * too -- and the moment real content lands on it that reasoning stops
 * holding.
 *
 * It is also the page a link preview renders when someone pastes the domain
 * into a post, so it carries its own social card.
 */

// Only things that are actually true today. This page exists precisely
// because the product is not finished, so overstating it here would be the
// least excusable place to do it.
const WHATS_COMING = [
  { title: 'For creators', body: 'Your own page, your own prices, your own tags. Sell in the marketplace. Keep 90% — we take a flat 10%, and nothing reduces it.' },
  { title: 'For fans', body: 'Follow the people you actually came for, save them, message them. Sign up with just a username if you would rather not leave an email anywhere.' },
  { title: 'Paid out in crypto', body: 'Creators are paid in dollars-backed stablecoin, wallet to wallet. No waiting two weeks for a bank.' },
];

export default function ComingSoon() {
  const title = 'OnlyOne — Launching Soon';
  const description = 'A creator platform for women, men, couples and everyone. Launching soon — get notified. 18+ only.';

  return (
    <>
      <Head>
        <title>{title}</title>
        <meta name="description" content={description} />
        <meta name="viewport" content="width=device-width, initial-scale=1" />

        {/* Text-only card, deliberately no og:image -- the only photography
            in this project is creator content, and an auto-expanded
            thumbnail of that in someone's timeline or group chat is exactly
            what must not happen. */}
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="OnlyOne" />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:url" content="https://www.joinonlyone.com/" />
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content={title} />
        <meta name="twitter:description" content={description} />
      </Head>

      <div className="relative min-h-screen bg-brand-ink text-white overflow-hidden flex flex-col">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 w-[900px] h-[900px] max-w-[160vw] rounded-full bg-brand-pink/10 blur-[140px]" />
        </div>

        <main className="relative flex-1 flex flex-col items-center justify-center text-center px-6 py-16">
          <Mark className="h-16 sm:h-24 w-auto text-brand-pink mb-5 drop-shadow-[0_0_28px_rgba(255,45,120,0.45)]" />

          <h1 className="text-5xl sm:text-7xl font-black tracking-tight leading-none">
            ONLY<span className="text-brand-pink">ONE</span>
          </h1>

          <p className="mt-5 text-[11px] sm:text-xs tracking-[0.35em] text-brand-pink">LAUNCHING SOON</p>

          <p className="mt-6 max-w-lg text-sm sm:text-base text-gray-400 leading-relaxed">
            A creator platform for women, men, couples and everyone — built so creators keep more of
            what they earn and fans can actually find them.
          </p>

          <div className="mt-12 w-full max-w-3xl grid sm:grid-cols-3 gap-6 text-left">
            {WHATS_COMING.map((item) => (
              <div key={item.title} className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
                <p className="text-[10px] font-bold tracking-[0.2em] text-brand-pink">{item.title.toUpperCase()}</p>
                <p className="mt-2 text-xs text-gray-400 leading-relaxed">{item.body}</p>
              </div>
            ))}
          </div>

          <div className="mt-14 w-full flex justify-center border-t border-white/5 pt-12">
            <WaitlistForm
              source="coming-soon"
              title="BE THERE ON DAY ONE"
              blurb="We’ll email you the moment OnlyOne opens. Tell us which side you’re on."
            />
          </div>

          <a
            href="/founding-creator"
            className="mt-10 text-[11px] tracking-[0.2em] text-gray-400 hover:text-brand-pink transition"
          >
            CREATOR? BE ONE OF THE FIRST 100 <span aria-hidden="true">→</span>
          </a>
        </main>

        {/* These stay reachable without an invite and without passing age
            verification -- see the exemption lists in proxy.js for why each
            one has to. */}
        <footer className="relative border-t border-white/5 py-6 px-6">
          <div className="max-w-4xl mx-auto flex flex-wrap justify-center gap-x-5 gap-y-2 text-[11px] text-gray-600 mb-3">
            <a href="/terms" className="hover:text-brand-pink transition">Terms</a>
            <a href="/privacy" className="hover:text-brand-pink transition">Privacy</a>
            <a href="/2257" className="hover:text-brand-pink transition">18 U.S.C. §2257</a>
            <a href="/report-content" className="text-red-400 hover:text-red-300 transition font-semibold">
              Report Non-Consensual Content
            </a>
            <a href="mailto:team@onlyone1.fun" className="hover:text-brand-pink transition">Contact</a>
            {SOCIAL_LINKS.map((s) => (
              <a
                key={s.name}
                href={s.url}
                target="_blank"
                rel="me noopener noreferrer"
                className="hover:text-brand-pink transition"
              >
                {s.name}
              </a>
            ))}
          </div>
          <p className="text-[11px] text-gray-600 text-center">
            18+ only. OnlyOne contains adult content available to verified adults.
          </p>
          <p className="text-[11px] text-gray-700 text-center mt-1">© 2026 OnlyOne</p>
        </footer>
      </div>
    </>
  );
}
