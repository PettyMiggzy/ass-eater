import { useEffect, useState } from 'react';
import Head from 'next/head';

export default function Home() {
  const [auctionTime, setAuctionTime] = useState({
    days: 4,
    hours: 0,
    minutes: 0,
    seconds: 0,
  });

  const [activeTab, setActiveTab] = useState('gallery');
  const [isScrolled, setIsScrolled] = useState(false);

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

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 50);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
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
        <title>Ass Eater - Luxury Meme Token</title>
        <meta name="description" content="The premium token for culture connoisseurs" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="min-h-screen bg-gradient-luxury text-white">
        {/* Premium Navigation */}
        <nav className={`fixed w-full top-0 z-50 transition-all duration-300 ${
          isScrolled
            ? 'bg-brand-dark/95 backdrop-blur-xl border-b border-brand-gold/20 shadow-luxury'
            : 'bg-transparent'
        }`}>
          <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
            <div className="flex items-center gap-2">
              <div className="text-2xl">🍑</div>
              <div className="text-xl font-bold tracking-widest text-brand-gold">ASS EATER</div>
            </div>
            <div className="flex gap-8 text-sm font-medium">
              <a href="#mascot" className="hover:text-brand-gold transition duration-300">Mascot</a>
              <a href="#gallery" className="hover:text-brand-gold transition duration-300">Gallery</a>
              <a href="#roadmap" className="hover:text-brand-gold transition duration-300">Roadmap</a>
              <a href="#links" className="hover:text-brand-gold transition duration-300">Contact</a>
            </div>
          </div>
        </nav>

        {/* Premium Hero Section with Featured Content */}
        <section className="pt-32 pb-12 px-6 relative overflow-hidden">
          {/* Hero Background with Featured Image Area */}
          <div className="absolute inset-0 z-0">
            <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/30 to-black/60"></div>
            <div className="absolute top-0 left-0 right-0 h-96 bg-gradient-to-b from-brand-gold/5 to-transparent"></div>
          </div>

          <div className="max-w-6xl mx-auto relative z-10">
            {/* Featured Content Grid */}
            <div className="grid md:grid-cols-3 gap-4 mb-12">
              {[1, 2, 3].map((i) => (
                <div key={i} className="aspect-video bg-gray-800 rounded-lg border-2 border-brand-gold/40 flex items-center justify-center overflow-hidden group cursor-pointer">
                  <div className="text-center">
                    <div className="text-4xl mb-2">👩</div>
                    <p className="text-gray-500 text-xs font-bold">Premium Content</p>
                  </div>
                  <div className="absolute inset-0 bg-gradient-to-t from-brand-gold/10 to-transparent opacity-0 group-hover:opacity-100 transition duration-300"></div>
                </div>
              ))}
            </div>

            {/* Main Hero Content */}
            <div className="text-center">
              <h1 className="text-7xl md:text-8xl font-black mb-4 premium-title">
                ASS EATER
              </h1>

              <p className="text-3xl md:text-4xl text-brand-secondary font-black mb-3 tracking-wider">
                PREMIUM ADULT TOKEN
              </p>

              <p className="text-xl text-gray-300 mb-4 max-w-3xl mx-auto leading-relaxed">
                Where culture meets confidence. A token celebrating the finer things in life. 18+ exclusive community for those with refined tastes.
              </p>

              <div className="flex justify-center gap-4 mb-12">
                <span className="px-4 py-2 rounded-full bg-brand-gold/20 text-brand-gold text-sm font-bold">NSFW ⚠️</span>
                <span className="px-4 py-2 rounded-full bg-green-900/30 text-green-300 text-sm font-bold">18+ ONLY</span>
              </div>

            {/* Premium Countdown */}
            <div className="inline-block mb-8">
              <div className="premium-card p-12 border-2 border-brand-gold/50">
                <p className="text-brand-secondary text-sm font-bold tracking-widest mb-6">EXCLUSIVE AUCTION LIVE</p>
                <div className="grid grid-cols-4 gap-6 mb-8">
                  {[
                    { label: 'Days', value: auctionTime.days },
                    { label: 'Hours', value: auctionTime.hours },
                    { label: 'Mins', value: auctionTime.minutes },
                    { label: 'Secs', value: auctionTime.seconds },
                  ].map((item) => (
                    <div key={item.label} className="text-center">
                      <div className="text-4xl font-black bg-gradient-gold text-transparent bg-clip-text">
                        {String(item.value).padStart(2, '0')}
                      </div>
                      <div className="text-xs uppercase text-gray-400 font-bold mt-2">{item.label}</div>
                    </div>
                  ))}
                </div>
                <a
                  href={process.env.NEXT_PUBLIC_LAUNCHPAD_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="premium-button inline-block"
                >
                  ACQUIRE NOW
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* Divider */}
        <div className="h-px bg-gradient-to-r from-transparent via-brand-gold/30 to-transparent"></div>

        {/* Featured Women Section */}
        <section id="mascot" className="py-24 px-6">
          <div className="max-w-6xl mx-auto">
            <h2 className="text-6xl font-black text-center mb-4 premium-title">FEATURED COLLECTION</h2>
            <p className="text-center text-gray-400 mb-16 text-lg">Premium aesthetic showcase</p>

            {/* Featured Models Grid */}
            <div className="grid md:grid-cols-2 gap-8">
              {/* Main Featured */}
              <div className="premium-card p-0 border-2 border-brand-gold/50 overflow-hidden">
                <div className="aspect-square bg-gradient-to-br from-gray-700 to-gray-900 flex items-center justify-center group cursor-pointer">
                  <div className="text-center">
                    <div className="text-8xl mb-3">👱‍♀️</div>
                    <p className="text-gray-400 font-bold">Premium Model</p>
                  </div>
                  <div className="absolute inset-0 bg-gradient-to-t from-brand-gold/20 to-transparent opacity-0 group-hover:opacity-100 transition duration-300"></div>
                </div>
              </div>

              {/* Featured Highlights */}
              <div className="space-y-6">
                <div className="premium-card p-8 border border-brand-gold/30">
                  <h3 className="text-3xl font-black mb-4 text-brand-gold">THE VISION</h3>
                  <p className="text-gray-300 text-lg leading-relaxed mb-4">
                    Premium adult content celebrating confidence, beauty, and unapologetic sensuality. A luxury platform for those who appreciate the finer aesthetic.
                  </p>
                  <p className="text-brand-secondary font-bold">Launching soon with exclusive content drops</p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="premium-card p-6 border border-brand-gold/30 text-center">
                    <div className="text-4xl mb-3">📸</div>
                    <h4 className="text-brand-gold font-bold mb-2">Photography</h4>
                    <p className="text-sm text-gray-400">Professional</p>
                  </div>
                  <div className="premium-card p-6 border border-brand-gold/30 text-center">
                    <div className="text-4xl mb-3">🎥</div>
                    <h4 className="text-brand-gold font-bold mb-2">Videography</h4>
                    <p className="text-sm text-gray-400">Premium</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Content Grid Below */}
            <div className="grid md:grid-cols-4 gap-4 mt-12">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="aspect-square premium-card border-2 border-brand-gold/30 flex items-center justify-center group cursor-pointer overflow-hidden">
                  <div className="text-center">
                    <div className="text-5xl mb-2">👩‍🦱</div>
                    <p className="text-gray-500 text-xs font-bold">Model {i}</p>
                  </div>
                  <div className="absolute inset-0 bg-gradient-to-t from-brand-gold/15 to-transparent opacity-0 group-hover:opacity-100 transition duration-300"></div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Divider */}
        <div className="h-px bg-gradient-to-r from-transparent via-brand-gold/30 to-transparent"></div>

        {/* Premium Content Gallery */}
        <section id="gallery" className="py-24 px-6">
          <div className="max-w-6xl mx-auto">
            <h2 className="text-6xl font-black text-center mb-2 premium-title">EXCLUSIVE GALLERY</h2>
            <p className="text-center text-brand-secondary font-bold mb-2">NSFW Content - 18+ Only</p>
            <p className="text-center text-gray-400 mb-16 text-lg">Celebrating the female form in premium aesthetic</p>

            {/* Content Type Tabs */}
            <div className="flex justify-center gap-4 mb-12">
              <button
                onClick={() => setActiveTab('gallery')}
                className={`px-8 py-3 font-bold tracking-wide rounded-md transition-all duration-300 ${
                  activeTab === 'gallery'
                    ? 'bg-gradient-gold text-black'
                    : 'border border-brand-gold/30 text-brand-gold hover:border-brand-gold/60'
                }`}
              >
                📸 PHOTOS
              </button>
              <button
                onClick={() => setActiveTab('videos')}
                className={`px-8 py-3 font-bold tracking-wide rounded-md transition-all duration-300 ${
                  activeTab === 'videos'
                    ? 'bg-gradient-gold text-black'
                    : 'border border-brand-gold/30 text-brand-gold hover:border-brand-gold/60'
                }`}
              >
                🎥 VIDEOS
              </button>
            </div>

            {/* Photo Gallery */}
            {activeTab === 'gallery' && (
              <div className="grid md:grid-cols-3 gap-6">
                {galleryImages.map((img) => (
                  <div
                    key={img.id}
                    className="group relative aspect-square rounded-lg overflow-hidden premium-card border-2 border-brand-gold/40 hover:border-brand-gold/70 cursor-pointer"
                  >
                    <div className="w-full h-full bg-gradient-to-br from-gray-700 to-gray-900 flex items-center justify-center relative">
                      <div className="text-center">
                        <div className="text-7xl mb-2">👩‍🦱</div>
                        <p className="text-gray-400 font-bold text-sm">Premium Photo</p>
                      </div>
                      <div className="absolute inset-0 bg-gradient-to-t from-brand-gold/20 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition duration-300"></div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Twerking Videos Section */}
            {activeTab === 'videos' && (
              <div className="space-y-8">
                <div className="grid md:grid-cols-2 gap-6">
                  {[1, 2, 3, 4].map((video) => (
                    <div
                      key={video}
                      className="group relative aspect-video rounded-lg overflow-hidden premium-card border-2 border-brand-gold/40 hover:border-brand-gold/70 cursor-pointer"
                    >
                      <div className="w-full h-full bg-gradient-to-br from-gray-700 to-gray-900 flex items-center justify-center relative">
                        <div className="text-center">
                          <div className="text-6xl mb-2">🎥</div>
                          <p className="text-gray-400 font-bold">Twerking Content</p>
                        </div>
                        <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition duration-300">
                          <div className="text-6xl">▶️</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="text-center text-gray-400 italic">
                  More premium twerking videos coming soon...
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Divider */}
        <div className="h-px bg-gradient-to-r from-transparent via-brand-gold/30 to-transparent"></div>

        {/* Token Details */}
        <section className="py-24 px-6">
          <div className="max-w-6xl mx-auto">
            <h2 className="text-6xl font-black text-center mb-4 premium-title">THE OFFERING</h2>
            <p className="text-center text-gray-400 mb-16 text-lg">Premium tokenomics for premium holders</p>

            <div className="grid md:grid-cols-3 gap-8 mb-12">
              <div className="premium-card p-10 border-2 border-brand-gold/30 text-center">
                <div className="text-5xl mb-4">🍑</div>
                <h3 className="text-2xl font-black text-brand-gold mb-3">DISTINCTION</h3>
                <p className="text-gray-300">Own a piece of something truly unique</p>
              </div>
              <div className="premium-card p-10 border-2 border-brand-gold/30 text-center">
                <div className="text-5xl mb-4">👥</div>
                <h3 className="text-2xl font-black text-brand-gold mb-3">COMMUNITY</h3>
                <p className="text-gray-300">Join an exclusive circle of like-minded individuals</p>
              </div>
              <div className="premium-card p-10 border-2 border-brand-gold/30 text-center">
                <div className="text-5xl mb-4">🚀</div>
                <h3 className="text-2xl font-black text-brand-gold mb-3">POTENTIAL</h3>
                <p className="text-gray-300">Be part of something groundbreaking</p>
              </div>
            </div>

            <div className="premium-card p-10 border-2 border-brand-gold/30">
              <div className="grid md:grid-cols-2 gap-8">
                <div>
                  <p className="text-brand-secondary font-bold text-sm tracking-widest mb-4">CONTRACT DETAILS</p>
                  <div className="space-y-4 text-sm text-gray-400 font-mono">
                    <div className="flex justify-between">
                      <span>Address:</span>
                      <span className="text-brand-gold">{process.env.NEXT_PUBLIC_CONTRACT_ADDRESS}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Network:</span>
                      <span className="text-brand-gold">Ethereum</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Status:</span>
                      <span className="text-green-400 font-bold">Active</span>
                    </div>
                  </div>
                </div>
                <div>
                  <p className="text-brand-secondary font-bold text-sm tracking-widest mb-4">ALLOCATION</p>
                  <div className="space-y-4 text-gray-300">
                    <p>Post-auction allocation: <span className="text-brand-gold font-bold">40%</span></p>
                    <p>Currently live on KekFun launchpad with exclusive 4-day auction window</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Divider */}
        <div className="h-px bg-gradient-to-r from-transparent via-brand-gold/30 to-transparent"></div>

        {/* Premium Roadmap */}
        <section id="roadmap" className="py-24 px-6">
          <div className="max-w-6xl mx-auto">
            <h2 className="text-6xl font-black text-center mb-4 premium-title">VISION & TIMELINE</h2>
            <p className="text-center text-gray-400 mb-16 text-lg">Our journey toward excellence</p>

            <div className="space-y-6 max-w-3xl mx-auto">
              {[
                {
                  phase: 'PHASE I: GENESIS',
                  status: 'ACTIVE',
                  items: ['4-Day Exclusive Auction', 'Premium Community Launch', 'Brand Positioning', 'Foundation Building'],
                },
                {
                  phase: 'PHASE II: CREATION',
                  status: 'IMMINENT',
                  items: ['Character Design Finalization', '3D Asset Development', 'Limited Edition NFTs', 'Merchandise Line'],
                },
                {
                  phase: 'PHASE III: PRODUCTION',
                  status: 'UPCOMING',
                  items: ['Original Composition', 'Professional Video Production', 'Multi-Platform Release', 'Viral Campaign'],
                },
                {
                  phase: 'PHASE IV: ASCENDANCE',
                  status: 'FUTURE',
                  items: ['Full Brand Ecosystem', 'Exclusive Events', 'Continued Innovation', 'Legacy Building'],
                },
              ].map((phase, i) => (
                <div key={i} className="premium-card p-8 border-2 border-brand-gold/30 group hover:border-brand-gold/60 transition">
                  <div className="flex items-start justify-between mb-6">
                    <h3 className="text-2xl font-black text-brand-gold">{phase.phase}</h3>
                    <span className={`px-4 py-2 rounded text-xs font-bold tracking-widest ${
                      i === 0
                        ? 'bg-green-900/50 text-green-300'
                        : 'bg-brand-gold/10 text-brand-secondary'
                    }`}>
                      {phase.status}
                    </span>
                  </div>
                  <div className="grid md:grid-cols-2 gap-4">
                    {phase.items.map((item, j) => (
                      <div key={j} className="flex items-start">
                        <span className="text-brand-gold mr-3 font-bold">✓</span>
                        <span className="text-gray-300">{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Divider */}
        <div className="h-px bg-gradient-to-r from-transparent via-brand-gold/30 to-transparent"></div>

        {/* Premium CTA Section */}
        <section id="links" className="py-24 px-6">
          <div className="max-w-4xl mx-auto text-center">
            <h2 className="text-6xl font-black mb-4 premium-title">BECOME AN INSIDER</h2>
            <p className="text-gray-400 mb-12 text-lg">Join the exclusive movement</p>

            <div className="flex flex-wrap justify-center gap-6 mb-16">
              <a
                href={process.env.NEXT_PUBLIC_LAUNCHPAD_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="premium-button"
              >
                SECURE YOUR POSITION
              </a>
              <a
                href="https://twitter.com"
                target="_blank"
                rel="noopener noreferrer"
                className="px-8 py-3 font-bold text-lg tracking-wide border-2 border-brand-gold text-brand-gold rounded-md hover:bg-brand-gold/10 transition duration-300"
              >
                TWITTER
              </a>
              <a
                href="https://discord.com"
                target="_blank"
                rel="noopener noreferrer"
                className="px-8 py-3 font-bold text-lg tracking-wide border-2 border-brand-gold text-brand-gold rounded-md hover:bg-brand-gold/10 transition duration-300"
              >
                DISCORD
              </a>
            </div>

            {/* Disclaimer */}
            <div className="premium-card p-10 border-2 border-brand-gold/20 text-left max-w-2xl mx-auto">
              <h3 className="text-xl font-black text-brand-gold mb-4">⚠️ IMPORTANT DISCLOSURE</h3>
              <p className="text-gray-300 text-sm leading-relaxed mb-4">
                This website contains adult content (NSFW). Age verification (18+) is mandatory. By accessing this site, you acknowledge full legal responsibility and confirm compliance with your jurisdiction's laws.
              </p>
              <p className="text-gray-400 text-xs">
                Cryptocurrency investments involve substantial risk. Conduct thorough research independently. This is a meme token created for entertainment purposes only. Not financial advice.
              </p>
            </div>
          </div>
        </section>

        {/* Premium Footer */}
        <footer className="border-t border-brand-gold/20 py-12 px-6 text-center bg-brand-dark/50 backdrop-blur">
          <div className="max-w-6xl mx-auto">
            <p className="text-brand-gold font-bold tracking-widest mb-2">ASS EATER TOKEN</p>
            <p className="text-gray-400 text-sm">Crafted for the distinguished. Built on principle.</p>
            <p className="text-gray-600 text-xs mt-4">© 2026 All Rights Reserved</p>
          </div>
        </footer>
      </div>
    </>
  );
}
