import Head from 'next/head';
import { marketplacePaymentsLive } from '../lib/marketplace-payment-config';
import { tokenGateLive } from '../lib/token-gate';
import { DM_PRICE_FLOOR_CENTS } from '../lib/brand';

// Empty until the token is actually deployed. Deliberately NOT
// NEXT_PUBLIC_CONTRACT_ADDRESS, which still holds the address from the
// cancelled launch.
const ONLYONE_ADDRESS = process.env.NEXT_PUBLIC_ONLYONE_TOKEN_ADDRESS || '';

// Statuses that depend on configuration are computed, not typed, so this
// page cannot say "planned" beside a live contract address again (it did:
// the roadmap called the token launch, credit purchases and marketplace
// buying "planned"/"built" while all three were live in production).
// NEXT_PUBLIC_* values are inlined at build, so this is safe on a static page.
const PAYMENTS_LIVE = marketplacePaymentsLive();
const GATING_LIVE = tokenGateLive();
const liveIf = (cond, otherwise) => (cond ? 'live' : otherwise);

const ROADMAP = [
  {
    title: 'Phase 0',
    subtitle: 'The platform itself',
    items: [
      { label: 'Creator profiles, galleries, Premium tier (gold check, 200 content slots)', status: 'live' },
      { label: 'Real DM messaging + in-profile chat', status: 'live' },
      { label: 'Marketplace: creators list images/videos/merch at any price, browse, search, report a listing', status: 'live' },
      { label: 'Multi-domain setup: joinonlyone.com (platform), shoponeonly.com (marketplace), plus mirror domains', status: 'live' },
    ],
  },
  {
    title: 'Phase 1',
    subtitle: 'Payments',
    items: [
      { label: 'Fans buy credits with dollars (USDG on Robinhood Chain)', status: liveIf(PAYMENTS_LIVE, 'built') },
      { label: 'Marketplace buying with credits', status: liveIf(PAYMENTS_LIVE, 'built') },
      { label: `Paid messages to creators (from $${(DM_PRICE_FLOOR_CENTS / 100).toFixed(2)}, creator-priced)`, status: liveIf(PAYMENTS_LIVE, 'built') },
      { label: 'Creators cash out earnings in USDG (requests reviewed by hand)', status: liveIf(PAYMENTS_LIVE, 'built') },
      { label: 'Full payment backend (Postgres/Fastify) deployed — not yet connected to the site', status: 'built' },
      { label: 'Subscriptions, tips, and pay-per-view unlocks', status: 'built' },
      { label: 'Scheduled and instant creator payouts', status: 'built' },
      { label: 'Creator perk tiers, priced in credits', status: 'built' },
      { label: 'Referral payouts to whoever brought a creator or a fan onto the platform', status: 'built' },
    ],
  },
  {
    title: 'Phase 2',
    subtitle: 'Token infrastructure',
    items: [
      { label: '$ONLYONE launched onto Robinhood Chain', status: liveIf(!!ONLYONE_ADDRESS, 'planned') },
      { label: 'Token-gated creators: prove you hold $ONLYONE by signing with your wallet — nothing is spent or moved', status: liveIf(GATING_LIVE, 'planned') },
      { label: 'VIP membership whose revenue buys $ONLYONE on the open market and burns it', status: 'planned' },
      { label: 'Live price oracle for $ONLYONE (Uniswap pool once one exists)', status: 'planned' },
    ],
  },
  {
    title: 'Phase 3',
    subtitle: 'Trust & compliance',
    items: [
      { label: 'Creator identity verification (KYC vendor)', status: 'planned' },
      { label: 'Age verification for states that require it by law (live via AgeChecker.Net)', status: 'live' },
      { label: 'Terms of Service and Privacy Policy (template -- needs attorney review)', status: 'live' },
      { label: 'Non-consensual content (deepfake/NCII) reporting & 48-hour takedown process, required by the federal TAKE IT DOWN Act', status: 'live' },
      { label: '18 U.S.C. §2257 statement and performer records', status: 'live' },
    ],
  },
  {
    title: 'Phase 4',
    subtitle: 'What\'s next',
    items: [
      { label: 'A dedicated merch store, separate from the peer-to-peer marketplace', status: 'planned' },
      { label: 'Forensic/invisible watermarking for video (images already get a traceable per-viewer mark)', status: 'planned' },
      { label: 'Public read-only API for $ONLYONE price/stats', status: 'planned' },
    ],
  },
];

