import Head from 'next/head';
import {
  SOCIAL_LINKS,
  organizationJsonLd,
  CANONICAL_ORIGIN,
  OG_IMAGE,
  OG_IMAGE_WIDTH,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_ALT,
} from '../lib/social';
import { Mark, Icons } from '../components/Brand';
import WaitlistForm from '../components/WaitlistForm';

/**
 * The public front door -- the ONLY page on this site that sits outside the
 * state age-verification gate (see SFW_PATHS in proxy.js).
 *
 * THE RULE THIS PAGE HAS TO KEEP: nothing explicit, ever. The 27-state laws
 * put verification in front of sexual material harmful to minors, not in
 * front of a page describing what the site is -- which is why an
 * unverified visitor is allowed to see this at all, and why AgeChecker's
 * own documentation treats a page like this as the qualifying step before
 * registration. The moment someone drops a creator photo, a content grid or
 * a blurred-but-obvious thumbnail onto this page, that reasoning stops
 * holding and the exemption in proxy.js becomes a hole.
 *
 * So this page is deliberately typographic. Everything past "Join OnlyOne"
 * and "Enter" is gated.
 */

const AUDIENCES = ['WOMEN', 'MEN', 'COUPLES', 'LGBTQ+', 'EVERYONE'];

// These read as categories, and each one goes to the real tag search rather
// than a dead link. Tag pages are behind the gate, which is correct -- the
// label is safe to show publicly, the creators behind it are not.
const CATEGORIES = [
  { label: 'MEN', tag: 'men' },
  { label: 'WOMEN', tag: 'women' },
  { label: 'COUPLES', tag: 'couples' },
  { label: 'TRANS', tag: 'trans' },
  { label: 'NON-BINARY', tag: 'non-binary' },
  { label: 'ALL CREATORS', tag: null },
];

// Only the things that actually work today. Subscriptions, tips and
// pay-per-view are on the roadmap but cannot take money yet, and this is a
// public marketing page -- the one place where overstating what the product
// does is least excusable.
const FEATURES = [
  { Icon: Icons.video, title: 'Exclusive', sub: 'Content' },
  { Icon: Icons.message, title: 'Direct', sub: 'Messaging' },
  { Icon: Icons.lock, title: 'Marketplace', sub: '' },
  { Icon: Icons.heart, title: 'Support', sub: 'Creators' },
  { Icon: Icons.people, title: 'Inclusive', sub: 'Community' },
];

