import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import ProtectedMedia from '../../components/ProtectedMedia';
import { getCreators } from '../../lib/creators-store';
import { toPublicCreator, isPubliclyVisible } from '../../lib/creator-status';
import { getVerifiedSessionUserId } from '../../lib/session';
import { findUserByCreatorId } from '../../lib/users-store';
import { getListings } from '../../lib/listings-store';
import { getWallPostsForCreator } from '../../lib/wall-store';
import { isFavorite } from '../../lib/favorites-store';
import { viewerMarkFor } from '../../lib/viewer-mark';
import SiteNav from '../../components/SiteNav';

export async function getServerSideProps({ req, params }) {
  const creators = await getCreators();
  let creator = creators.find((c) => String(c.id) === String(params.id)) || null;
  const viewerId = await getVerifiedSessionUserId(req);
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
  // Computed server-side: the mark is an HMAC and the key never leaves the
  // server. See lib/viewer-mark.js.
  const viewerMark = viewerMarkFor(viewerId);
  return {
    props: {
      creator: toPublicCreator(creator),
      viewerId: viewerId || null,
      viewerMark,
      // Must be re-checked against the post-visibility-check `creator`
      // (null'd out above for a hidden profile), not the original
      // `creatorUser` lookup -- otherwise a pending/suspended/banned
      // creator's real internal account id still reaches the page's
      // __NEXT_DATA__ JSON even while the page itself correctly renders
      // "Creator not found".
      creatorUserId: creator && creatorUser ? String(creatorUser.id) : null,
      listings,
      wallPosts,
      initialFavorited,
    },
  };
}