export default function TokenLanding() {
  return (
    <>
      <Head>
        <title>$ONLYONE Token</title>
        <meta name="description" content="$ONLYONE — the access token for the OnlyOne creator platform. Not a payment method." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="min-h-screen bg-gradient-luxury text-white overflow-x-hidden">
        <nav className="w-full py-6 px-6">
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            <span className="text-xl font-black premium-title">$ONLYONE</span>
            <div className="flex items-center gap-4">
              <a href="/get-crypto" className="text-sm text-gray-300 hover:text-brand-gold transition">New to crypto?</a>
            </div>
          </div>
        </nav>

        <section className="pt-16 pb-20 px-6 text-center relative">
          <div className="absolute top-20 left-1/2 -translate-x-1/2 w-[500px] h-[500px] bg-brand-purple/15 rounded-full blur-3xl"></div>
          <div className="max-w-3xl mx-auto relative z-10">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-brand-gold/20 border border-brand-gold/30 text-brand-gold text-xs font-bold tracking-wide mb-6">
              <span className="w-2 h-2 rounded-full bg-brand-gold animate-pulse"></span>
              FAIR LAUNCH — NO PRESALE
            </div>
            <h1 className="text-5xl md:text-6xl font-black leading-[0.95] mb-6 premium-title">
              $ONLYONE
            </h1>
            <p className="text-lg text-gray-300 mb-10 max-w-xl mx-auto">
              An access token for a real creator platform. Hold it to unlock token-gated creators —
              you prove it by signing a message with your wallet, and nothing is spent or moved.
            </p>
            {/* Stated up front, not buried, because it is the whole design:
                content is paid for in dollar credits and this token is
                deliberately kept out of that path. See lib/brand.js. */}
            <p className="text-sm text-gray-500 max-w-xl mx-auto">
              $ONLYONE is not a payment method. Everything on the platform is paid for with credits
              bought in dollars — you never need to hold this token to use the platform.
            </p>
          </div>
        </section>

        <section className="py-16 px-6 border-t border-brand-purple/10">
          <div className="max-w-3xl mx-auto premium-card p-8">
            <div className="grid md:grid-cols-2 gap-6 text-sm">
              <div className="flex justify-between border-b border-brand-purple/10 pb-3">
                <span className="text-gray-400">Contract</span>
                {/* Reads the OnlyOne token address, and only once it is really
                    set. This card used to print NEXT_PUBLIC_CONTRACT_ADDRESS,
                    which is the pre-computed address from the cancelled
                    $ONLYASS auction -- a live, copyable address for a
                    contract that was never launched, sitting under the words
                    "FAIR LAUNCH". Anyone who sent funds to it would have been
                    sending them nowhere. */}
                <span className="text-brand-gold font-mono break-all text-right">
                  {ONLYONE_ADDRESS || 'Not launched yet'}
                </span>
              </div>
              <div className="flex justify-between border-b border-brand-purple/10 pb-3">
                <span className="text-gray-400">Network</span>
                <span className="text-brand-gold font-bold">Robinhood Chain (4663)</span>
              </div>
            </div>
            {!ONLYONE_ADDRESS && (
              <p className="text-gray-500 text-xs mt-4">
                $ONLYONE has not been deployed yet. There is no contract address, no pool and
                nothing to buy — anything claiming otherwise is not us.
              </p>
            )}
          </div>
        </section>

        <section className="py-16 px-6 border-t border-brand-purple/10">
          <div className="max-w-3xl mx-auto grid sm:grid-cols-2 gap-6 text-center">
            <div className="premium-card p-6">
              <h3 className="text-lg font-black text-brand-gold mb-2">Real Product</h3>
              <p className="text-gray-400 text-sm">Backs a live creator platform — not just a chart.</p>
            </div>
            <div className="premium-card p-6">
              <h3 className="text-lg font-black text-brand-gold mb-2">Holder Perks</h3>
              <p className="text-gray-400 text-sm">
                {GATING_LIVE
                  ? 'Hold it to unlock token-gated creators — a wallet signature proves you hold it; nothing is spent.'
                  : 'Token-gated creators unlock for holders once gating is switched on.'}{' '}
                Planned: VIP membership revenue buys it on the open market and burns it.
              </p>
            </div>
          </div>
        </section>

        <section className="py-16 px-6 border-t border-brand-purple/10">
          <div className="max-w-3xl mx-auto">
            <h2 className="text-2xl font-black premium-title text-center mb-2">Roadmap</h2>
            <p className="text-gray-500 text-sm text-center mb-10">
              Status, honestly — not a hype chart. "Live" means you can use it right now.
            </p>

            <div className="space-y-8">
              {ROADMAP.map((phase) => (
                <div key={phase.title} className="premium-card p-6">
                  <div className="flex items-center gap-3 mb-4">
                    <h3 className="font-black text-brand-gold">{phase.title}</h3>
                    <span className="text-xs text-gray-500">{phase.subtitle}</span>
                  </div>
                  <ul className="space-y-2">
                    {phase.items.map((item) => (
                      <li key={item.label} className="flex items-start gap-3 text-sm">
                        <span
                          className={`shrink-0 mt-0.5 px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wide ${
                            item.status === 'live'
                              ? 'bg-green-500/20 text-green-400'
                              : item.status === 'built'
                              ? 'bg-brand-gold/20 text-brand-gold'
                              : 'bg-gray-500/20 text-gray-400'
                          }`}
                        >
                          {item.status === 'live' ? 'Live' : item.status === 'built' ? 'Built' : 'Planned'}
                        </span>
                        <span className="text-gray-300">{item.label}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <p className="text-xs text-gray-600 text-center mt-8">
              "Built" = code is done and tested, but not connected to the live site yet.
              "Planned" = not started yet.
            </p>
          </div>
        </section>

        <footer className="py-10 px-6 border-t border-brand-purple/10 text-center">
          <p className="text-gray-500 text-xs max-w-xl mx-auto mb-2">
            Cryptocurrency carries risk — this is a meme token for entertainment, not financial advice.
          </p>
          <p className="text-gray-600 text-xs">© 2026 OnlyOne</p>
        </footer>
      </div>
    </>
  );
}
