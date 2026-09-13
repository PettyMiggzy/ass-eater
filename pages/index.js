import { useEffect, useState } from 'react';
import Head from 'next/head';

export default function Home() {
  const [auctionTime, setAuctionTime] = useState({
    days: 4,
    hours: 0,
    minutes: 0,
    seconds: 0,
  });

  useEffect(() => {
    const interval = setInterval(() => {
      setAuctionTime((prev) => {
        let { days, hours, minutes, seconds } = prev;
        if (seconds > 0) {
          seconds--;
        } else if (minutes > 0) {
          minutes--;
          seconds = 59;
        } else if (hours > 0) {
          hours--;
          minutes = 59;
          seconds = 59;
        } else if (days > 0) {
          days--;
          hours = 23;
          minutes = 59;
          seconds = 59;
        }
        return { days, hours, minutes, seconds };
      });
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  return (
    <>
      <Head>
        <title>Ass Eater - Next Gen Meme Token</title>
        <meta name="description" content="Ass Eater token - A bold new meme currency for the culture" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="min-h-screen bg-brand-dark text-white">
        {/* Navigation */}
        <nav className="fixed w-full top-0 bg-brand-dark/95 backdrop-blur border-b border-brand-primary/20 z-50">
          <div className="max-w-6xl mx-auto px-4 py-4 flex justify-between items-center">
            <div className="text-2xl font-bold text-brand-primary">🍑 Ass Eater</div>
            <div className="flex gap-6">
              <a href="#about" className="hover:text-brand-primary transition">About</a>
              <a href="#roadmap" className="hover:text-brand-primary transition">Roadmap</a>
              <a href="#links" className="hover:text-brand-primary transition">Links</a>
            </div>
          </div>
        </nav>

        {/* Hero Section */}
        <section className="pt-32 pb-16 px-4 text-center">
          <div className="max-w-4xl mx-auto">
            <h1 className="text-6xl md:text-7xl font-black mb-6 text-transparent bg-clip-text bg-gradient-to-r from-brand-primary via-brand-secondary to-brand-accent">
              ASS EATER
            </h1>
            <p className="text-xl md:text-2xl text-gray-300 mb-8">
              A culture-defining meme token for the culture. Bold, unapologetic, and designed for the next generation.
            </p>

            {/* Auction Countdown */}
            <div className="bg-gray-900 border border-brand-primary rounded-lg p-8 mb-8 inline-block">
              <p className="text-sm uppercase tracking-widest text-brand-secondary mb-4">Live on Launchpad</p>
              <div className="grid grid-cols-4 gap-4 mb-6">
                {[
                  { label: 'Days', value: auctionTime.days },
                  { label: 'Hours', value: auctionTime.hours },
                  { label: 'Mins', value: auctionTime.minutes },
                  { label: 'Secs', value: auctionTime.seconds },
                ].map((item) => (
                  <div key={item.label} className="text-center">
                    <div className="text-3xl font-bold text-brand-primary">
                      {String(item.value).padStart(2, '0')}
                    </div>
                    <div className="text-xs uppercase text-gray-500">{item.label}</div>
                  </div>
                ))}
              </div>
              <a
                href={process.env.NEXT_PUBLIC_LAUNCHPAD_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block bg-brand-primary hover:bg-brand-secondary text-black font-bold py-3 px-8 rounded-lg transition"
              >
                Join Auction on KekFun
              </a>
            </div>
          </div>
        </section>

        {/* Token Info */}
        <section id="about" className="py-16 px-4 bg-gray-900/50">
          <div className="max-w-6xl mx-auto">
            <h2 className="text-4xl font-bold mb-12 text-center text-brand-primary">Token Info</h2>

            <div className="grid md:grid-cols-2 gap-8 mb-12">
              <div className="bg-gray-800 rounded-lg p-8 border border-gray-700">
                <h3 className="text-2xl font-bold text-brand-secondary mb-4">Contract Details</h3>
                <div className="space-y-4 text-gray-300 font-mono text-sm break-all">
                  <div>
                    <p className="text-gray-500 text-xs uppercase mb-1">Contract Address</p>
                    <p>{process.env.NEXT_PUBLIC_CONTRACT_ADDRESS}</p>
                  </div>
                  <div>
                    <p className="text-gray-500 text-xs uppercase mb-1">Chain</p>
                    <p>Ethereum (ETH)</p>
                  </div>
                  <div>
                    <p className="text-gray-500 text-xs uppercase mb-1">Status</p>
                    <p className="text-brand-secondary">Auction Active (4 Days Remaining)</p>
                  </div>
                </div>
              </div>

              <div className="bg-gray-800 rounded-lg p-8 border border-gray-700">
                <h3 className="text-2xl font-bold text-brand-secondary mb-4">About the Project</h3>
                <p className="text-gray-300 leading-relaxed">
                  Ass Eater is a community-driven meme token celebrating boldness and culture. Currently live on the KekFun launchpad with an active 4-day auction. After launch, we're building a complete ecosystem including a mascot character, music video, and community-driven content.
                </p>
              </div>
            </div>

            <div className="grid md:grid-cols-3 gap-6">
              <div className="bg-gray-800 rounded-lg p-6 border border-gray-700 text-center">
                <div className="text-3xl font-bold text-brand-primary mb-2">40%</div>
                <p className="text-gray-400">Expected Supply Post-Auction</p>
              </div>
              <div className="bg-gray-800 rounded-lg p-6 border border-gray-700 text-center">
                <div className="text-3xl font-bold text-brand-primary mb-2">Live Now</div>
                <p className="text-gray-400">Auction on KekFun Launchpad</p>
              </div>
              <div className="bg-gray-800 rounded-lg p-6 border border-gray-700 text-center">
                <div className="text-3xl font-bold text-brand-primary mb-2">NSFW</div>
                <p className="text-gray-400">Adult-Themed Community</p>
              </div>
            </div>
          </div>
        </section>

        {/* Roadmap */}
        <section id="roadmap" className="py-16 px-4">
          <div className="max-w-6xl mx-auto">
            <h2 className="text-4xl font-bold mb-12 text-center text-brand-primary">Roadmap</h2>

            <div className="space-y-8 max-w-2xl mx-auto">
              {[
                {
                  phase: 'Phase 1: Launch',
                  status: 'In Progress',
                  items: [
                    '4-day auction on KekFun',
                    'Community building',
                    'Social media presence',
                  ],
                },
                {
                  phase: 'Phase 2: Mascot Creation',
                  status: 'Upcoming',
                  items: [
                    '3D mascot design using Tripo API',
                    'Character development',
                    'NFT potential',
                  ],
                },
                {
                  phase: 'Phase 3: Music Video',
                  status: 'Upcoming',
                  items: [
                    'Music production',
                    'Professional music video with mascot',
                    'Content distribution across platforms',
                  ],
                },
                {
                  phase: 'Phase 4: Full Ecosystem',
                  status: 'Future',
                  items: [
                    'Merchandise and branding',
                    'Community events',
                    'Continued content creation',
                  ],
                },
              ].map((phase, i) => (
                <div key={i} className="bg-gray-900 rounded-lg p-8 border border-brand-primary/30">
                  <div className="flex items-start justify-between mb-4">
                    <h3 className="text-2xl font-bold text-brand-secondary">{phase.phase}</h3>
                    <span className={`px-3 py-1 rounded-full text-sm font-semibold ${
                      phase.status === 'In Progress'
                        ? 'bg-green-900 text-green-200'
                        : phase.status === 'Upcoming'
                        ? 'bg-yellow-900 text-yellow-200'
                        : 'bg-blue-900 text-blue-200'
                    }`}>
                      {phase.status}
                    </span>
                  </div>
                  <ul className="space-y-2">
                    {phase.items.map((item, j) => (
                      <li key={j} className="text-gray-300 flex items-start">
                        <span className="text-brand-primary mr-3">→</span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Links & Social */}
        <section id="links" className="py-16 px-4 bg-gray-900/50">
          <div className="max-w-6xl mx-auto text-center">
            <h2 className="text-4xl font-bold mb-12 text-brand-primary">Connect With Us</h2>

            <div className="flex flex-wrap justify-center gap-4 mb-12">
              <a
                href={process.env.NEXT_PUBLIC_LAUNCHPAD_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="bg-brand-primary hover:bg-brand-secondary text-black font-bold py-3 px-8 rounded-lg transition"
              >
                🚀 KekFun Auction
              </a>
              <a
                href="#"
                className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-8 rounded-lg transition"
              >
                𝕏 Twitter
              </a>
              <a
                href="#"
                className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 px-8 rounded-lg transition"
              >
                💬 Discord
              </a>
            </div>

            <div className="bg-gray-800 rounded-lg p-8 border border-gray-700 text-left max-w-2xl mx-auto">
              <h3 className="text-xl font-bold text-brand-secondary mb-4">⚖️ Legal Disclaimer</h3>
              <p className="text-gray-300 text-sm leading-relaxed mb-4">
                This website contains adult content (NSFW) and is intended for users 18 years of age and older only. Cryptocurrency investments carry inherent risks. Do your own research before participating in any token sale or investment. This project is for entertainment purposes and comes with no guarantees.
              </p>
              <p className="text-gray-400 text-xs">
                Use responsibly. Verify contracts on blockchain explorers before trading.
              </p>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="border-t border-gray-700 py-8 px-4 text-center text-gray-500">
          <p>© 2026 Ass Eater Token. Built with meme magic. ✨</p>
        </footer>
      </div>
    </>
  );
}
