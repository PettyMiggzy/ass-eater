import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { getCreators, toPublicCreator, isPubliclyVisible } from '../../lib/creators-store';
import { getSessionUserId } from '../../lib/session';
import { findUserByCreatorId } from '../../lib/users-store';
import { getListings } from '../../lib/listings-store';
import { getWallPostsForCreator } from '../../lib/wall-store';
import { isFavorite } from '../../lib/favorites-store';

export async function getServerSideProps({ req, params }) {
  const creators = await getCreators();
  let creator = creators.find((c) => String(c.id) === String(params.id)) || null;
  const viewerId = getSessionUserId(req);
  const creatorUser = creator ? await findUserByCreatorId(creator.id) : null;

  // Pending applicants, suspended, and banned creators aren't public --
  // only the account owner (once they've claimed a login) can preview
  // their own pending/suspended profile; a banned creator is hidden even
  // from themselves.
  if (creator && !isPubliclyVisible(creator)) {
    const isOwner = String(viewerId) === String(creatorUser?.id);
    if (creator.status === 'banned' || !isOwner) creator = null;
  }

  const allListings = creator ? await getListings() : [];
  const listings = allListings
    .filter((l) => String(l.creatorId) === String(creator?.id) && l.status === 'active')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const wallPosts = creator ? await getWallPostsForCreator(creator.id) : [];
  const initialFavorited = creator && viewerId ? await isFavorite(viewerId, creator.id) : false;
  return {
    props: {
      creator: toPublicCreator(creator),
      viewerId: viewerId || null,
      creatorUserId: creatorUser ? String(creatorUser.id) : null,
      listings,
      wallPosts,
      initialFavorited,
    },
  };
}

