import Head from 'next/head';
import {
  SOCIAL_LINKS,
  OG_IMAGE,
  OG_IMAGE_WIDTH,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_ALT,
  CANONICAL_ORIGIN,
} from '../lib/social';
import { Mark, Icons, FoundingBadge } from '../components/Brand';
import WaitlistForm from '../components/WaitlistForm';
import { PREVIEW_COOKIE_NAME, previewModeEnabled, previewSecret, verifyPreviewToken } from '../lib/preview-access';
import { signupsOpen } from '../lib/signups';
import { PLATFORM_FEE_PCT, MARKETPLACE_FEE_PCT, LISTING_FEE_PCT, CREDIT_PURCHASE_FEE_PCT } from '../lib/brand';
import { getCreators } from '../lib/creators-store';
import {
  FOUNDING_LIMIT,
  FEE_WAIVER_DAYS,
  countFounding,
  foundingSlotsLeft,
  PAYMENTS_LIVE_AT,
} from '../lib/founding';

/**
 * Creator recruitment for the first-100 programme.
 *
 * This page is EXEMPT from the state age gate (see SFW_PATHS in proxy.js),
 * which puts it under the same hard rule as the public landing page: no
 * creator photos, no content grid, nothing explicit -- ever. It has to be
 * publicly shareable to do its job at all (a recruitment page that only
 * verified adults outside the 27 blocked states can open recruits nobody), and it is only
 * allowed to be public because there is nothing on it to verify anyone for.
 *
 * The other rule here is honesty about the offer: every perk on this page
 * must be true in code. The badge and both placements are real sorts; the
 * 0% fee is enforced in lib/credits-store.js's transferWithFee (no platform
 * fee and no listing fee on anything a fan spends on a founding creator
 * during their window -- see lib/founding.js); payouts are USDG from earned
 * credits; the referral link records who arrived through it but pays
 * nothing yet, and the copy says exactly that.
 */

export async function getServerSideProps({ req }) {
  // Counts only -- this page never renders a creator, so it never receives
  // one. Nothing to filter, nothing to leak.
  //
  // A failed roster read hides the counter instead of failing the page. This
  // is the one page whose entire job is to be opened by a stranger who
  // clicked a link, and a storage hiccup turning it into a 500 costs a
  // creator signup for the sake of a progress bar. Nulls rather than zeros:
  // "0 of 100 taken" would be a number we did not actually read.
  let taken = null;
  let left = null;
  try {
    const creators = await getCreators();
    taken = countFounding(creators);
    left = foundingSlotsLeft(creators);
  } catch (err) {
    console.error('[founding-creator] could not read the creator roster:', err);
  }

  // This page stays public, but its "claim your spot" button points at
  // /signup -- which can be shut for either of two independent reasons.
  // Whenever it is, the button would dead-end the one visitor this page
  // exists to convert, so it points at the waitlist on this same page
  // instead. Both reasons are checked because either alone is enough:
  //
  //   1. the pre-launch preview gate is on and this visitor has no invite
  //      (/signup is behind it, this page is not)
  //   2. signups are closed outright (lib/signups.js)
  let previewLocked = false;
  if (previewModeEnabled()) {
    const token = req.cookies?.[PREVIEW_COOKIE_NAME];
    previewLocked = !(await verifyPreviewToken(previewSecret(), token));
  }
  const signupLocked = previewLocked || !signupsOpen();

  // The waiver clock's earliest start, computed here on the server, where
  // the PAYMENTS_LIVE_AT env override is actually visible.
  const live = Date.parse(PAYMENTS_LIVE_AT);
  const paymentsLiveOn = Number.isNaN(live)
    ? null
    : new Date(live).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

  return { props: { taken, left, paymentsLiveOn, signupLocked } };
}

const PERKS = [
  {
    Icon: Icons.lock,
    title: `0% FEES`,
    sub: `FOR YOUR FIRST ${FEE_WAIVER_DAYS} DAYS`,
    body: 'Every credit a fan spends on you — marketplace sales and paid messages — is yours in full. No platform fee, no listing fee.',
  },
  {
    Icon: Icons.star,
    title: 'FOUNDING CREATOR BADGE',
    sub: 'PERMANENT',
    body: 'Shown on your profile and everywhere you appear. It does not expire when the fee waiver does.',
  },
  {
    Icon: Icons.people,
    title: 'PRIORITY PLACEMENT',
    sub: 'IN EXPLORE',
    body: 'Founding creators sort ahead of everyone else on the browse pages. A real sort, not a label.',
  },
  {
    Icon: Icons.video,
    title: 'PRIORITY PLACEMENT',
    sub: 'IN MARKETPLACE',
    body: 'Your listings lead the marketplace grid ahead of non-founding creators.',
  },
  {
    Icon: Icons.message,
    title: 'REFERRAL LINK',
    sub: 'BRING YOUR AUDIENCE',
    body: 'Your own link. Fans who sign up through it within 30 days of clicking are recorded as yours. Referral rewards are not live yet — nothing is paid for referrals today.',
  },
  {
    Icon: Icons.heart,
    title: 'CRYPTO PAYOUTS',
    sub: 'PAID OUT IN DOLLARS',
    body: 'Cash out what fans spend on you in USDG, a dollar stablecoin — not in a token you have to sell first, and not in something that moves overnight.'
  },
];

