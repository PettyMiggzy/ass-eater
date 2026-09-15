import { useState } from 'react';
import Head from 'next/head';
import { getCreators } from '../lib/creators-store';

export async function getServerSideProps() {
  const all = await getCreators();
  const creators = all
    .filter((c) => c.status !== 'pending')
    .sort((a, b) => (b.trending === true) - (a.trending === true))
    .slice(0, 8);
  return { props: { creators } };
}

const DIFFERENTIATORS = [
  { icon: '/icons/money.png', label: '10% fee vs 20% elsewhere' },
  { icon: '/icons/lightning.png', label: 'Instant crypto payouts, no 7-day holds' },
  { icon: '/icons/check.png', label: 'Zero chargebacks' },
  { icon: '/icons/lock.png', label: 'Private — nothing on a bank statement' },
  { icon: '/icons/onlyass-coin-logo.png', label: 'Pay 8% instead of 10% in $ONLYASS' },
];

export default function Home({ creators }) {
  const [subs, setSubs] = useState(500);
  const price = 9.99;
  const gross = subs * price;
  const hereNet = gross * 0.9;
  const thereNet = gross * 0.8;

  return (
    <>
      <Head>
        <title>Only Ass - Creators Keep 90%</title>
        <meta name="description" content="Only Ass — creators keep 90%, fans pay in crypto. No banks, no chargebacks, no card statements." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="min-h-screen bg-gradient-luxury text-white overflow-x-hidden">
        {/* Nav */}
        <nav className="w-full py-4 px-6 border-b border-brand-purple/10">
          <div className="max-w-6xl mx-auto flex items-center justify-between">
            <img src="/images/logo-final.png" alt="Only Ass" className="h-10 w-auto" />
            <div className="hidden md:flex items-center gap-7 text-sm text-gray-300">
              <a href="#creators" className="hover:text-brand-gold transition">Explore</a>
              <a href="#how-it-works" className="hover:text-brand-gold transition">How It Works</a>
              <a href="#token" className="hover:text-brand-gold transition">Token</a>
              <a href="/marketplace" className="hover:text-brand-gold transition">Marketplace</a>
              <a href="/login" className="hover:text-brand-gold transition">Log In</a>
              <a href="/signup?role=creator" className="px-4 py-1.5 rounded-full bg-gradient-to-r from-brand-gold to-brand-purple text-black font-bold hover:scale-105 transition">
                Start Earning
              </a>
            </div>
          </div>
        </nav>

        {/* Hero */}
        <section className="pt-20 pb-16 px-6 relative text-center">
          <div className="absolute top-10 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-brand-purple/15 rounded-full blur-3xl"></div>
          <div className="max-w-3xl mx-auto relative z-10">
            <h1 className="text-4xl md:text-6xl font-black leading-[1.05] mb-6 premium-title">
              Creators keep 90%.<br />Fans pay in crypto.
            </h1>
            <p className="text-lg text-gray-300 mb-3 max-w-xl mx-auto">
              No banks. No chargebacks. No card statements.
            </p>
            <p className="text-sm text-gray-500 mb-8">Payouts in USDC, ETH or $ONLYASS — same day.</p>

            <div className="flex flex-wrap justify-center gap-4 mb-4">
              <a href="/signup?role=creator" className="premium-button">Start Earning</a>
              <a href="#creators" className="px-8 py-3 rounded-md border-2 border-brand-purple/50 text-brand-purple font-bold hover:bg-brand-purple/10 transition">
                Explore Creators
              </a>
            </div>
          </div>
        </section>

        {/* Differentiator strip */}
        <section className="px-6 pb-16">
          <div className="max-w-5xl mx-auto premium-card p-6 grid grid-cols-2 md:grid-cols-5 gap-6">
            {DIFFERENTIATORS.map((d) => (
              <div key={d.label} className="text-center">
                <img src={d.icon} alt="" className="h-8 w-8 mx-auto mb-2" />
                <p className="text-xs text-gray-300 leading-snug">{d.label}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Featured creators */}
        {creators.length > 0 && (
          <section id="creators" className="py-16 px-6 border-t border-brand-purple/10">
            <div className="max-w-6xl mx-auto">
              <div className="flex items-end justify-between mb-8">
                <div>
                  <p className="eyebrow text-brand-purple text-xs mb-2">The Culture</p>
                  <h2 className="text-3xl md:text-4xl font-black premium-title">Featured Creators</h2>
                </div>
                <a href="/onlyass" className="text-sm text-brand-gold hover:underline hidden sm:block">See all →</a>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {creators.map((c) => (
                  <a
                    key={c.id}
                    href="/onlyass"
                    className="premium-card overflow-hidden hover:border-brand-gold/50 transition group"
                  >
                    <div className="aspect-square overflow-hidden">
                      <img
                        src={c.img}
                        alt=""
                        className="w-full h-full object-cover object-top blur-xl scale-110 group-hover:scale-100 transition"
                      />
                    </div>
                    <div className="p-3">
                      <p className="font-bold text-white text-sm truncate flex items-center gap-1">
                        {c.name}
                        {c.premium && <img src="/icons/check.png" alt="Premium" className="h-3.5 w-3.5 shrink-0" />}
                      </p>
                      <p className="text-xs text-gray-500 truncate mb-2">{c.handle}</p>
                      <span className="inline-block text-xs font-bold px-3 py-1 rounded-full bg-gradient-to-r from-brand-gold to-brand-purple text-black">
                        Subscribe from {c.price}
                      </span>
                    </div>
                  </a>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Earnings calculator */}
        <section className="py-16 px-6 border-t border-brand-purple/10">
          <div className="max-w-2xl mx-auto premium-card p-8">
            <p className="eyebrow text-brand-purple text-xs mb-2 text-center">For Creators</p>
            <h2 className="text-2xl md:text-3xl font-black premium-title text-center mb-8">See What You'd Keep</h2>

            <label className="block text-sm text-gray-400 mb-2">
              Subscribers: <span className="text-brand-gold font-bold">{subs.toLocaleString()}</span> × $9.99/mo
            </label>
            <input
              type="range"
              min={10}
              max={5000}
              step={10}
              value={subs}
              onChange={(e) => setSubs(Number(e.target.value))}
              className="w-full mb-8 accent-[#f4c86a]"
            />

            <div className="grid sm:grid-cols-2 gap-4 text-center">
              <div className="p-5 rounded-lg bg-black/40 border border-brand-purple/20">
                <p className="text-xs text-gray-500 mb-1">Elsewhere (80%)</p>
                <p className="text-2xl font-black text-gray-400">${thereNet.toLocaleString(undefined, { maximumFractionDigits: 0 })}/mo</p>
              </div>
              <div className="p-5 rounded-lg bg-gradient-to-br from-brand-gold/20 to-brand-purple/20 border border-brand-gold/40">
                <p className="text-xs text-brand-gold mb-1">On Only Ass (90%)</p>
                <p className="text-2xl font-black text-brand-gold">${hereNet.toLocaleString(undefined, { maximumFractionDigits: 0 })}/mo</p>
              </div>
            </div>
            <p className="text-center text-green-400 text-sm font-bold mt-4">
              +${(hereNet - thereNet).toLocaleString(undefined, { maximumFractionDigits: 0 })}/mo more in your pocket
            </p>
          </div>
        </section>

        {/* How it works */}
        <section id="how-it-works" className="py-16 px-6 border-t border-brand-purple/10">
          <div className="max-w-4xl mx-auto">
            <h2 className="text-3xl md:text-4xl font-black premium-title text-center mb-12">How It Works</h2>
            <div className="grid md:grid-cols-2 gap-8">
              <div className="premium-card p-6">
                <p className="eyebrow text-brand-gold text-xs mb-4">For Fans</p>
                <ol className="space-y-3 text-sm text-gray-300">
                  <li><span className="text-brand-gold font-bold mr-2">1.</span>Deposit USDC, ETH or $ONLYASS</li>
                  <li><span className="text-brand-gold font-bold mr-2">2.</span>Subscribe, unlock, or tip</li>
                  <li><span className="text-brand-gold font-bold mr-2">3.</span>Chat directly with creators</li>
                </ol>
              </div>
              <div className="premium-card p-6">
                <p className="eyebrow text-brand-gold text-xs mb-4">For Creators</p>
                <ol className="space-y-3 text-sm text-gray-300">
                  <li><span className="text-brand-gold font-bold mr-2">1.</span>Verify your identity and age</li>
                  <li><span className="text-brand-gold font-bold mr-2">2.</span>Post content and set your price</li>
                  <li><span className="text-brand-gold font-bold mr-2">3.</span>Withdraw earnings same-day</li>
                </ol>
              </div>
            </div>
          </div>
        </section>

        {/* Trust & safety */}
        <section className="py-16 px-6 border-t border-brand-purple/10">
          <div className="max-w-4xl mx-auto grid sm:grid-cols-3 gap-6 text-center">
            <div className="premium-card p-6">
              <img src="/icons/check.png" className="h-8 w-8 mx-auto mb-3" alt="" />
              <p className="text-sm text-gray-300">All creators are ID-verified before going live</p>
            </div>
            <div className="premium-card p-6">
              <img src="/icons/lock.png" className="h-8 w-8 mx-auto mb-3" alt="" />
              <p className="text-sm text-gray-300">Content is protected and access-controlled</p>
            </div>
            <div className="premium-card p-6">
              <img src="/icons/warning.png" className="h-8 w-8 mx-auto mb-3" alt="" />
              <p className="text-sm text-gray-300">Report and takedown requests handled within 24h</p>
            </div>
          </div>
        </section>

        {/* Token — below the fold, utility first */}
        <section id="token" className="py-16 px-6 border-t border-brand-purple/10">
          <div className="max-w-3xl mx-auto premium-card p-8">
            <p className="eyebrow text-brand-purple text-xs mb-2">The Token</p>
            <h2 className="text-2xl md:text-3xl font-black premium-title mb-4">$ONLYASS</h2>
            <ul className="text-sm text-gray-300 space-y-2 mb-6 list-disc list-inside">
              <li>Creators pay 8% instead of 10% platform fee when paid out in $ONLYASS</li>
              <li>Fans get a deposit bonus for funding their balance in $ONLYASS</li>
              <li>Staking for promoted discovery placement — coming soon</li>
            </ul>
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6 text-sm">
              <div className="flex justify-between sm:block border-b sm:border-0 border-brand-purple/10 pb-2 sm:pb-0">
                <span className="text-gray-500">Contract</span>
                <span className="text-brand-gold font-mono ml-2 break-all">{process.env.NEXT_PUBLIC_CONTRACT_ADDRESS}</span>
              </div>
              <span className="px-3 py-1 rounded-full bg-brand-purple/20 text-brand-purple text-xs font-bold w-fit">Ethereum</span>
              <a
                href={process.env.NEXT_PUBLIC_LAUNCHPAD_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="premium-button text-sm py-2 px-5 sm:ml-auto"
              >
                Buy $ONLYASS
              </a>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="py-10 px-6 border-t border-brand-purple/10">
          <div className="max-w-5xl mx-auto">
            <div className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs text-gray-500 mb-6">
              <a href="/terms" className="hover:text-brand-gold transition">Terms of Service</a>
              <a href="/terms" className="hover:text-brand-gold transition">Privacy Policy</a>
              <a href="/terms" className="hover:text-brand-gold transition">Cookie Policy</a>
              <a href="/terms" className="hover:text-brand-gold transition">18 U.S.C. §2257 Statement</a>
              <a href="/terms" className="hover:text-brand-gold transition">DMCA / Takedown</a>
              <a href="/terms" className="hover:text-brand-gold transition">Complaints Policy</a>
              <a href="/terms" className="hover:text-brand-gold transition">Acceptable Use</a>
              <a href="mailto:support@onlyass.fun" className="hover:text-brand-gold transition">Contact</a>
            </div>
            <p className="text-gray-500 text-xs max-w-2xl mx-auto mb-2 text-center">
              18+ only. This site contains adult content. $ONLYASS is a meme token for entertainment purposes —
              not an investment, and not financial advice.
            </p>
            <p className="text-gray-600 text-xs text-center">© 2026 Only Ass</p>
          </div>
        </footer>
      </div>
    </>
  );
}
