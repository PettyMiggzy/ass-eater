import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { getCreators } from '../../lib/creators-store';
import { getSessionUserId } from '../../lib/session';
import { findUserByCreatorId } from '../../lib/users-store';
import { getListings } from '../../lib/listings-store';

export async function getServerSideProps({ req, params }) {
  const creators = await getCreators();
  const creator = creators.find((c) => String(c.id) === String(params.id)) || null;
  const viewerId = getSessionUserId(req);
  const creatorUser = creator ? await findUserByCreatorId(creator.id) : null;
  const allListings = creator ? await getListings() : [];
  const listings = allListings
    .filter((l) => String(l.creatorId) === String(creator?.id) && l.status === 'active')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return {
    props: {
      creator,
      viewerId: viewerId || null,
      creatorUserId: creatorUser ? String(creatorUser.id) : null,
      listings,
    },
  };
}

export default function CreatorProfile({ creator, viewerId, creatorUserId, listings }) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState('posts');
  const [toast, setToast] = useState(null);
  const [inboxOpen, setInboxOpen] = useState(false);

  const showComingSoon = (msg) => {
    setToast(msg || 'Launching in 4 days — connect your wallet then to unlock.');
    setTimeout(() => setToast(null), 3000);
  };

  const openInbox = () => {
    if (!viewerId) {
      router.push(`/login?next=/creator/${creator.id}`);
      return;
    }
    if (!creatorUserId) {
      showComingSoon("This creator hasn't claimed their account yet — messaging isn't available.");
      return;
    }
    if (String(viewerId) === String(creatorUserId)) {
      showComingSoon("That's you!");
      return;
    }
    setInboxOpen(true);
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
              <button
                onClick={openInbox}
                className="w-11 h-11 rounded-full border border-brand-gold/40 flex items-center justify-center hover:bg-brand-gold/10 transition"
              >
                <img src="/icons/mail.png" className="h-5 w-5" alt="Message" />
              </button>
            </div>
          </div>

          <h1 className="text-3xl font-black premium-title mb-1 flex items-center gap-2">
            {creator.name}
            {creator.premium && <img src="/icons/check.png" alt="Premium" className="h-6 w-6" title="Premium creator" />}
          </h1>
          <p className="text-gray-400 text-sm mb-1">{creator.handle} · <span className="text-green-400">Online now</span></p>
          <p className="text-gray-300 mt-3 mb-6">{creator.bio}</p>

          {/* Chat CTA -- opens the real inbox (same as the mail icon above) */}
          <button
            onClick={openInbox}
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

          {/* Marketplace items */}
          {listings.length > 0 && (
            <div className="mt-10">
              <h2 className="text-xl font-black premium-title mb-4">On the Marketplace</h2>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {listings.map((l) => (
                  <a
                    key={l.id}
                    href="/marketplace"
                    className="group aspect-square rounded-lg overflow-hidden relative premium-card border-2 border-brand-gold/40 hover:border-brand-gold transition shadow-luxury"
                  >
                    {l.media?.[0] ? (
                      l.media[0].type === 'video' ? (
                        <video src={l.media[0].src} className="w-full h-full object-cover blur-md scale-110 group-hover:scale-125 transition" muted />
                      ) : (
                        <img src={l.media[0].src} alt="" className="w-full h-full object-cover blur-md scale-110 group-hover:scale-125 transition" />
                      )
                    ) : (
                      <div className="w-full h-full bg-gradient-to-br from-brand-purple/40 to-brand-gold/20" />
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />
                    <img src="/icons/lock.png" className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-6 w-6" alt="" />
                    <div className="absolute bottom-0 left-0 right-0 p-2">
                      <p className="text-xs font-bold text-white truncate">{l.title}</p>
                      <span className="inline-block mt-1 px-2 py-0.5 rounded-full bg-brand-gold text-black text-[11px] font-black">
                        ${(l.priceCents / 100).toFixed(2)}
                      </span>
                    </div>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {inboxOpen && (
        <MessagePanel
          otherUserId={creatorUserId}
          otherName={creator.name}
          otherImg={creator.img}
          onClose={() => setInboxOpen(false)}
        />
      )}
    </>
  );
}

function MessagePanel({ otherUserId, otherName, otherImg, onClose }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const res = await fetch(`/api/messages/with/${otherUserId}`);
      const data = await res.json();
      if (res.ok) setMessages(data.conversation?.messages || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [otherUserId]);

  const send = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setSending(true);
    setError('');
    try {
      const res = await fetch('/api/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toUserId: otherUserId, text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send');
      setMessages(data.conversation.messages);
      setText('');
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm px-4">
      <div className="premium-card w-full max-w-md h-[70vh] sm:h-[560px] flex flex-col overflow-hidden">
        <div className="flex items-center gap-3 p-4 border-b border-brand-gold/20">
          <img src={otherImg} alt={otherName} className="w-9 h-9 rounded-full object-cover object-top" />
          <p className="font-bold text-white flex-1 truncate">{otherName}</p>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading ? (
            <p className="text-gray-500 text-sm text-center">Loading...</p>
          ) : messages.length === 0 ? (
            <p className="text-gray-500 text-sm text-center">Say hi to {otherName} 👋</p>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                className={`max-w-[80%] px-3 py-2 rounded-lg text-sm ${
                  String(m.senderId) === String(otherUserId)
                    ? 'bg-black/40 text-gray-200 mr-auto'
                    : 'bg-brand-gold text-black ml-auto'
                }`}
              >
                {m.text}
              </div>
            ))
          )}
        </div>

        {error && <p className="text-red-400 text-xs px-4">{error}</p>}

        <form onSubmit={send} className="p-3 border-t border-brand-gold/20 flex gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a message..."
            className="flex-1 px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
          />
          <button type="submit" disabled={sending} className="premium-button py-2 px-4 text-sm disabled:opacity-50">
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