export default function CreatorProfile({ creator, viewerId, creatorUserId, listings, wallPosts, initialFavorited }) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState('posts');
  const [toast, setToast] = useState(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [favorited, setFavorited] = useState(initialFavorited);
  const [favoriteBusy, setFavoriteBusy] = useState(false);

  const toggleFavorite = async () => {
    if (!viewerId) {
      router.push(`/login?next=/creator/${creator.id}`);
      return;
    }
    if (favoriteBusy) return;
    setFavoriteBusy(true);
    const prev = favorited;
    setFavorited(!prev); // optimistic -- flip back on failure
    try {
      const res = await fetch('/api/favorites/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creatorId: creator.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      setFavorited(data.favorited);
    } catch (err) {
      setFavorited(prev);
      setToast(err.message);
      setTimeout(() => setToast(null), 3000);
    } finally {
      setFavoriteBusy(false);
    }
  };

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
                onClick={toggleFavorite}
                title={favorited ? 'Remove from favorites' : 'Save to favorites'}
                aria-pressed={favorited}
                className={`w-11 h-11 rounded-full border flex items-center justify-center transition ${
                  favorited ? 'border-brand-gold bg-brand-gold/20' : 'border-brand-gold/40 hover:bg-brand-gold/10'
                }`}
              >
                <span className={favorited ? 'text-brand-gold text-xl' : 'text-white/70 text-xl'}>{favorited ? '♥' : '♡'}</span>
              </button>
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
          <p className="text-gray-300 mt-3 mb-3">{creator.bio}</p>

          {Array.isArray(creator.tags) && creator.tags.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {creator.tags.map((tag) => (
                <a
                  key={tag}
                  href={`/search?tag=${encodeURIComponent(tag)}`}
                  className="text-xs px-3 py-1 rounded-full bg-brand-purple/15 border border-brand-purple/30 text-brand-gold hover:bg-brand-purple/30 transition"
                >
                  #{tag}
                </a>
              ))}
            </div>
          )}

          {creator.socials && Object.values(creator.socials).some(Boolean) && (
            <div className="flex flex-wrap gap-2 mb-6">
              {creator.socials.twitter && (
                <a href={`https://x.com/${creator.socials.twitter}`} target="_blank" rel="noopener noreferrer" className="text-xs px-3 py-1.5 rounded-full border border-brand-purple/30 text-gray-300 hover:border-brand-gold hover:text-brand-gold transition">
                  X/Twitter
                </a>
              )}
              {creator.socials.instagram && (
                <a href={`https://instagram.com/${creator.socials.instagram}`} target="_blank" rel="noopener noreferrer" className="text-xs px-3 py-1.5 rounded-full border border-brand-purple/30 text-gray-300 hover:border-brand-gold hover:text-brand-gold transition">
                  Instagram
                </a>
              )}
              {creator.socials.tiktok && (
                <a href={`https://tiktok.com/@${creator.socials.tiktok}`} target="_blank" rel="noopener noreferrer" className="text-xs px-3 py-1.5 rounded-full border border-brand-purple/30 text-gray-300 hover:border-brand-gold hover:text-brand-gold transition">
                  TikTok
                </a>
              )}
              {creator.socials.reddit && (
                <a href={`https://reddit.com/u/${creator.socials.reddit}`} target="_blank" rel="noopener noreferrer" className="text-xs px-3 py-1.5 rounded-full border border-brand-purple/30 text-gray-300 hover:border-brand-gold hover:text-brand-gold transition">
                  Reddit
                </a>
              )}
              {creator.socials.website && (
                <a href={creator.socials.website} target="_blank" rel="noopener noreferrer" className="text-xs px-3 py-1.5 rounded-full border border-brand-purple/30 text-gray-300 hover:border-brand-gold hover:text-brand-gold transition">
                  Website
                </a>
              )}
            </div>
          )}

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
            <button
              onClick={() => setActiveTab('wall')}
              className={`pb-3 font-bold text-sm ${activeTab === 'wall' ? 'text-brand-gold border-b-2 border-brand-gold' : 'text-gray-500'}`}
            >
              WALL
            </button>
          </div>

          {activeTab === 'wall' ? (
            <Wall creatorId={creator.id} viewerId={viewerId} initialPosts={wallPosts} isWallOwner={!!viewerId && String(viewerId) === String(creatorUserId)} />
          ) : (
            <>
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
                      {item.aiGenerated && (
                        <span className="absolute bottom-1 left-1 text-[10px] px-1.5 py-0.5 rounded bg-black/70 text-brand-gold font-bold">AI</span>
                      )}
                    </div>
                  ));
                })()}
              </div>
            </>
          )}

          {/* Marketplace items */}
          {activeTab !== 'wall' && listings.length > 0 && (
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
                    {l.aiGenerated && (
                      <span className="absolute top-1 left-1 text-[10px] px-1.5 py-0.5 rounded bg-black/70 text-brand-gold font-bold">AI</span>
                    )}
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

function Wall({ creatorId, viewerId, initialPosts, isWallOwner }) {
  const router = useRouter();
  const [posts, setPosts] = useState(initialPosts);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [reporting, setReporting] = useState(null);
  const [reportReason, setReportReason] = useState('');
  const [reportSending, setReportSending] = useState(false);

  const submitReport = async (e) => {
    e.preventDefault();
    if (!reportReason.trim()) return;
    setReportSending(true);
    try {
      const res = await fetch('/api/wall/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: reporting.id, reason: reportReason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to report');
      setReporting(null);
      setReportReason('');
    } catch (err) {
      setError(err.message);
    } finally {
      setReportSending(false);
    }
  };

  const refresh = async () => {
    const res = await fetch(`/api/wall/list?creatorId=${creatorId}`);
    const data = await res.json();
    if (res.ok) setPosts(data.posts);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!viewerId) {
      router.push(`/login?next=/creator/${creatorId}`);
      return;
    }
    if (!text.trim()) return;
    setSending(true);
    setError('');
    try {
      const res = await fetch('/api/wall/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creatorId, text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to post');
      setText('');
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  const remove = async (id) => {
    try {
      const res = await fetch('/api/wall/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (res.ok) setPosts(posts.filter((p) => String(p.id) !== String(id)));
    } catch {
      // best-effort -- the post stays visible if the delete failed, no toast needed for this
    }
  };

  return (
    <div>
      {reporting && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
          <form onSubmit={submitReport} className="premium-card w-full max-w-sm p-6">
            <p className="font-bold text-white mb-1">Report this comment</p>
            <p className="text-xs text-gray-500 mb-4">Tell us what's wrong with it.</p>
            <textarea
              value={reportReason}
              onChange={(e) => setReportReason(e.target.value)}
              rows={3}
              placeholder="Reason..."
              className="w-full px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm mb-4"
            />
            <div className="flex gap-2">
              <button type="button" onClick={() => setReporting(null)} className="flex-1 text-sm px-4 py-2 rounded-md border border-brand-purple/30 text-gray-300 hover:bg-white/5 transition">
                Cancel
              </button>
              <button type="submit" disabled={reportSending} className="flex-1 premium-button text-sm disabled:opacity-50">
                Submit
              </button>
            </div>
          </form>
        </div>
      )}

      <form onSubmit={submit} className="mb-6">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={viewerId ? 'Say something on their wall...' : 'Log in to post on the wall'}
          rows={2}
          maxLength={500}
          className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm mb-2"
        />
        {error && <p className="text-xs text-red-400 mb-2">{error}</p>}
        <button type="submit" disabled={sending} className="premium-button text-sm px-6 disabled:opacity-50">
          Post
        </button>
      </form>

      {posts.length === 0 ? (
        <p className="text-sm text-gray-500">No one's posted here yet — be the first.</p>
      ) : (
        <div className="space-y-3">
          {posts.map((p) => (
            <div key={p.id} className="premium-card border border-brand-purple/20 p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-bold text-brand-gold">{p.authorName}</p>
                  <p className="text-sm text-gray-300 mt-1 whitespace-pre-wrap break-words">{p.text}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {viewerId && String(viewerId) !== String(p.authorId) && (
                    <button onClick={() => setReporting(p)} className="text-xs text-gray-600 hover:text-brand-gold transition" title="Report">
                      ⚑
                    </button>
                  )}
                  {(isWallOwner || String(viewerId) === String(p.authorId)) && (
                    <button onClick={() => remove(p.id)} className="text-xs text-gray-500 hover:text-red-400 transition" title="Delete">
                      ✕
                    </button>
                  )}
                </div>
              </div>
              <p className="text-[10px] text-gray-600 mt-2">{new Date(p.createdAt).toLocaleDateString()}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