export default function Landing() {
  return (
    <>
      <Head>
        <title>OnlyOne — Real People. Real Connections.</title>
        <meta
          name="description"
          content="OnlyOne is a creator platform for women, men, couples and everyone. Create, share, connect, earn. 18+ only."
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />

        {/* Social share card. This page is the only one safe to paste into a
            post -- it is ungated and carries no creator content -- so these
            tags describe it and nothing deeper. The image is the brand
            lockup and may only ever be brand art: the only other imagery
            here is creator content, and a thumbnail of that auto-expanding
            into someone's timeline, Slack or group chat is exactly what
            must not happen on an 18+ platform. */}
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="OnlyOne" />
        <meta property="og:title" content="OnlyOne — Real People. Real Connections." />
        <meta
          property="og:description"
          content="A creator platform for women, men, couples and everyone. Launching soon — get notified. 18+ only."
        />
        <meta property="og:url" content="https://www.joinonlyone.com/" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="OnlyOne — Real People. Real Connections." />
        <meta
          name="twitter:description"
          content="A creator platform for women, men, couples and everyone. Launching soon — get notified. 18+ only."
        />
        <meta property="og:image" content={OG_IMAGE} />
        <meta property="og:image:width" content={String(OG_IMAGE_WIDTH)} />
        <meta property="og:image:height" content={String(OG_IMAGE_HEIGHT)} />
        <meta property="og:image:alt" content={OG_IMAGE_ALT} />
        <meta name="twitter:image" content={OG_IMAGE} />
        <meta name="twitter:image:alt" content={OG_IMAGE_ALT} />

        {/* Canonical: every apex domain 308s to its www form and several
            mirror domains serve this same page, so without this a search
            engine sees one page at five addresses and splits whatever
            authority it has between them. */}
        <link rel="canonical" href={`${CANONICAL_ORIGIN}/`} />

        {/* Organization data. sameAs is the working part: it is what ties
            the social profiles to this domain as ONE entity instead of
            three unrelated things -- the cheapest real SEO available to a
            site with no inbound links yet. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd()) }}
        />
      </Head>

      <div className="relative min-h-screen bg-brand-ink text-white overflow-hidden flex flex-col">
        {/* Ambient glow only -- no photography on this side of the gate. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 w-[900px] h-[900px] max-w-[160vw] rounded-full bg-brand-pink/10 blur-[140px]" />
          <div className="absolute right-0 bottom-0 w-[520px] h-[520px] max-w-[90vw] rounded-full bg-brand-purple/10 blur-[120px]" />
        </div>

        {/* Audience rail */}
        <div className="relative hidden sm:block absolute-left px-8 pt-8">
          <ul className="text-[11px] tracking-[0.25em] text-gray-500 space-y-1">
            {AUDIENCES.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
          <div className="w-10 h-px bg-brand-pink mt-3" />
        </div>

        {/* Neon note */}
        <p className="relative hidden md:block absolute-right px-8 -mt-24 text-right font-serif italic text-brand-pink text-xl leading-snug [text-shadow:0_0_18px_rgba(255,45,120,0.55)]">
          All Desires<br />Welcome<br />♥
        </p>

        <main className="relative flex-1 flex flex-col items-center justify-center text-center px-6 py-16">
          <Mark className="h-20 sm:h-28 w-auto text-brand-pink mb-5 drop-shadow-[0_0_28px_rgba(255,45,120,0.45)]" />

          <h1 className="text-5xl sm:text-7xl font-black tracking-tight leading-none">
            ONLY<span className="text-brand-pink">ONE</span>
          </h1>

          <p className="mt-6 text-[11px] sm:text-xs tracking-[0.3em] text-gray-300">
            REAL PEOPLE. REAL CONNECTIONS.
          </p>

          <p className="mt-6 text-sm sm:text-base tracking-[0.15em] text-gray-400 leading-relaxed">
            SAME DESIRES. DIFFERENT PEOPLE.
            <br />
            <span className="text-brand-pink">ONE PLACE.</span>
          </p>

          <ul className="mt-12 flex flex-wrap justify-center gap-x-10 gap-y-6">
            {FEATURES.map((f) => (
              <li key={f.title} className="w-24 flex flex-col items-center">
                <f.Icon className="h-7 w-7 text-brand-pink mb-2" />
                <p className="text-[10px] tracking-[0.15em] text-gray-300 leading-snug">
                  {f.title}
                  {f.sub && <><br />{f.sub}</>}
                </p>
              </li>
            ))}
          </ul>

          <div className="mt-12 flex flex-col sm:flex-row items-center gap-4">
            <a
              href="/signup"
              className="px-10 py-4 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-black tracking-wide transition inline-flex items-center gap-3 shadow-[0_0_40px_rgba(255,45,120,0.35)]"
            >
              JOIN ONLYONE <span aria-hidden="true">→</span>
            </a>
            {/* Everything past here is behind the age gate. */}
            <a href="/home" className="text-sm tracking-[0.2em] text-gray-400 hover:text-white transition">
              ENTER →
            </a>
          </div>

          <p className="mt-8 text-[10px] tracking-[0.3em] text-gray-500">
            CREATE. SHARE. CONNECT. EARN.
          </p>

          {/* Creator recruitment. Ungated like this page and for the same
              reason -- see pages/founding-creator.js. */}
          <a
            href="/founding-creator"
            className="mt-6 text-[11px] tracking-[0.2em] text-gray-400 hover:text-brand-pink transition"
          >
            CREATOR? BE ONE OF THE FIRST 100 <span aria-hidden="true">→</span>
          </a>

          <div className="mt-12 w-full flex justify-center border-t border-white/5 pt-10">
            <WaitlistForm
              source="landing"
              title="NOT OPEN YET? GET NOTIFIED."
              blurb="We’ll email you the moment OnlyOne goes live. Tell us which side you’re on."
            />
          </div>

          <nav className="mt-12 flex flex-wrap justify-center items-center gap-x-5 gap-y-2 text-[10px] tracking-[0.2em] text-gray-500">
            {CATEGORIES.map((c, i) => (
              <span key={c.label} className="flex items-center gap-5">
                <a
                  href={c.tag ? `/search?tag=${encodeURIComponent(c.tag)}` : '/creators'}
                  className="hover:text-brand-pink transition"
                >
                  {c.label}
                </a>
                {i < CATEGORIES.length - 1 && <span className="text-gray-700" aria-hidden="true">|</span>}
              </span>
            ))}
          </nav>
        </main>

        <div className="relative text-center pb-4">
          <p className="text-[10px] tracking-[0.3em] text-gray-600">
            ANYONE <span className="text-gray-800">|</span> ANYBODY <span className="text-gray-800">|</span> EVERYONE{' '}
            <span className="text-gray-800">|</span> <span className="text-brand-pink">ONLYONE</span>
          </p>
        </div>

        {/* These have to be reachable without passing the gate. The
            non-consensual-content report in particular is required to be
            freely accessible under the TAKE IT DOWN Act -- gating it would
            defeat the requirement, which is why /report-content is exempt in
            proxy.js too. */}
        <footer className="relative border-t border-white/5 py-6 px-6">
          <div className="max-w-4xl mx-auto flex flex-wrap justify-center gap-x-5 gap-y-2 text-[11px] text-gray-600 mb-3">
            <a href="/terms" className="hover:text-brand-pink transition">Terms</a>
            <a href="/privacy" className="hover:text-brand-pink transition">Privacy</a>
            <a href="/2257" className="hover:text-brand-pink transition">18 U.S.C. §2257</a>
            <a href="/terms#content-removal" className="hover:text-brand-pink transition">DMCA</a>
            <a href="/token" className="hover:text-brand-pink transition">$ONLYONE</a>
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
