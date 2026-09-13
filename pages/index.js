import { useEffect, useState } from 'react';
import Head from 'next/head';
import Image from 'next/image';

export default function Home() {
  const [auctionTime, setAuctionTime] = useState({
    days: 4,
    hours: 0,
    minutes: 0,
    seconds: 0,
  });

  const [activeTab, setActiveTab] = useState('gallery');

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

  const galleryImages = [
    { id: 1, alt: 'Gallery 1', url: '/images/gallery1.jpg' },
    { id: 2, alt: 'Gallery 2', url: '/images/gallery2.jpg' },
    { id: 3, alt: 'Gallery 3', url: '/images/gallery3.jpg' },
    { id: 4, alt: 'Gallery 4', url: '/images/gallery4.jpg' },
    { id: 5, alt: 'Gallery 5', url: '/images/gallery5.jpg' },
    { id: 6, alt: 'Gallery 6', url: '/images/gallery6.jpg' },
  ];

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
            <div className="text-2xl font-bold text-brand-primary">🍑 ASS EATER</div>
            <div className="flex gap-6 text-sm">
              <a href="#mascot" className="hover:text-brand-primary transition">Mascot</a>
              <a href="#gallery" className="hover:text-brand-primary transition">Gallery</a>
              <a href="#roadmap" className="hover:text-brand-primary transition">Roadmap</a>
              <a href="#links" className="hover:text-brand-primary transition">Links</a>
            </div>
          </div>
        </nav>

        {/* Hero Section */}
        <section className="pt-32 pb-8 px-4 text-center">
          <div className="max-w-4xl mx-auto">
            <div className="mb-6 text-6xl">🍑</div>
            <h1 className="text-6xl md:text-8xl font-black mb-4 text-transparent bg-clip-text bg-gradient-to-r from-brand-primary via-brand-secondary to-brand-accent">
              ASS EATER
            </h1>
            <p className="text-2xl md:text-3xl text-brand-secondary font-bold mb-3">
              DEGENERATE. UNFILTERED. UNAPOLOGETIC.
            </p>
            <p className="text-lg text-gray-300 mb-8">
              A token by degens, for degens. No cap, no bs, just vibes and assets.
            </p>

            {/* Auction Countdown */}
            <div className="bg-gray-900 border-2 border-brand-primary rounded-lg p-8 mb-8 inline-block">
              <p className="text-sm uppercase tracking-widest text-brand-secondary mb-4 font-bold">⏰ AUCTION LIVE NOW</p>
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
                className="inline-block bg-brand-primary hover:bg-brand-secondary text-black font-bold py-3 px-8 rounded-lg transition text-lg"
              >
                🚀 GET IN NOW
              </a>
            </div>
          </div>
        </section>

        {/* Mascot Section */}
        <section id="mascot" className="py-16 px-4 bg-gradient-to-b from-gray-900 to-brand-dark">
          <div className="max-w-6xl mx-auto">
            <h2 className="text-5xl font-black text-center mb-12 text-transparent bg-clip-text bg-gradient-to-r from-brand-primary to-brand-secondary">
              MEET THE DEGEN 🎭
            </h2>
            <div className="grid md:grid-cols-2 gap-8 items-center">
              <div className="bg-gray-800 rounded-lg border-2 border-brand-primary p-8 aspect-square flex items-center justify-center overflow-hidden">
                <div className="text-center">
                  <div className="text-9xl mb-4">🍑</div>
                  <p className="text-gray-400 text-sm">*Mascot avatar coming soon*</p>
                  <p className="text-brand-secondary font-bold mt-2">Stay tuned for the reveal 👀</p>
                </div>
              </div>
              <div className="space-y-6">
                <div>
                  <h3 className="text-3xl font-bold text-brand-primary mb-3">The Degen Life</h3>
                  <p className="text-gray-300 text-lg leading-relaxed">
                    our mascot lives the dream. all-in on life, all-in on ass. no filters, no shame, just vibes.
                    every day is a new opportunity to spread the gospel of the culture.
                  </p>
                </div>
                <div className="bg-gray-800 border border-brand-secondary rounded-lg p-6">
                  <h4 className="text-brand-secondary font-bold mb-3">DEGEN STATS 📊</h4>
                  <div className="space-y-2 text-sm">
                    <p>💪 Confidence Level: <span className="text-brand-primary font-bold">∞</span></p>
                    <p>🎯 Focus: <span className="text-brand-primary font-bold">locked in</span></p>
                    <p>📈 Portfolio Risk: <span className="text-brand-primary font-bold">YOLO</span></p>
                    <p>🍑 Taste: <span className="text-brand-primary font-bold">ELITE</span></p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Gallery & Videos Section */}
        <section id="gallery" className="py-16 px-4 bg-gray-900/50">
          <div className="max-w-6xl mx-auto">
            <h2 className="text-5xl font-black text-center mb-4 text-transparent bg-clip-text bg-gradient-to-r from-brand-primary to-brand-secondary">
              THE CULTURE 🔥
            </h2>
            <p className="text-center text-gray-400 mb-8">Celebrating the finer things in life</p>

            {/* Tabs */}
            <div className="flex justify-center gap-4 mb-12">
              <button
                onClick={() => setActiveTab('gallery')}
                className={`px-6 py-2 font-bold rounded-lg transition ${
                  activeTab === 'gallery'
                    ? 'bg-brand-primary text-black'
                    : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                }`}
              >
                📸 PHOTOS
              </button>
              <button
                onClick={() => setActiveTab('videos')}
                className={`px-6 py-2 font-bold rounded-lg transition ${
                  activeTab === 'videos'
                    ? 'bg-brand-primary text-black'
                    : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                }`}
              >
                🎥 VIDEOS
              </button>
            </div>

            {/* Photo Gallery */}
            {activeTab === 'gallery' && (
              <div className="grid md:grid-cols-3 gap-6">
                {galleryImages.map((img) => (
                  <div key={img.id} className="group relative aspect-square rounded-lg overflow-hidden border-2 border-brand-primary/30 hover:border-brand-primary transition cursor-pointer">
                    <div className="w-full h-full bg-gradient-to-br from-gray-800 to-gray-900 flex items-center justify-center">
                      <div className="text-center">
                        <div className="text-6xl mb-4">📸</div>
                        <p className="text-gray-500 text-sm">Add image</p>
                        <p className="text-gray-600 text-xs mt-2">gallery{img.id}.jpg</p>
                      </div>
                    </div>
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition"></div>
                  </div>
                ))}
              </div>
            )}

            {/* Videos Section */}
            {activeTab === 'videos' && (
              <div className="grid md:grid-cols-2 gap-6">
                {[1, 2, 3, 4].map((video) => (
                  <div key={video} className="group relative aspect-video rounded-lg overflow-hidden border-2 border-brand-secondary/30 hover:border-brand-secondary transition cursor-pointer bg-gray-800">
                    <div className="w-full h-full flex items-center justify-center">
                      <div className="text-center">
                        <div className="text-7xl mb-4">🎥</div>
                        <p className="text-gray-400 font-bold">Video {video}</p>
                        <p className="text-gray-600 text-sm mt-2">Add twerking content here</p>
                      </div>
                    </div>
                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition bg-black/40">
                      <div className="text-5xl">▶️</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Token Info */}
        <section id="about" className="py-16 px-4">
          <div className="max-w-6xl mx-auto">
            <h2 className="text-5xl font-black text-center mb-12 text-transparent bg-clip-text bg-gradient-to-r from-brand-primary to-brand-secondary">
              WHAT IS THIS? 🤔
            </h2>

            <div className="grid md:grid-cols-3 gap-6 mb-12">
              <div className="bg-gray-800 rounded-lg p-8 border-2 border-brand-primary text-center">
                <div className="text-5xl mb-4">🍑</div>
                <h3 className="text-2xl font-bold text-brand-primary mb-2">THE TOKEN</h3>
                <p className="text-gray-300">
                  a meme token for people who appreciate culture and aren't afraid to show it
                </p>
              </div>
              <div className="bg-gray-800 rounded-lg p-8 border-2 border-brand-secondary text-center">
                <div className="text-5xl mb-4">👥</div>
                <h3 className="text-2xl font-bold text-brand-secondary mb-2">THE COMMUNITY</h3>
                <p className="text-gray-300">
                  degens only. people who get it. people who live it. no bs.
                </p>
              </div>
              <div className="bg-gray-800 rounded-lg p-8 border-2 border-brand-accent text-center">
                <div className="text-5xl mb-4">🚀</div>
                <h3 className="text-2xl font-bold text-brand-accent mb-2">THE JOURNEY</h3>
                <p className="text-gray-300">
                  launched from nothing to everything. moon or bust mentality.
                </p>
              </div>
            </div>

            <div className="bg-gradient-to-r from-gray-800 to-gray-900 rounded-lg p-8 border border-brand-primary mb-8">
              <h3 className="text-2xl font-bold text-brand-primary mb-6">THE DEETS 📊</h3>
              <div className="grid md:grid-cols-2 gap-6 text-gray-300">
                <div className="flex justify-between border-b border-gray-700 pb-3">
                  <span>Contract</span>
                  <span className="text-brand-primary font-mono text-sm">{process.env.NEXT_PUBLIC_CONTRACT_ADDRESS}</span>
                </div>
                <div className="flex justify-between border-b border-gray-700 pb-3">
                  <span>Network</span>
                  <span className="text-brand-primary font-bold">Ethereum</span>
                </div>
                <div className="flex justify-between border-b border-gray-700 pb-3">
                  <span>Status</span>
                  <span className="text-green-400 font-bold">🟢 LIVE</span>
                </div>
                <div className="flex justify-between border-b border-gray-700 pb-3">
                  <span>Your Supply %</span>
                  <span className="text-brand-secondary font-bold">40% After Auction</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Roadmap */}
        <section id="roadmap" className="py-16 px-4 bg-gray-900/50">
          <div className="max-w-6xl mx-auto">
            <h2 className="text-5xl font-black text-center mb-4 text-transparent bg-clip-text bg-gradient-to-r from-brand-primary to-brand-secondary">
              THE PLAN 🗺️
            </h2>
            <p className="text-center text-gray-400 mb-12">From zero to hero</p>

            <div className="space-y-6 max-w-3xl mx-auto">
              {[
                {
                  phase: '🚀 PHASE 1: LAUNCH',
                  status: 'IN PROGRESS',
                  emoji: '🎯',
                  items: [
                    '4-day auction on KekFun (go hard)',
                    'Building the community (real ones only)',
                    'Social media takeover (getting goons)',
                    'Merch drops announced',
                  ],
                },
                {
                  phase: '🎭 PHASE 2: MASCOT',
                  status: 'COMING SOON',
                  emoji: '🎨',
                  items: [
                    'Degen character design finalized',
                    '3D model created (gonna be fire)',
                    'NFT drops for holders',
                    'Merch based on character',
                  ],
                },
                {
                  phase: '🎬 PHASE 3: MUSIC VIDEO',
                  status: 'INCOMING',
                  emoji: '🔥',
                  items: [
                    'Original music produced',
                    'Professional music video (featuring the culture)',
                    'Viral campaign pushes (we going viral)',
                    'Platform distribution',
                  ],
                },
                {
                  phase: '👑 PHASE 4: EMPIRE',
                  status: 'MOONSHOT',
                  emoji: '💎',
                  items: [
                    'Full merch line (apparel, accessories)',
                    'Community events (meet & greets)',
                    'Continued content drops',
                    'Legend status achieved',
                  ],
                },
              ].map((phase, i) => (
                <div key={i} className="bg-gray-800 rounded-lg p-6 border-2 border-brand-primary/40 hover:border-brand-primary transition">
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <span className="text-3xl">{phase.emoji}</span>
                      <h3 className="text-xl font-black text-brand-primary">{phase.phase}</h3>
                    </div>
                    <span className={`px-3 py-1 rounded-full text-xs font-bold uppercase whitespace-nowrap ${
                      i === 0
                        ? 'bg-green-900/50 text-green-300'
                        : 'bg-brand-secondary/20 text-brand-secondary'
                    }`}>
                      {phase.status}
                    </span>
                  </div>
                  <ul className="space-y-2">
                    {phase.items.map((item, j) => (
                      <li key={j} className="text-gray-300 flex items-start text-sm">
                        <span className="text-brand-primary mr-2 font-bold">→</span>
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
        <section id="links" className="py-16 px-4">
          <div className="max-w-6xl mx-auto text-center">
            <h2 className="text-5xl font-black mb-4 text-transparent bg-clip-text bg-gradient-to-r from-brand-primary to-brand-secondary">
              GET IN 🚀
            </h2>
            <p className="text-gray-400 mb-12">Join the movement</p>

            <div className="flex flex-wrap justify-center gap-4 mb-12">
              <a
                href={process.env.NEXT_PUBLIC_LAUNCHPAD_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="bg-brand-primary hover:bg-brand-secondary text-black font-black py-4 px-10 rounded-lg transition text-lg transform hover:scale-105"
              >
                🔥 BUY NOW (KekFun)
              </a>
              <a
                href="https://twitter.com"
                target="_blank"
                rel="noopener noreferrer"
                className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 px-10 rounded-lg transition text-lg"
              >
                𝕏 Twitter
              </a>
              <a
                href="https://discord.com"
                target="_blank"
                rel="noopener noreferrer"
                className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 px-10 rounded-lg transition text-lg"
              >
                💬 Discord
              </a>
            </div>

            <div className="bg-gray-800 rounded-lg p-8 border-2 border-brand-primary/50 text-left max-w-2xl mx-auto">
              <h3 className="text-2xl font-black text-brand-primary mb-4">⚠️ 18+ WARNING</h3>
              <p className="text-gray-300 text-sm leading-relaxed mb-4">
                <strong>This website contains NSFW content.</strong> You must be 18+ to access this site. By entering, you confirm you are of legal age in your jurisdiction and accept responsibility for your own viewing.
              </p>
              <p className="text-gray-400 text-xs mb-4">
                🔗 <strong>Contract Address:</strong> {process.env.NEXT_PUBLIC_CONTRACT_ADDRESS}
              </p>
              <p className="text-gray-400 text-xs">
                ⚖️ Crypto investments carry risk. Do your own research. This is a meme token for entertainment. Not financial advice.
              </p>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="border-t border-gray-700 py-12 px-4 text-center">
          <div className="max-w-6xl mx-auto">
            <p className="text-gray-400 mb-2">© 2026 Ass Eater Token</p>
            <p className="text-gray-600 text-sm">Built with 💪 and pure degen energy</p>
            <p className="text-gray-600 text-xs mt-4">WAGMI 🍑</p>
          </div>
        </footer>
      </div>
    </>
  );
}
