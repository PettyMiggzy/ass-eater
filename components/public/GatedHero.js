import { useEffect, useRef, useState } from 'react';
import { Icons, Tagline } from '../Brand';
import { houseCoverSrc } from '../../data/house-roster';

/**
 * The hero from the owner's 2026-09-27 mockup (0804e01f): a letter-spaced
 * small-caps line, a big two-line headline with the second line in pink, a
 * pink pill and an outline pill, the neon script accent, and a large model
 * photo on the right.
 *
 * GATED PAGES ONLY (/home, /creators, /marketplace, /search, /favorites,
 * /creator/[id]). The ungated pages (/, /coming-soon, /founding-creator)
 * must never show a photo of a person; they do not use this component.
 *
 * The photo is one of OnlyOne's own AI house models (public/images/house/,
 * lib/house-roster.js) -- a fictional adult, never a real creator's image
 * reused as marketing. Because it is AI imagery the hero always carries
 * "Model imagery is AI-generated.", and none of the copy here may say "real
 * people" (Terms section 7). Until the house covers are deployed the photo
 * falls back to the existing AI hero art (/images/home-hero.jpg).
 *
 * Nothing on this hero may advertise a feature the site does not have: no
 * live cams, subscriptions, tips, PPV, "fast payouts", coin logos, "100%
 * anonymous" or "no personal data". TRUST below is the approved wording.
 */
const FALLBACK_IMAGE = '/images/home-hero.jpg';
const DEFAULT_MODEL = 'nova-reyes';

export const TRUST = [
  { Icon: Icons.shield, title: 'Discreet billing', sub: 'Nothing on a card statement' },
  { Icon: Icons.coin, title: 'USDC credits', sub: 'Pay with USDC credits — no card needed' },
  { Icon: Icons.lock, title: 'Your privacy matters', sub: 'Private by design' },
];

function HeroPhoto({ slug }) {
  const primary = houseCoverSrc(slug);
  const [src, setSrc] = useState(primary);
  const ref = useRef(null);
  // An <img> that failed while the page was still server-rendered HTML fires
  // its error before React attaches onError; check once after hydration too.
  useEffect(() => {
    const el = ref.current;
    if (el && el.complete && el.naturalWidth === 0 && src !== FALLBACK_IMAGE) setSrc(FALLBACK_IMAGE);
  }, [src]);
  return (
    <img
      ref={ref}
      src={src}
      alt=""
      onError={() => {
        if (src !== FALLBACK_IMAGE) setSrc(FALLBACK_IMAGE);
      }}
      className="absolute inset-0 w-full h-full object-cover object-top"
    />
  );
}

export default function GatedHero({
  eyebrow = 'Real connections.',
  line1 = 'More than content.',
  line2 = 'It’s personal.',
  sub = 'OnlyOne is a platform for creators and fans. Buy direct in the creator marketplace, message the creators you like, and pay with credits.',
  primary = { href: '/signup', label: 'Join OnlyOne' },
  secondary = { href: '/creators', label: 'Explore Creators' },
  script = 'You’re Not Alone Here',
  modelSlug = DEFAULT_MODEL,
  showTrust = true,
  compact = false,
  kicker = null,
  children = null,
}) {
  return (
    <section className="relative overflow-hidden border-b border-brand-pink/10">
      <div aria-hidden="true" className="pointer-events-none absolute -left-40 -top-40 w-[520px] h-[520px] max-w-[120vw] rounded-full bg-brand-pink/15 blur-[120px]" />
      <div className={`relative max-w-6xl mx-auto grid lg:grid-cols-2 items-stretch ${compact ? '' : 'lg:min-h-[560px]'}`}>
        <div className={`relative z-10 px-4 sm:px-6 flex flex-col justify-center ${compact ? 'py-10 lg:py-14' : 'py-12 lg:py-20'}`}>
          {kicker}
          <p className="tagline-caps text-[11px] sm:text-xs text-gray-300 mb-5">{eyebrow}</p>
          <h1 className={`headline ${compact ? 'text-4xl sm:text-5xl' : 'text-[2.6rem] sm:text-6xl lg:text-[4.2rem]'} mb-6 break-words`}>
            <span className="block text-white">{line1}</span>
            <span className="block text-brand-pink drop-shadow-[0_0_24px_rgba(255,45,120,0.35)]">{line2}</span>
          </h1>
          {sub && <p className="text-gray-300 text-base sm:text-lg max-w-md mb-8 leading-relaxed">{sub}</p>}
          {(primary || secondary) && (
            <div className="flex flex-wrap gap-3">
              {primary && (
                <a href={primary.href} className="btn-pink">
                  {primary.label} <Icons.arrowRight className="h-4 w-4" />
                </a>
              )}
              {secondary && (
                <a href={secondary.href} className="btn-outline">
                  {secondary.label}
                </a>
              )}
            </div>
          )}
          {children}
          {showTrust && (
            <ul className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-0 mt-10 max-w-xl sm:divide-x sm:divide-white/10">
              {TRUST.map((t) => (
                <li key={t.title} className="flex sm:flex-col items-start gap-3 sm:gap-2 sm:px-4 first:sm:pl-0">
                  <t.Icon className="h-6 w-6 shrink-0 text-brand-pink drop-shadow-[0_0_6px_rgba(255,45,120,0.7)]" />
                  <span>
                    <span className="block font-brand font-bold text-sm text-white">{t.title}</span>
                    <span className="block text-xs text-gray-400">{t.sub}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={`relative ${compact ? 'min-h-[260px]' : 'min-h-[340px]'} lg:min-h-0`}>
          <HeroPhoto slug={modelSlug} />
          <div className="absolute inset-0 bg-gradient-to-t from-[#08060a] via-transparent to-transparent" />
          <div className="absolute inset-0 hidden lg:block bg-gradient-to-r from-[#08060a] via-[#08060a]/30 to-transparent" />
          {script && <Tagline className="absolute bottom-10 right-4 sm:right-8 max-w-[70%] text-right rotate-[-6deg]">{script}</Tagline>}
          <p className="absolute top-3 right-3 text-[11px] px-2 py-1 rounded-full bg-black/75 text-gray-100 font-semibold">
            Model imagery is AI-generated.
          </p>
        </div>
      </div>
    </section>
  );
}
