import Head from 'next/head';

const ROADMAP = [
  {
    title: 'Phase 0',
    subtitle: 'The platform itself',
    items: [
      { label: 'Creator profiles, galleries, Premium tier (gold check, 200 content slots)', status: 'live' },
      { label: 'Real DM messaging + in-profile chat', status: 'live' },
      { label: 'Marketplace: creators list images/videos/merch at any price, browse, search, report a listing', status: 'live' },
      { label: 'Multi-domain setup: joinonlyone.com (platform), shoponeonly.com (marketplace), onlyass.fun/.xyz/.online/.shop (mirrors)', status: 'live' },
    ],
  },
  {
    title: 'Phase 1',
    subtitle: 'Payments go live',
    items: [
      { label: 'Custodial payment backend deployed (Postgres/Fastify, already built and tested)', status: 'built' },
      { label: 'Real subscriptions, tips, and pay-per-view unlocks', status: 'built' },
      { label: 'Fans buy credits with dollars (USDG on Robinhood Chain); creators are paid out the same way', status: 'planned' },
      { label: 'Instant creator payouts (+2% fee, waived for token-lock creators) and scheduled payouts', status: 'built' },
      { label: 'Marketplace buying', status: 'built' },
      { label: 'Creator token-lock perk: fans lock $ONLYONE for a creator-defined perk', status: 'built' },
      { label: 'Referral payouts to whoever brought a creator or a fan onto the platform', status: 'built' },
    ],
  },
  {
    title: 'Phase 2',
    subtitle: 'Token infrastructure',
    items: [
      { label: '$ONLYONE launched onto Robinhood Chain', status: 'planned' },
      { label: 'Live price oracle for $ONLYONE (Uniswap pool once one exists)', status: 'planned' },
    ],
  },
  {
    title: 'Phase 3',
    subtitle: 'Trust & compliance',
    items: [
      { label: 'Creator identity verification (KYC vendor)', status: 'planned' },
      { label: 'Age verification for states that require it by law (live via AgeChecker.Net)', status: 'live' },
      { label: 'Terms of Service and Privacy Policy (built, template -- needs attorney review before launch)', status: 'built' },
      { label: 'Non-consensual content (deepfake/NCII) reporting & 48-hour takedown process, required by the federal TAKE IT DOWN Act', status: 'live' },
      { label: '18 U.S.C. §2257 statement', status: 'planned' },
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
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-brand-purple/20 border border-brand-purple/30 text-brand-purple text-xs font-bold tracking-wide mb-6">
              <span className="w-2 h-2 rounded-full bg-brand-purple animate-pulse"></span>
              FAIR LAUNCH — NO PRESALE
            </div>
            <h1 className="text-5xl md:text-6xl font-black leading-[0.95] mb-6 premium-title">
              $ONLYONE
            </h1>
            <p className="text-lg text-gray-300 mb-10 max-w-xl mx-auto">
              An access token for a real creator platform. Hold it to unlock token-gated creators, and
              back a live product from day one.
            </p>
            {/* Stated up front, not buried, because it is the whole design:
                content is paid for in dollar credits and this token is
                deliberately kept out of that path. See lib/brand.js. */}
            <p className="text-sm text-gray-500 max-w-xl mx-auto">
              $ONLYONE is not a payment method. Subscriptions, tips and unlocks are paid for with credits
              bought in dollars — you never need to hold this token to use the platform.
            </p>
          </div>
        </section>

        <section className="py-16 px-6 border-t border-brand-purple/10">
          <div className="max-w-3xl mx-auto premium-card p-8">
            <div className="grid md:grid-cols-2 gap-6 text-sm">
              <div className="flex justify-between border-b border-brand-purple/10 pb-3">
                <span className="text-gray-400">Contract</span>
                <span className="text-brand-gold font-mono break-all">{process.env.NEXT_PUBLIC_CONTRACT_ADDRESS}</span>
              </div>
              <div className="flex justify-between border-b border-brand-purple/10 pb-3">
                <span className="text-gray-400">Network</span>
                <span className="text-brand-gold font-bold">Robinhood Chain (4663)</span>
              </div>
            </div>
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
              <p className="text-gray-400 text-sm">Hold it to unlock token-gated creators. VIP membership revenue buys it on the open market and burns it.</p>
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
              "Built" = code is done and tested, waiting on the backend deployment / a vendor account to go live.
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