// One string for the page description and both social cards -- three copies
// of the same sentence is three chances for them to drift apart.
const shareDescription = `The first ${FOUNDING_LIMIT} creators on OnlyOne keep 100% of their earnings for ${FEE_WAIVER_DAYS} days, get a permanent Founding Creator badge, and lead every browse page.`;

export default function FoundingCreator({ taken, left, paymentsLiveOn, signupLocked }) {
  // Unknown counts read as open: the cap is enforced server-side on the
  // actual grant, so the worst case here is one extra applicant, not an
  // over-granted programme.
  const known = typeof taken === 'number' && typeof left === 'number';
  const open = !known || left > 0;
  const pct = known ? Math.min(100, Math.round((taken / FOUNDING_LIMIT) * 100)) : 0;

  return (
    <>
      <Head>
        <title>{`Become one of the first ${FOUNDING_LIMIT} OnlyOne creators`}</title>
        <meta name="description" content={shareDescription} />
        <meta name="viewport" content="width=device-width, initial-scale=1" />

        {/* This page exists to be pasted into a recruitment post, so it needs
            its own card rather than inheriting nothing. The image may only
            ever be brand art -- the only other imagery here is creator
            content, and a thumbnail of that auto-expanding into someone's
            feed is exactly what must not happen on an 18+ platform. */}
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="OnlyOne" />
        <meta property="og:title" content={`Become one of the first ${FOUNDING_LIMIT} OnlyOne creators`} />
        <meta property="og:description" content={shareDescription} />
        <meta property="og:url" content={`${CANONICAL_ORIGIN}/founding-creator`} />
        <meta property="og:image" content={OG_IMAGE} />
        <meta property="og:image:width" content={String(OG_IMAGE_WIDTH)} />
        <meta property="og:image:height" content={String(OG_IMAGE_HEIGHT)} />
        <meta property="og:image:alt" content={OG_IMAGE_ALT} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={`Become one of the first ${FOUNDING_LIMIT} OnlyOne creators`} />
        <meta name="twitter:description" content={shareDescription} />
        <meta name="twitter:image" content={OG_IMAGE} />
        <meta name="twitter:image:alt" content={OG_IMAGE_ALT} />
        <link rel="canonical" href={`${CANONICAL_ORIGIN}/founding-creator`} />
      </Head>

      <div className="relative min-h-screen bg-brand-ink text-white overflow-hidden">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/2 top-0 -translate-x-1/2 w-[900px] h-[700px] max-w-[160vw] rounded-full bg-brand-pink/10 blur-[140px]" />
        </div>

        <header className="relative px-6 pt-8">
          <a href="/" className="inline-flex items-center gap-3">
            <Mark className="h-9 w-auto text-brand-pink" />
            <span className="font-black tracking-tight text-lg">
              ONLY<span className="text-brand-pink">ONE</span>
            </span>
          </a>
        </header>

        <main className="relative max-w-4xl mx-auto px-6 pb-20 pt-10 sm:pt-16">
          <FoundingBadge className="h-24 w-24 mb-6 text-brand-pink drop-shadow-[0_0_30px_rgba(255,45,120,0.35)]" />
          <p className="text-[11px] tracking-[0.3em] text-brand-pink mb-5">FOUNDING CREATOR PROGRAMME</p>

          <h1 className="text-4xl sm:text-6xl font-black tracking-tight leading-[1.05]">
            BECOME ONE OF THE FIRST{' '}
            <span className="text-brand-pink">{FOUNDING_LIMIT}</span> ONLYONE CREATORS
          </h1>

          <p className="mt-6 text-gray-400 text-sm sm:text-base leading-relaxed max-w-2xl">
            OnlyOne is new. The creators who build it get treated like it.
          </p>

          {/* Slot counter. Real numbers off the real roster -- if this ever
              shows 100/100 the programme is genuinely closed, because the
              admin grant enforces the same cap server-side. */}
          {known && (
          <div className="mt-10 max-w-md">
            <div className="flex items-baseline justify-between mb-2">
              <p className="text-sm tracking-[0.15em] text-gray-300">
                {open ? (
                  <>
                    <span className="text-brand-pink font-black text-xl">{left}</span> OF {FOUNDING_LIMIT} SPOTS LEFT
                  </>
                ) : (
                  <>ALL {FOUNDING_LIMIT} SPOTS TAKEN</>
                )}
              </p>
              <p className="text-[11px] text-gray-500">{taken} claimed</p>
            </div>
            <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div className="h-full rounded-full bg-brand-pink transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
          )}

          <ul className="mt-14 grid sm:grid-cols-2 gap-x-10 gap-y-8">
            {PERKS.map((p) => (
              <li key={`${p.title}-${p.sub}`} className="flex gap-4">
                <p.Icon className="h-6 w-6 text-brand-pink shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-black tracking-[0.1em]">{p.title}</p>
                  <p className="text-[10px] tracking-[0.2em] text-brand-pink mt-1">{p.sub}</p>
                  <p className="text-sm text-gray-400 mt-2 leading-relaxed">{p.body}</p>
                </div>
              </li>
            ))}
          </ul>

          {/* Exactly when the clock runs, in the same size type as the
              promise itself. Burying this would be the dishonest version. */}
          <div className="mt-12 px-5 py-4 rounded-xl border border-brand-pink/25 bg-brand-pink/5">
            <p className="text-sm text-gray-300 leading-relaxed">
              <span className="text-brand-pink font-bold">About the 0% fees:</span> your {FEE_WAIVER_DAYS} fee-free
              days start the day you’re approved as a Founding Creator
              {paymentsLiveOn ? ` (or ${paymentsLiveOn}, when payments went live, if that’s later)` : ''} — not
              the day you sign up. During them, nothing is taken from what fans spend on you. After them,
              the standard fees apply: {PLATFORM_FEE_PCT}% on paid messages, {MARKETPLACE_FEE_PCT}% on marketplace
              sales ({PLATFORM_FEE_PCT}% platform fee + {LISTING_FEE_PCT}% listing fee).
            </p>
          </div>

          <p className="mt-16 text-2xl sm:text-4xl font-black tracking-tight leading-tight">
            YOUR CONTENT.
            <br />
            YOUR AUDIENCE.
            <br />
            <span className="text-brand-pink">YOUR INCOME.</span>
          </p>

          <div className="mt-10 flex flex-col sm:flex-row items-start sm:items-center gap-4">
            {signupLocked ? (
              <>
                <a
                  href="#waitlist"
                  className="px-10 py-4 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-black tracking-wide transition inline-flex items-center gap-3 shadow-[0_0_40px_rgba(255,45,120,0.35)]"
                >
                  GET EARLY ACCESS <Icons.arrowRight className="inline-block h-4 w-4 align-[-0.15em]" />
                </a>
                <p className="text-[11px] tracking-[0.2em] text-gray-500">
                  CREATOR SIGNUPS OPEN AT LAUNCH — LEAVE YOUR EMAIL AND WE’LL LET YOU IN FIRST
                </p>
              </>
            ) : open ? (
              <a
                href="/signup?role=creator"
                className="px-10 py-4 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-black tracking-wide transition inline-flex items-center gap-3 shadow-[0_0_40px_rgba(255,45,120,0.35)]"
              >
                CLAIM YOUR SPOT <Icons.arrowRight className="inline-block h-4 w-4 align-[-0.15em]" />
              </a>
            ) : (
              <a
                href="/signup?role=creator"
                className="px-10 py-4 rounded-full border border-white/20 hover:border-brand-pink font-black tracking-wide transition inline-flex items-center gap-3"
              >
                JOIN AS A CREATOR <Icons.arrowRight className="inline-block h-4 w-4 align-[-0.15em]" />
              </a>
            )}
            <p className="text-[11px] tracking-[0.2em] text-gray-500">
              {open
                ? 'THE FIRST 100 APPROVED WITH A FINISHED PROFILE'
                : 'THE FOUNDING PROGRAMME IS CLOSED — CREATOR SIGNUPS ARE STILL OPEN'}
            </p>
          </div>

          <div id="waitlist" className="mt-12 pt-10 border-t border-white/5 scroll-mt-8">
            <WaitlistForm
              source="founding-creator"
              defaultRole="creator"
              title="NOT READY TO SIGN UP YET?"
              blurb="Leave your email and we’ll let you know when you can join and when founding spots are running out."
              className="max-w-md"
            />
          </div>

          <p className="mt-8 text-xs text-gray-600 leading-relaxed max-w-2xl">
            18+ only. Every creator profile is reviewed by our team before it is published.
            A founding spot goes to each of the first {FOUNDING_LIMIT} creators approved with a finished
            profile — avatar, bio, tags and content up — not simply the first {FOUNDING_LIMIT} to sign up.
            The {FEE_WAIVER_DAYS}-day waiver removes both the {PLATFORM_FEE_PCT}% platform fee and the{' '}
            {LISTING_FEE_PCT}% marketplace listing fee on what fans spend on you (marketplace sales and paid
            messages) — 0% in total. Fans still pay the {CREDIT_PURCHASE_FEE_PCT}% fee when they buy credits;
            that is on their side of the purchase, not yours.
          </p>
        </main>

        <footer className="relative border-t border-white/5 py-6 px-6">
          <div className="max-w-4xl mx-auto flex flex-wrap justify-center gap-x-5 gap-y-2 text-[11px] text-gray-600">
            <a href="/" className="hover:text-brand-pink transition">Home</a>
            <a href="/terms" className="hover:text-brand-pink transition">Terms</a>
            <a href="/privacy" className="hover:text-brand-pink transition">Privacy</a>
            <a href="/report-content" className="text-red-400 hover:text-red-300 transition font-semibold">
              Report Non-Consensual Content
            </a>
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
        </footer>
      </div>
    </>
  );
}
