import { useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { getCreators } from '../../lib/creators-store';

export async function getServerSideProps({ params }) {
  const creators = await getCreators();
  const creator = creators.find((c) => String(c.id) === String(params.id)) || null;
  return { props: { creator } };
}

export default function CreatorProfile({ creator }) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState('posts');
  const [toast, setToast] = useState(null);

  const showComingSoon = (msg) => {
    setToast(msg || 'Launching in 4 days — connect your wallet then to unlock.');
    setTimeout(() => setToast(null), 3000);
  };

  if (!creator) {
    return (
      <div className="min-h-screen bg-gradient-luxury text-white flex items-center justify-center">
        <div className="text-center">
          <p className="text-2xl font-bold text-brand-gold mb-4">Creator not found</p>
          <a href="/onlyass" className="premium-button inline-block">Back to Only Ass</a>
        </div>
      </div>
    );
  }

  return (
    <>
      <Head>
        <title>{creator.name} - Only Ass</title>
      </Head>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] px-6 py-3 rounded-full bg-brand-gold text-black font-bold shadow-luxury-lg">
          {toast}
        </div>
      )}

      <div className="min-h-screen bg-gradient-luxury text-white pb-16">
        {/* Cover */}
        <div className="relative h-72 md:h-96 w-full overflow-hidden">
          {creator.video ? (
            <video src={creator.video} autoPlay loop muted playsInline className="w-full h-full object-cover" />
          ) : (
            <img src={creator.img} alt={creator.name} className="w-full h-full object-cover" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-brand-dark via-black/30 to-black/50"></div>

          {/* Back button */}
          <button
            onClick={() => router.push('/onlyass')}
            className="absolute top-6 left-6 w-10 h-10 rounded-full bg-black/50 backdrop-blur flex items-center justify-center text-xl hover:bg-black/70 transition"
          >
            ←
          </button>

          {/* Stats overlay */}
          <div className="absolute bottom-6 left-6 flex gap-6 text-sm font-bold">
            <span className="flex items-center gap-1">
              <img src="/icons/camera.png" className="h-4 w-4" alt="" /> {creator.media}
            </span>
            <span className="flex items-center gap-1">
              <img src="/icons/fire.png" className="h-4 w-4" alt="" /> {creator.likes}
            </span>
            <span className="flex items-center gap-1">
              <img src="/icons/crown.png" className="h-4 w-4" alt="" /> {creator.subs}
            </span>
          </div>
        </div>

        {/* Profile Header */}
        <div className="max-w-4xl mx-auto px-6">
          <div className="flex items-start justify-between -mt-16 relative z-10 mb-4">
            <div className="w-28 h-28 rounded-full border-4 border-brand-dark overflow-hidden bg-gray-800 shadow-luxury">
              <img src={creator.img} alt={creator.name} className="w-full h-full object-cover object-top" />
            </div>
            <div className="flex gap-3 mt-16">
              <button className="w-11 h-11 rounded-full border border-brand-gold/40 flex items-center justify-center hover:bg-brand-gold/10 transition">
                <img src="/icons/mail.png" className="h-5 w-5" alt="Message" />
              </button>
            </div>
          </div>

          <h1 className="text-3xl font-black premium-title mb-1">{creator.name}</h1>
          <p className="text-gray-400 text-sm mb-1">{creator.handle} · <span className="text-green-400">Online now</span></p>
          <p className="text-gray-300 mt-3 mb-6">{creator.bio}</p>

          {/* Chat CTA */}
          <button
            onClick={() => showComingSoon('AI chat launches with the platform — 4 days!')}
            className="w-full premium-card border-2 border-brand-gold/40 hover:border-brand-gold/70 transition p-4 flex items-center justify-center gap-3 mb-8"
          >
            <img src="/icons/chat.png" className="h-6 w-6" alt="" />
            <span className="font-bold text-brand-gold">Chat with {creator.name}</span>
          </button>

          {/* Subscription CTA */}
          <div className="premium-card p-6 border-2 border-brand-gold/40 mb-8">
            <p className="eyebrow text-brand-secondary text-xs mb-3">Subscription</p>
            <button onClick={() => showComingSoon()} className="w-full premium-button py-4 text-lg">
              {creator.locked ? `Subscribe — ${creator.price}` : 'Subscribe — Free'}
            </button>
          </div>

          {/* Tabs */}
          <div className="flex gap-6 border-b border-brand-gold/20 mb-8">
            <button
              onClick={() => setActiveTab('posts')}
              className={`pb-3 font-bold text-sm ${activeTab === 'posts' ? 'text-brand-gold border-b-2 border-brand-gold' : 'text-gray-500'}`}
            >
              {creator.posts} POSTS
            </button>
            <button
              onClick={() => setActiveTab('media')}
              className={`pb-3 font-bold text-sm ${activeTab === 'media' ? 'text-brand-gold border-b-2 border-brand-gold' : 'text-gray-500'}`}
            >
              {creator.media} MEDIA
            </button>
          </div>

          {/* Content Grid (locked) */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {(() => {
              const items = [
                creator.video ? { type: 'video', src: creator.video } : { type: 'image', src: creator.img },
                ...(creator.gallery || []),
              ];
              const filled = Array.from({ length: 6 }, (_, i) => items[i % items.length]);
              return filled.map((item, i) => (
                <div key={i} className="aspect-square rounded-lg overflow-hidden relative premium-card border border-brand-gold/20">
                  {item.type === 'video' ? (
                    <video src={item.src} autoPlay loop muted playsInline className={`w-full h-full object-cover ${creator.locked ? 'blur-md scale-110' : ''}`} />
                  ) : (
                    <img src={item.src} alt="" className={`w-full h-full object-cover ${creator.locked ? 'blur-md scale-110' : ''}`} />
                  )}
                  {creator.locked && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                      <img src="/icons/lock.png" className="h-6 w-6" alt="" />
                    </div>
                  )}
                </div>
              ));
            })()}
          </div>
        </div>
      </div>
    </>
  );
}
