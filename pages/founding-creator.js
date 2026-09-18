import Head from 'next/head';
import { Mark, Icons } from '../components/Brand';
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
 * verified adults in 23 states can open recruits nobody), and it is only
 * allowed to be public because there is nothing on it to verify anyone for.
 *
 * The other rule here is honesty about the offer. Three of the six perks are
 * real today (badge, Explore placement, Marketplace placement); crypto
 * payouts are just how this platform already works; the referral link is
 * real; and the 0% fee is a promise about a fee that does not exist yet,
 * which the copy says in plain words rather than implying a countdown is
 * already running. See lib/founding.js for why the clock is deferred.
 */

export async function getServerSideProps() {
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

  return { props: { taken, left, paymentsLive: !!PAYMENTS_LIVE_AT } };
}

const PERKS = [
  {
    Icon: Icons.lock,
    title: `0% PLATFORM FEE`,
    sub: `FOR YOUR FIRST ${FEE_WAIVER_DAYS} DAYS`,
    body: 'Every dollar a fan spends on you is yours. No cut, no split, no exceptions.',
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
    title: 'REFERRAL REWARDS',
    sub: 'BRING YOUR AUDIENCE',
    body: 'Your own link. Everyone who joins through it is credited to you, permanently.',
  },
  {
    Icon: Icons.heart,
    title: 'CRYPTO PAYOUTS',
    sub: 'PAID OUT IN USDC',
    body: 'Earnings settle in USDC, not in a token you have to sell first and not in a currency that moves overnight.'
  },
];

export default function FoundingCreator({ taken, left, paymentsLive }) {
  // Unknown counts read as open: the cap is enforced server-side on the
  // actual grant, so the worst case here is one extra applicant, not an
  // over-granted programme.
  const known = typeof taken === 'number' && typeof left === 'number';
  const open = !known || left > 0;
  const pct = known ? Math.min(100, Math.round((taken / FOUNDING_LIMIT) * 100)) : 0;

  return (
    <>
      <Head>
        <title>Become one of the first 100 OnlyOne creators</title>
        <meta
          name="description"
          content={`The first ${FOUNDING_LIMIT} creators on OnlyOne keep 100% of their earnings for ${FEE_WAIVER_DAYS} days, get a permanent Founding Creator badge, and lead every browse page.`}
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
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

          {/* The one perk that is a promise rather than a live feature says
              so here, in the same size type as the promise itself. Burying
              this would be the dishonest version. */}
          {!paymentsLive && (
            <div className="mt-12 px-5 py-4 rounded-xl border border-brand-pink/25 bg-brand-pink/5">
              <p className="text-sm text-gray-300 leading-relaxed">
                <span className="text-brand-pink font-bold">About the 0% fee:</span> OnlyOne does not process
                payments yet, so there is no fee to charge anyone today. Your {FEE_WAIVER_DAYS} fee-free days
                start the day payments go live — not the day you join — so the offer is still worth something
                when it can actually be spent. Everything else on this page is live right now.
              </p>
            </div>
          )}

          <p className="mt-16 text-2xl sm:text-4xl font-black tracking-tight leading-tight">
            YOUR CONTENT.
            <br />
            YOUR AUDIENCE.
            <br />
            <span className="text-brand-pink">YOUR INCOME.</span>
          </p>

          <div className="mt-10 flex flex-col sm:flex-row items-start sm:items-center gap-4">
            {open ? (
              <a
                href="/signup?role=creator"
                className="px-10 py-4 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-black tracking-wide transition inline-flex items-center gap-3 shadow-[0_0_40px_rgba(255,45,120,0.35)]"
              >
                CLAIM YOUR SPOT <span aria-hidden="true">→</span>
              </a>
            ) : (
              <a
                href="/signup?role=creator"
                className="px-10 py-4 rounded-full border border-white/20 hover:border-brand-pink font-black tracking-wide transition inline-flex items-center gap-3"
              >
                JOIN AS A CREATOR <span aria-hidden="true">→</span>
              </a>
            )}
            <p className="text-[11px] tracking-[0.2em] text-gray-500">
              {open
                ? 'FOUNDING SPOTS ARE CONFIRMED AFTER PROFILE REVIEW'
                : 'THE FOUNDING PROGRAMME IS CLOSED — CREATOR SIGNUPS ARE STILL OPEN'}
            </p>
          </div>

          <p className="mt-8 text-xs text-gray-600 leading-relaxed max-w-2xl">
            18+ only. Creators must complete identity and age verification before their profile is published.
            Founding spots are granted on review, in the order profiles are completed, and the{' '}
            {FEE_WAIVER_DAYS}-day fee waiver applies to the platform fee only.
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
          </div>
        </footer>
      </div>
    </>
  );
}
