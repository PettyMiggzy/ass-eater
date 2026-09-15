import Head from 'next/head';

export default function TokenLanding() {
  return (
    <>
      <Head>
        <title>$ONLYASS Token</title>
        <meta name="description" content="$ONLYASS — the token behind the Only Ass creator platform." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="min-h-screen bg-gradient-luxury text-white overflow-x-hidden">
        <nav className="w-full py-6 px-6">
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            <span className="text-xl font-black premium-title">$ONLYASS</span>
            <a
              href={process.env.NEXT_PUBLIC_LAUNCHPAD_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-1.5 rounded-full bg-gradient-to-r from-brand-gold to-brand-purple text-black font-bold text-sm hover:scale-105 transition"
            >
              Join Auction
            </a>
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
              $ONLYASS
            </h1>
            <p className="text-lg text-gray-300 mb-10 max-w-xl mx-auto">
              A degen-run token backing a real creator platform. Hold $ONLYASS to unlock content
              across the network, get creator payout discounts, and back a live product from day one.
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
                <span className="text-brand-gold font-bold">Ethereum</span>
              </div>
            </div>
          </div>
        </section>

        <section className="py-16 px-6 border-t border-brand-purple/10">
          <div className="max-w-3xl mx-auto grid sm:grid-cols-3 gap-6 text-center">
            <div className="premium-card p-6">
              <h3 className="text-lg font-black text-brand-gold mb-2">Live Auction</h3>
              <p className="text-gray-400 text-sm">4-day fair launch. No VC allocation, no presale.</p>
            </div>
            <div className="premium-card p-6">
              <h3 className="text-lg font-black text-brand-gold mb-2">Real Product</h3>
              <p className="text-gray-400 text-sm">Backs a live creator platform — not just a chart.</p>
            </div>
            <div className="premium-card p-6">
              <h3 className="text-lg font-black text-brand-gold mb-2">Holder Perks</h3>
              <p className="text-gray-400 text-sm">Unlock content and lower creator fees by paying in $ONLYASS.</p>
            </div>
          </div>
        </section>

        <footer className="py-10 px-6 border-t border-brand-purple/10 text-center">
          <p className="text-gray-500 text-xs max-w-xl mx-auto mb-2">
            Cryptocurrency carries risk — this is a meme token for entertainment, not financial advice.
          </p>
          <p className="text-gray-600 text-xs">© 2026 Only Ass</p>
        </footer>
      </div>
    </>
  );
}