export default function CreatorProfile({ creator, viewerId, viewerMark, creatorUserId, listings, wallPosts, initialFavorited }) {
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
    setToast(msg || 'Subscriptions arent live yet — you can browse and message for now.');
    setTimeout(() => setToast(null), 3500);
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
      <div className="min-h-screen bg-brand-ink text-white flex items-center justify-center">
        <div className="text-center">
          <p className="text-2xl font-bold text-brand-pink mb-4">Creator not found</p>
          <a href="/creators" className="inline-block px-6 py-3 rounded-full bg-brand-pink text-white font-bold">Back to creators</a>
        </div>
      </div>
    );
  }

  const gallery = Array.isArray(creator.gallery) ? creator.gallery : [];
  const locked = !!creator.locked;
  // Everything below is drawn from what this creator actually has. Counts
  // are their stored values, not invented ones, and a section with nothing
  // real behind it does not render at all rather than showing placeholders.
  const featured = creator.video
    ? { type: 'video', src: creator.video }
    : gallery[0] || { type: 'image', src: creator.img };
  const latestPosts = gallery.slice(0, 4);

  const SOCIAL_BASES = {
    twitter: { label: 'X', base: 'https://x.com/' },
    instagram: { label: 'Instagram', base: 'https://instagram.com/' },
    tiktok: { label: 'TikTok', base: 'https://tiktok.com/@' },
    reddit: { label: 'Reddit', base: 'https://reddit.com/user/' },
  };
  const socialLinks = [
    ...Object.entries(SOCIAL_BASES)
      .filter(([key]) => creator.socials?.[key])
      .map(([key, { label, base }]) => ({ label, href: `${base}${creator.socials[key]}`, display: `@${creator.socials[key]}` })),
    ...(creator.socials?.website
      ? [{ label: 'Web', href: creator.socials.website, display: creator.socials.website.replace(/^https:\/\//, '') }]
      : []),
  ];
  const lockedPreview = gallery.slice(4, 8);
  const socials = creator.socials || {};
  const websiteUrl = socials.website || null;
  const isOwner = !!viewerId && String(viewerId) === String(creatorUserId);

  const TABS = [
    { key: 'posts', label: 'Posts' },
    { key: 'media', label: 'Media' },
    { key: 'marketplace', label: 'Marketplace' },
    { key: 'about', label: 'About' },
  ];

  const Tile = ({ item, badge }) => (
    <div className="relative aspect-square rounded-xl overflow-hidden bg-white/5 border border-white/5">
      {/* A blurred (locked) tile carries no mark -- there is nothing
          identifiable to leak, and a watermark over a blur is just noise. */}
      <ProtectedMedia
        src={item?.src || creator.img}
        type={item?.type === 'video' ? 'video' : 'image'}
        mark={locked ? '' : viewerMark}
        className={`w-full h-full object-cover ${locked ? 'blur-xl scale-110' : ''}`}
      />
      {locked && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/25">
          <span className="w-10 h-10 rounded-full bg-black/60 flex items-center justify-center text-lg">🔒</span>
        </div>
      )}
      {item?.aiGenerated && (
        <span className="absolute top-2 left-2 text-[10px] px-1.5 py-0.5 rounded bg-black/70 text-brand-pink font-bold">AI</span>
      )}
      {badge && (
        <span className="absolute bottom-2 left-2 text-[11px] px-2 py-0.5 rounded bg-black/70 text-white font-semibold">{badge}</span>
      )}
    </div>
  );

  return (
    <>
      <Head>
        <title>{creator.name} — {creator.handle}</title>
      </Head>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] px-6 py-3 rounded-full bg-brand-pink text-white font-bold shadow-lg">
          {toast}
        </div>
      )}

      <div className="min-h-screen bg-brand-ink text-white pb-20">
        <SiteNav signedIn={!!viewerId} />

        <main className="max-w-6xl mx-auto px-4 md:px-6">
          {/* Cover */}
          <div className="relative mt-4 h-44 sm:h-56 md:h-64 rounded-2xl overflow-hidden bg-white/5">
            {creator.video ? (
              <video src={creator.video} autoPlay loop muted playsInline className="w-full h-full object-cover blur-sm scale-105" />
            ) : (
              <img src={creator.img} alt="" className="w-full h-full object-cover blur-sm scale-105" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-brand-ink via-brand-ink/30 to-transparent" />
            <button
              onClick={() => router.push('/creators')}
              aria-label="Back to creators"
              className="absolute top-4 left-4 w-9 h-9 rounded-full bg-black/50 backdrop-blur flex items-center justify-center hover:bg-black/70 transition"
            >
              ←
            </button>
          </div>

          {/* Identity row */}
          <div className="relative px-1 sm:px-4">
            <div className="flex flex-col sm:flex-row sm:items-end gap-4 -mt-14 sm:-mt-16">
              <div className="w-28 h-28 sm:w-36 sm:h-36 rounded-full border-4 border-brand-ink overflow-hidden bg-white/10 shrink-0">
                <img src={creator.img} alt={creator.name} className="w-full h-full object-cover object-top" />
              </div>

              <div className="flex-1 sm:pb-2">
                <h1 className="text-3xl font-black flex items-center gap-2 flex-wrap">
                  {creator.name}
                  {creator.premium && (
                    <img src="/icons/check.png" alt="Verified" title="Verified creator" className="h-6 w-6" />
                  )}
                  {creator.founding && (
                    <span
                      title="One of the first 100 creators on OnlyOne"
                      className="inline-flex items-center gap-1.5 text-[10px] tracking-[0.15em] pl-1 pr-2.5 py-1 rounded-full bg-brand-pink text-white font-black align-middle"
                    >
                      <img src="/images/badges/founding-64.png" alt="" className="h-4 w-4" />
                      FOUNDING CREATOR
                    </span>
                  )}
                </h1>
                <p className="text-gray-400 text-sm">{creator.handle}</p>
                {(creator.age || creator.location) && (
                  <p className="text-gray-500 text-xs mt-1 flex items-center gap-2">
                    {creator.age && <span>{creator.age}</span>}
                    {creator.age && creator.location && <span aria-hidden="true">·</span>}
                    {creator.location && <span>📍 {creator.location}</span>}
                  </p>
                )}
                {creator.bio && <p className="text-gray-300 text-sm mt-1 line-clamp-1">{creator.bio}</p>}
              </div>

              <div className="flex items-center gap-2 sm:pb-2">
                <button
                  onClick={toggleFavorite}
                  aria-pressed={favorited}
                  title={favorited ? 'Remove from saved' : 'Save creator'}
                  className={`w-11 h-11 rounded-full border flex items-center justify-center text-lg transition ${
                    favorited ? 'border-brand-pink bg-brand-pink/20 text-brand-pink' : 'border-white/15 text-white/70 hover:border-brand-pink/60'
                  }`}
                >
                  {favorited ? '♥' : '♡'}
                </button>
                <button
                  onClick={openInbox}
                  className="px-5 h-11 rounded-full border border-white/15 font-semibold text-sm hover:border-white/40 transition"
                >
                  Message
                </button>
                <button
                  onClick={() => showComingSoon('Tipping opens when payments do.')}
                  className="px-5 h-11 rounded-full border border-white/15 font-semibold text-sm hover:border-brand-pink/60 transition"
                >
                  Send a Tip
                </button>
                <button
                  onClick={() => showComingSoon()}
                  className="px-6 h-11 rounded-full bg-brand-pink hover:bg-brand-pink-dark text-white font-bold text-sm transition"
                >
                  Subscribe
                </button>
              </div>
            </div>
          </div>

          {/* Body */}
          <div className="grid lg:grid-cols-[300px_1fr] gap-6 mt-8 px-1 sm:px-4">
            {/* Sidebar */}
            <aside className="space-y-5">
              <div className="flex gap-6">
                <div><p className="text-xl font-black">{creator.posts}</p><p className="text-xs text-gray-500">Posts</p></div>
                <div><p className="text-xl font-black">{creator.subs}</p><p className="text-xs text-gray-500">Followers</p></div>
                <div><p className="text-xl font-black">{creator.likes}</p><p className="text-xs text-gray-500">Likes</p></div>
              </div>

              {creator.bio && <p className="text-sm text-gray-300 whitespace-pre-wrap">{creator.bio}</p>}

              {creator.location && (
                <p className="text-sm text-gray-400 flex items-center gap-2">📍 {creator.location}</p>
              )}
              {websiteUrl && (
                <a href={websiteUrl} target="_blank" rel="noopener noreferrer"
                   className="text-sm text-brand-pink hover:underline break-all flex items-center gap-2">
                  🔗 {websiteUrl.replace(/^https?:\/\//, '')}
                </a>
              )}

              {Array.isArray(creator.tags) && creator.tags.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {creator.tags.map((tag) => (
                    <a key={tag} href={`/search?tag=${encodeURIComponent(tag)}`}
                       className="text-xs px-3 py-1 rounded-full bg-white/5 border border-white/10 text-gray-300 hover:border-brand-pink/50 hover:text-brand-pink transition">
                      #{tag}
                    </a>
                  ))}
                </div>
              )}

              {listings.length > 0 && (
                <button
                  onClick={() => setActiveTab('marketplace')}
                  className="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-white/5 border border-white/10 hover:border-brand-pink/50 transition text-sm font-semibold"
                >
                  <span>Visit my Marketplace</span>
                  <span className="text-brand-pink">›</span>
                </button>
              )}

              <div className="rounded-xl border border-white/10 bg-brand-card p-5">
                <p className="font-bold mb-1">Subscribe to {creator.name}</p>
                <p className="text-xs text-gray-400 mb-4">Get exclusive content and direct messaging.</p>
                <p className="text-2xl font-black mb-4">
                  {locked ? creator.price : 'Free'}
                  {locked && <span className="text-sm font-normal text-gray-400"> / month</span>}
                </p>
                <button onClick={() => showComingSoon()} className="w-full py-3 rounded-full bg-brand-pink hover:bg-brand-pink-dark text-white font-bold transition">
                  Subscribe
                </button>
                {/* Stated plainly rather than implied: there is no payment
                    processing on this site yet, so a Subscribe button that
                    looked functional would be a promise it cannot keep. */}
                <p className="text-[11px] text-gray-500 mt-3">
                  Subscriptions aren&apos;t live yet. Browsing, saving and messaging all work today.
                </p>
                <ul className="mt-4 space-y-2 text-sm text-gray-300">
                  {['Exclusive photos & videos', 'Direct messaging', 'Early access to new content'].map((f) => (
                    <li key={f} className="flex items-center gap-2"><span className="text-brand-pink">✓</span>{f}</li>
                  ))}
                </ul>
              </div>
            </aside>

            {/* Main column */}
            <section>
              <div className="flex gap-6 border-b border-white/10 mb-6 overflow-x-auto">
                {TABS.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setActiveTab(t.key)}
                    className={`pb-3 text-sm font-semibold whitespace-nowrap transition ${
                      activeTab === t.key ? 'text-white border-b-2 border-brand-pink' : 'text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {activeTab === 'posts' && (
                <div className="space-y-8">
                  <div className="grid md:grid-cols-[1.6fr_1fr] gap-4">
                    <div className="relative rounded-xl overflow-hidden bg-white/5 border border-white/5 aspect-video">
                      {featured.type === 'video' ? (
                        <video src={featured.src} muted loop playsInline autoPlay className={`w-full h-full object-cover ${locked ? 'blur-xl scale-110' : ''}`} />
                      ) : (
                        <img src={featured.src} alt="" className={`w-full h-full object-cover ${locked ? 'blur-xl scale-110' : ''}`} />
                      )}
                      {locked && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/40">
                          <span className="w-12 h-12 rounded-full bg-black/60 flex items-center justify-center text-xl">🔒</span>
                          <p className="font-semibold">Subscribe to unlock</p>
                          <button onClick={() => showComingSoon()} className="px-5 py-2 rounded-full bg-brand-pink hover:bg-brand-pink-dark text-white text-sm font-bold transition">
                            Subscribe Now
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="rounded-xl border border-white/10 bg-brand-card p-4 flex flex-col">
                      <p className="font-bold mb-1">{creator.name}&apos;s Marketplace</p>
                      <p className="text-xs text-gray-400 mb-3">
                        {listings.length > 0
                          ? `${listings.length} item${listings.length === 1 ? '' : 's'} available to buy.`
                          : 'Nothing listed yet.'}
                      </p>
                      {listings[0]?.media?.[0] && (
                        <div className="relative rounded-lg overflow-hidden aspect-[4/3] mb-3">
                          <img src={listings[0].media[0].src} alt="" className="w-full h-full object-cover blur-lg scale-110" />
                          <span className="absolute inset-0 flex items-center justify-center text-lg">🔒</span>
                        </div>
                      )}
                      <button
                        onClick={() => setActiveTab('marketplace')}
                        disabled={listings.length === 0}
                        className="mt-auto w-full py-2.5 rounded-full border border-white/15 text-sm font-semibold hover:border-brand-pink/60 transition disabled:opacity-40 disabled:hover:border-white/15"
                      >
                        Browse Marketplace →
                      </button>
                    </div>
                  </div>

                  {latestPosts.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <h2 className="font-bold">Latest Posts</h2>
                        <button onClick={() => setActiveTab('media')} className="text-xs text-brand-pink hover:underline">View all</button>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        {latestPosts.map((item, i) => (
                          <Tile key={i} item={item} badge={item.type === 'video' ? 'Video' : null} />
                        ))}
                      </div>
                    </div>
                  )}

                  {lockedPreview.length > 0 && (
                    <div>
                      <h2 className="font-bold mb-3">Locked Content Preview</h2>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        {lockedPreview.map((item, i) => (
                          <Tile key={i} item={item} />
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="rounded-xl border border-white/10 bg-brand-card p-4">
                      <div className="flex items-center justify-between mb-3">
                        <h2 className="font-bold">Fan Messages</h2>
                        <button onClick={() => setActiveTab('about')} className="text-xs text-brand-pink hover:underline">About</button>
                      </div>
                      <Wall creatorId={creator.id} viewerId={viewerId} initialPosts={wallPosts} isWallOwner={isOwner} />
                    </div>

                    <div className="rounded-xl border border-white/10 bg-brand-card p-4">
                      <h2 className="font-bold mb-3">About {creator.name}</h2>
                      <ul className="space-y-2 text-sm text-gray-300">
                        {creator.age && <li>🎂 {creator.age}</li>}
                        {creator.location && <li>📍 {creator.location}</li>}
                        <li>🎬 {creator.media} media items</li>
                        <li>❤️ {creator.likes} likes</li>
                        <li>👥 {creator.subs} followers</li>
                        {Array.isArray(creator.tags) && creator.tags.length > 0 && <li>🏷️ {creator.tags.join(', ')}</li>}
                      </ul>
                    </div>

                    {/* Links. Handles are stored bare and the href is built
                        from a fixed base in sanitizeSocials, so a pasted
                        "javascript:" string can never become a live link. */}
                    {socialLinks.length > 0 && (
                      <div className="rounded-xl border border-white/10 bg-brand-card p-4">
                        <h2 className="font-bold mb-3">Links</h2>
                        <ul className="space-y-2 text-sm">
                          {socialLinks.map((l) => (
                            <li key={l.label}>
                              <a
                                href={l.href}
                                target="_blank"
                                rel="noopener noreferrer nofollow"
                                className="text-gray-300 hover:text-brand-pink transition inline-flex items-center gap-2"
                              >
                                <span className="text-gray-500">{l.label}</span>
                                <span className="truncate">{l.display}</span>
                              </a>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeTab === 'media' && (
                gallery.length === 0 ? (
                  <p className="text-sm text-gray-500">No media yet.</p>
                ) : (
                  <>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                      {gallery.map((item, i) => <Tile key={i} item={item} />)}
                    </div>
                    {/* The mark deters because the viewer knows it is there.
                        An invisible one only helps after the fact. */}
                    {viewerMark && (
                      <p className="mt-4 text-[11px] text-gray-500 text-center">
                        Content on this page is watermarked to your account. Sharing it outside OnlyOne is
                        traceable back to you and is grounds for losing access.
                      </p>
                    )}
                  </>
                )
              )}

              {activeTab === 'marketplace' && (
                listings.length === 0 ? (
                  <p className="text-sm text-gray-500">Nothing listed yet.</p>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {listings.map((l) => (
                      <a key={l.id} href="/marketplace"
                         className="group relative aspect-square rounded-xl overflow-hidden border border-white/10 hover:border-brand-pink/60 transition">
                        {l.media?.[0] ? (
                          l.media[0].type === 'video' ? (
                            <video src={l.media[0].src} muted className="w-full h-full object-cover blur-lg scale-110" />
                          ) : (
                            <img src={l.media[0].src} alt="" className="w-full h-full object-cover blur-lg scale-110" />
                          )
                        ) : (
                          <div className="w-full h-full bg-gradient-pink opacity-30" />
                        )}
                        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-transparent" />
                        <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-lg">🔒</span>
                        {l.aiGenerated && (
                          <span className="absolute top-2 left-2 text-[10px] px-1.5 py-0.5 rounded bg-black/70 text-brand-pink font-bold">AI</span>
                        )}
                        <div className="absolute bottom-0 left-0 right-0 p-2">
                          <p className="text-xs font-bold truncate">{l.title}</p>
                          <span className="inline-block mt-1 px-2 py-0.5 rounded-full bg-brand-pink text-white text-[11px] font-black">
                            ${(l.priceCents / 100).toFixed(2)}
                          </span>
                        </div>
                      </a>
                    ))}
                  </div>
                )
              )}

              {activeTab === 'about' && (
                <div className="space-y-4 max-w-xl">
                  {creator.bio && <p className="text-sm text-gray-300 whitespace-pre-wrap">{creator.bio}</p>}
                  <ul className="space-y-2 text-sm text-gray-300">
                    {creator.location && <li>📍 {creator.location}</li>}
                    <li>📝 {creator.posts} posts</li>
                    <li>🎬 {creator.media} media items</li>
                    <li>👥 {creator.subs} followers</li>
                    <li>❤️ {creator.likes} likes</li>
                  </ul>
                  {Object.values(socials).some(Boolean) && (
                    <div className="flex flex-wrap gap-2 pt-2">
                      {socials.twitter && <a href={`https://x.com/${socials.twitter}`} target="_blank" rel="noopener noreferrer" className="text-xs px-3 py-1.5 rounded-full border border-white/15 text-gray-300 hover:border-brand-pink/60 hover:text-brand-pink transition">X/Twitter</a>}
                      {socials.instagram && <a href={`https://instagram.com/${socials.instagram}`} target="_blank" rel="noopener noreferrer" className="text-xs px-3 py-1.5 rounded-full border border-white/15 text-gray-300 hover:border-brand-pink/60 hover:text-brand-pink transition">Instagram</a>}
                      {socials.tiktok && <a href={`https://tiktok.com/@${socials.tiktok}`} target="_blank" rel="noopener noreferrer" className="text-xs px-3 py-1.5 rounded-full border border-white/15 text-gray-300 hover:border-brand-pink/60 hover:text-brand-pink transition">TikTok</a>}
                      {socials.reddit && <a href={`https://reddit.com/u/${socials.reddit}`} target="_blank" rel="noopener noreferrer" className="text-xs px-3 py-1.5 rounded-full border border-white/15 text-gray-300 hover:border-brand-pink/60 hover:text-brand-pink transition">Reddit</a>}
                      {websiteUrl && <a href={websiteUrl} target="_blank" rel="noopener noreferrer" className="text-xs px-3 py-1.5 rounded-full border border-white/15 text-gray-300 hover:border-brand-pink/60 hover:text-brand-pink transition">Website</a>}
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        </main>
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
      <div className="rounded-xl border border-white/10 bg-brand-card w-full max-w-md h-[70vh] sm:h-[560px] flex flex-col overflow-hidden">
        <div className="flex items-center gap-3 p-4 border-b border-white/10">
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
                    : 'bg-brand-pink text-black ml-auto'
                }`}
              >
                {m.text}
              </div>
            ))
          )}
        </div>

        {error && <p className="text-red-400 text-xs px-4">{error}</p>}

        <form onSubmit={send} className="p-3 border-t border-white/10 flex gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a message..."
            className="flex-1 px-3 py-2 rounded-md bg-black/40 border border-white/10 text-white text-sm"
          />
          <button type="submit" disabled={sending} className="px-6 py-2 rounded-full bg-brand-pink hover:bg-brand-pink-dark text-white font-bold transition py-2 px-4 text-sm disabled:opacity-50">
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
          <form onSubmit={submitReport} className="rounded-xl border border-white/10 bg-brand-card w-full max-w-sm p-6">
            <p className="font-bold text-white mb-1">Report this comment</p>
            <p className="text-xs text-gray-500 mb-4">Tell us what's wrong with it.</p>
            <textarea
              value={reportReason}
              onChange={(e) => setReportReason(e.target.value)}
              rows={3}
              placeholder="Reason..."
              className="w-full px-3 py-2 rounded-md bg-black/40 border border-white/10 text-white text-sm mb-4"
            />
            <div className="flex gap-2">
              <button type="button" onClick={() => setReporting(null)} className="flex-1 text-sm px-4 py-2 rounded-md border border-white/10 text-gray-300 hover:bg-white/5 transition">
                Cancel
              </button>
              <button type="submit" disabled={reportSending} className="flex-1 px-6 py-2 rounded-full bg-brand-pink hover:bg-brand-pink-dark text-white font-bold transition text-sm disabled:opacity-50">
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
          className="w-full px-4 py-3 rounded-md bg-black/40 border border-white/10 text-white text-sm mb-2"
        />
        {error && <p className="text-xs text-red-400 mb-2">{error}</p>}
        <button type="submit" disabled={sending} className="px-6 py-2 rounded-full bg-brand-pink hover:bg-brand-pink-dark text-white font-bold transition text-sm px-6 disabled:opacity-50">
          Post
        </button>
      </form>

      {posts.length === 0 ? (
        <p className="text-sm text-gray-500">No one's posted here yet — be the first.</p>
      ) : (
        <div className="space-y-3">
          {posts.map((p) => (
            <div key={p.id} className="rounded-xl border border-white/10 bg-brand-card border border-white/10 p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-bold text-brand-pink">{p.authorName}</p>
                  <p className="text-sm text-gray-300 mt-1 whitespace-pre-wrap break-words">{p.text}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {viewerId && String(viewerId) !== String(p.authorId) && (
                    <button onClick={() => setReporting(p)} className="text-xs text-gray-600 hover:text-brand-pink transition" title="Report">
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
