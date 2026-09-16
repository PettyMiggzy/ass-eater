import { useState, useEffect } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { getSessionUserId } from '../lib/session';
import { findUserById, publicUser } from '../lib/users-store';
import { getCreators } from '../lib/creators-store';
import { getListings } from '../lib/listings-store';

export async function getServerSideProps({ req }) {
  const uid = getSessionUserId(req);
  if (!uid) {
    return { redirect: { destination: '/login', permanent: false } };
  }
  const user = await findUserById(uid);
  if (!user) {
    return { redirect: { destination: '/login', permanent: false } };
  }

  let creator = null;
  let listings = [];
  if (user.role === 'creator' && user.creatorId) {
    const creators = await getCreators();
    creator = creators.find((c) => String(c.id) === String(user.creatorId)) || null;
    const allListings = await getListings();
    listings = allListings
      .filter((l) => String(l.creatorId) === String(user.creatorId))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  return { props: { user: publicUser(user), creator, listings } };
}

export default function Dashboard({ user, creator: initialCreator, listings: initialListings }) {
  const router = useRouter();
  const [creator, setCreator] = useState(initialCreator);
  const [listings, setListings] = useState(initialListings || []);
  const [draft, setDraft] = useState({
    name: initialCreator?.name || '',
    handle: initialCreator?.handle || '',
    bio: initialCreator?.bio || '',
    price: initialCreator?.price || '',
    payoutMethod: initialCreator?.payoutMethod || 'onlyass',
    walletAddress: initialCreator?.walletAddress || '',
    socials: {
      twitter: initialCreator?.socials?.twitter || '',
      instagram: initialCreator?.socials?.instagram || '',
      tiktok: initialCreator?.socials?.tiktok || '',
      reddit: initialCreator?.socials?.reddit || '',
      website: initialCreator?.socials?.website || '',
    },
  });
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/');
  };

  const saveProfile = async () => {
    setBusy(true);
    setStatus('Saving...');
    try {
      const res = await fetch('/api/me/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { ...draft, img: creator.img } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setCreator(data.creator);
      setStatus('Saved.');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const uploadAvatar = async (file) => {
    if (!file) return;
    setBusy(true);
    setStatus('Uploading avatar...');
    try {
      const res = await fetch('/api/me/avatar', {
        method: 'POST',
        headers: { 'x-file-name': file.name, 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setCreator(data.creator);
      setStatus('Avatar updated.');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const uploadContent = async (file) => {
    if (!file) return;
    setBusy(true);
    setStatus('Uploading content...');
    try {
      const res = await fetch('/api/me/upload', {
        method: 'POST',
        headers: {
          'x-file-name': file.name,
          'x-file-type': file.type.startsWith('video') ? 'video' : 'image',
          'x-current-gallery': JSON.stringify(creator.gallery || []),
          'Content-Type': file.type || 'application/octet-stream',
        },
        body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setCreator(data.creator);
      setStatus('Content added.');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const deleteItem = async (index) => {
    setBusy(true);
    setStatus('Removing...');
    try {
      const res = await fetch('/api/me/gallery-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      setCreator(data.creator);
      setStatus('Removed.');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const createListing = async (fields) => {
    setBusy(true);
    setStatus('Creating listing...');
    try {
      const res = await fetch('/api/marketplace/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create listing');
      setListings([data.listing, ...listings]);
      setStatus('Listing created — add photos/video below.');
      return data.listing;
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const uploadListingMedia = async (listingId, file) => {
    if (!file) return;
    const listing = listings.find((l) => l.id === listingId);
    setBusy(true);
    setStatus('Uploading...');
    try {
      const res = await fetch('/api/marketplace/upload', {
        method: 'POST',
        headers: {
          'x-listing-id': String(listingId),
          'x-file-name': file.name,
          'x-file-type': file.type.startsWith('video') ? 'video' : 'image',
          'x-current-media': JSON.stringify(listing?.media || []),
          'Content-Type': file.type || 'application/octet-stream',
        },
        body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setListings(listings.map((l) => (l.id === listingId ? data.listing : l)));
      setStatus('Media added.');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleListingStatus = async (listingId, status) => {
    setBusy(true);
    try {
      const res = await fetch('/api/marketplace/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listingId, fields: { status } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Update failed');
      setListings(listings.map((l) => (l.id === listingId ? data.listing : l)));
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Head><title>Dashboard - Only Ass</title></Head>
      <div className="min-h-screen bg-gradient-luxury text-white px-6 py-10">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center justify-between mb-8">
            <h1 className="text-3xl font-black premium-title">
              {user.role === 'creator' ? 'Creator Dashboard' : 'Your Account'}
            </h1>
            <button onClick={logout} className="text-sm px-4 py-2 rounded-md border border-brand-purple/30 text-gray-300 hover:bg-white/5 transition">
              Log Out
            </button>
          </div>

          {status && (
            <div className="mb-6 px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-brand-secondary text-sm">
              {status}
            </div>
          )}

          <Inbox currentUserId={user.id} />

          {user.role !== 'creator' && (
            <div className="premium-card p-8">
              <p className="text-gray-300 mb-2">Logged in as <span className="text-brand-gold font-bold">{user.email}</span></p>
              <p className="text-gray-400 text-sm mb-6">
                You're set up as a fan. Head to the platform to browse creators and unlock content with $ONLYASS.
              </p>
              <a href="/onlyass" className="premium-button inline-block">Browse Creators</a>
            </div>
          )}

          {user.role === 'creator' && creator && (
            <div className="premium-card p-6 space-y-6">
              {creator.status === 'pending' && (
                <div className="px-4 py-3 rounded-md bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 text-sm">
                  Your profile is pending review and not yet visible on the platform. Build it out below — our team will verify and publish it soon.
                </div>
              )}

              <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-md bg-black/30 border border-brand-purple/20">
                <div className="min-w-0">
                  <p className="text-xs text-gray-500 mb-1">Your shareable profile link</p>
                  <p className="text-sm text-gray-300 truncate font-mono">
                    {typeof window !== 'undefined' ? `${window.location.origin}/creator/${creator.id}` : `/creator/${creator.id}`}
                  </p>
                </div>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(`${window.location.origin}/creator/${creator.id}`);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                  className="shrink-0 text-xs px-4 py-2 rounded-md border border-brand-gold/40 text-brand-gold hover:bg-brand-gold/10 transition"
                >
                  {copied ? 'Copied!' : 'Copy Link'}
                </button>
              </div>

              <div className="flex items-center gap-4">
                <img src={creator.img} alt={creator.name} className="w-20 h-20 rounded-full object-cover object-top border-2 border-brand-gold" />
                <div>
                  <p className="font-bold text-white flex items-center gap-1 mb-2">
                    {creator.name}
                    {creator.premium && <img src="/icons/check.png" alt="Premium" className="h-4 w-4" title="Premium" />}
                  </p>
                  <label className="premium-button inline-block cursor-pointer text-sm py-2 px-4">
                    Change PFP
                    <input type="file" accept="image/*" className="hidden" onChange={(e) => uploadAvatar(e.target.files[0])} />
                  </label>
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Display Name</label>
                  <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Handle</label>
                  <input value={draft.handle} onChange={(e) => setDraft({ ...draft, handle: e.target.value })} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Subscription Price</label>
                  <input value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
                </div>
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-2">Bio</label>
                <textarea value={draft.bio} onChange={(e) => setDraft({ ...draft, bio: e.target.value })} rows={3} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-2">Socials (shown on your profile — just your username, no login needed)</label>
                <div className="grid sm:grid-cols-2 gap-3">
                  {[
                    ['twitter', 'X / Twitter username'],
                    ['instagram', 'Instagram username'],
                    ['tiktok', 'TikTok username'],
                    ['reddit', 'Reddit username'],
                  ].map(([key, placeholder]) => (
                    <input
                      key={key}
                      value={draft.socials[key]}
                      onChange={(e) => setDraft({ ...draft, socials: { ...draft.socials, [key]: e.target.value } })}
                      placeholder={placeholder}
                      className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
                    />
                  ))}
                </div>
                <input
                  value={draft.socials.website}
                  onChange={(e) => setDraft({ ...draft, socials: { ...draft.socials, website: e.target.value } })}
                  placeholder="Website (https://...)"
                  className="w-full mt-3 px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
                />
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Get Paid In</label>
                  <select
                    value={draft.payoutMethod}
                    onChange={(e) => setDraft({ ...draft, payoutMethod: e.target.value })}
                    className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white"
                  >
                    <option value="onlyass">$ONLYASS</option>
                    <option value="eth">ETH</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Payout Wallet Address</label>
                  <input
                    value={draft.walletAddress}
                    onChange={(e) => setDraft({ ...draft, walletAddress: e.target.value })}
                    placeholder="0x..."
                    className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white font-mono text-sm"
                  />
                </div>
              </div>
              <p className="text-xs text-gray-500 -mt-2">
                Fans pay you directly to this wallet when they unlock your content. The platform takes a 10% fee on top, sent separately.
              </p>

              <button onClick={saveProfile} disabled={busy} className="premium-button disabled:opacity-50">
                Save Profile
              </button>

              <hr className="border-brand-purple/20" />

              <div>
                {(() => {
                  const limit = creator.premium ? 10 : 4;
                  const used = creator.gallery?.length || 0;
                  const atLimit = used >= limit;
                  return (
                    <>
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="font-bold text-brand-gold">Your Content ({used}/{limit})</h3>
                        {atLimit ? (
                          <span className="text-xs px-4 py-2 rounded-md border border-brand-purple/30 text-gray-500">Slots full</span>
                        ) : (
                          <label className="premium-button inline-block cursor-pointer text-sm py-2 px-4">
                            Upload
                            <input type="file" accept="image/*,video/*" className="hidden" onChange={(e) => uploadContent(e.target.files[0])} />
                          </label>
                        )}
                      </div>
                      {!creator.premium && (
                        <p className="text-xs text-gray-500 mb-3">
                          Free accounts get 4 content slots. Premium creators get 10 and a gold check — contact us to upgrade.
                        </p>
                      )}
                    </>
                  );
                })()}
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                  {(creator.gallery || []).map((item, i) => (
                    <div key={i} className="relative aspect-square rounded-md overflow-hidden border border-brand-purple/20 group">
                      {item.type === 'video' ? (
                        <video src={item.src} className="w-full h-full object-cover" muted />
                      ) : (
                        <img src={item.src} alt="" className="w-full h-full object-cover" />
                      )}
                      <button
                        onClick={() => deleteItem(i)}
                        className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-white text-xs opacity-0 group-hover:opacity-100 transition"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <hr className="border-brand-purple/20" />

              <MarketplaceSection
                listings={listings}
                busy={busy}
                onCreate={createListing}
                onUploadMedia={uploadListingMedia}
                onToggleStatus={toggleListingStatus}
              />
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Inbox({ currentUserId }) {
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/messages/conversations');
      const data = await res.json();
      if (res.ok) setConversations(data.conversations || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const open = conversations.find((c) => c.id === openId);

  const send = async (e) => {
    e.preventDefault();
    if (!text.trim() || !open) return;
    setSending(true);
    try {
      const res = await fetch('/api/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toUserId: open.other.userId, text }),
      });
      const data = await res.json();
      if (res.ok) {
        setText('');
        await load();
      }
    } finally {
      setSending(false);
    }
  };

  if (loading) return null;
  if (conversations.length === 0) return null;

  return (
    <div className="premium-card p-6 mb-6">
      <h3 className="font-bold text-brand-gold mb-4">Messages</h3>
      <div className="grid sm:grid-cols-3 gap-4">
        <div className="space-y-2 sm:border-r border-brand-purple/20 sm:pr-4">
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => setOpenId(c.id)}
              className={`w-full flex items-center gap-2 p-2 rounded-md text-left transition ${
                openId === c.id ? 'bg-brand-purple/20' : 'hover:bg-white/5'
              }`}
            >
              {c.other.img ? (
                <img src={c.other.img} alt="" className="w-8 h-8 rounded-full object-cover object-top" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-brand-purple/30" />
              )}
              <div className="min-w-0">
                <p className="text-sm font-bold text-white truncate">{c.other.name}</p>
                <p className="text-xs text-gray-500 truncate">{c.messages[c.messages.length - 1]?.text}</p>
              </div>
            </button>
          ))}
        </div>

        <div className="sm:col-span-2">
          {!open ? (
            <p className="text-gray-500 text-sm">Select a conversation.</p>
          ) : (
            <div className="flex flex-col h-72">
              <div className="flex-1 overflow-y-auto space-y-2 mb-3 pr-1">
                {open.messages.map((m) => (
                  <div
                    key={m.id}
                    className={`max-w-[80%] px-3 py-2 rounded-lg text-sm ${
                      String(m.senderId) === String(currentUserId)
                        ? 'bg-brand-gold text-black ml-auto'
                        : 'bg-black/40 text-gray-200 mr-auto'
                    }`}
                  >
                    {m.text}
                  </div>
                ))}
              </div>
              <form onSubmit={send} className="flex gap-2">
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Reply..."
                  className="flex-1 px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
                />
                <button type="submit" disabled={sending} className="premium-button py-2 px-4 text-sm disabled:opacity-50">
                  Send
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MarketplaceSection({ listings, busy, onCreate, onUploadMedia, onToggleStatus }) {
  const [form, setForm] = useState({ title: '', description: '', price: '', unlimited: true });
  const [creating, setCreating] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const priceCents = Math.round(Number(form.price) * 100);
    if (!form.title.trim() || !priceCents || priceCents < 100) return;
    setCreating(true);
    const listing = await onCreate({ title: form.title, description: form.description, priceCents, unlimited: form.unlimited });
    setCreating(false);
    if (listing) setForm({ title: '', description: '', price: '', unlimited: true });
  };

  return (
    <div>
      <h3 className="font-bold text-brand-gold mb-3">Sell on the Marketplace (onlyass.shop)</h3>
      <p className="text-xs text-gray-500 mb-4">
        List images, videos, or anything else at whatever price you want. Platform takes 10% commission + a 5%
        listing fee on top when it sells. Buying isn't live yet — listings show up on the Marketplace now, ready
        to sell as soon as payments launch.
      </p>

      <form onSubmit={submit} className="grid sm:grid-cols-2 gap-3 mb-6">
        <input
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          placeholder="Title"
          className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
        />
        <input
          value={form.price}
          onChange={(e) => setForm({ ...form, price: e.target.value })}
          placeholder="Price (USD)"
          type="number"
          min="1"
          step="0.01"
          className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
        />
        <textarea
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="Description"
          rows={2}
          className="sm:col-span-2 w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
        />
        <label className="flex items-center gap-2 text-sm text-gray-400">
          <input type="checkbox" checked={form.unlimited} onChange={(e) => setForm({ ...form, unlimited: e.target.checked })} />
          Digital good (sell to unlimited buyers) — uncheck for a one-of-a-kind item
        </label>
        <button type="submit" disabled={creating || busy} className="premium-button text-sm disabled:opacity-50">
          Create Listing
        </button>
      </form>

      <div className="space-y-4">
        {listings.length === 0 ? (
          <p className="text-sm text-gray-500">No listings yet.</p>
        ) : (
          listings.map((l) => (
            <div key={l.id} className="premium-card border border-brand-purple/20 p-4">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <p className="font-bold text-white">{l.title} — ${(l.priceCents / 100).toFixed(2)}</p>
                  <p className="text-xs text-gray-500">{l.status} · {l.unlimited ? 'unlimited' : 'one-of-a-kind'}</p>
                </div>
                {l.status !== 'sold' && (
                  <button
                    onClick={() => onToggleStatus(l.id, l.status === 'active' ? 'removed' : 'active')}
                    className="text-xs px-3 py-1.5 rounded-md border border-brand-purple/30 text-gray-300 hover:bg-white/5 transition"
                  >
                    {l.status === 'active' ? 'Remove' : 'Reactivate'}
                  </button>
                )}
              </div>
              <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                {(l.media || []).map((item, i) => (
                  <div key={i} className="aspect-square rounded-md overflow-hidden border border-brand-purple/20">
                    {item.type === 'video' ? (
                      <video src={item.src} className="w-full h-full object-cover" muted />
                    ) : (
                      <img src={item.src} alt="" className="w-full h-full object-cover" />
                    )}
                  </div>
                ))}
                {(l.media || []).length < 10 && (
                  <label className="aspect-square rounded-md border border-dashed border-brand-purple/30 flex items-center justify-center text-xs text-gray-500 cursor-pointer hover:bg-white/5 transition">
                    + Add
                    <input type="file" accept="image/*,video/*" className="hidden" onChange={(e) => onUploadMedia(l.id, e.target.files[0])} />
                  </label>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
