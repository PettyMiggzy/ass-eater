import { useState, useEffect } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { getSessionUser } from '../lib/session';
import { publicUser } from '../lib/users-store';
import { getCreators, effectiveCreatorStatus } from '../lib/creators-store';
import { getListings } from '../lib/listings-store';
import { tokenGateLive, sanitizeGateTokens, gateTokensOf } from '../lib/token-gate';
import { creatorShareText, feeWaiverEndsAt, feeWaiverPending, isFoundingCreator, foundingProfileGaps, foundingSlotsLeft, FEE_WAIVER_DAYS } from '../lib/founding';

export async function getServerSideProps({ req }) {
  // getSessionUser rather than a stateless token check, so a session that
  // has been logged out elsewhere lands on /login here too. It also covers
  // the old "token is valid but the account no longer exists" case, which
  // used to need a separate lookup.
  const user = await getSessionUser(req);
  if (!user) {
    return { redirect: { destination: '/login', permanent: false } };
  }

  let creator = null;
  let listings = [];
  let foundingLeft = 0;
  if (user.role === 'creator' && user.creatorId) {
    const creators = await getCreators();
    foundingLeft = foundingSlotsLeft(creators);
    creator = creators.find((c) => String(c.id) === String(user.creatorId)) || null;
    const allListings = await getListings();
    listings = allListings
      .filter((l) => String(l.creatorId) === String(user.creatorId))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  return { props: { user: publicUser(user), creator, listings, foundingLeft } };
}

export default function Dashboard({ user, creator: initialCreator, listings: initialListings, foundingLeft }) {
  const router = useRouter();
  const [creator, setCreator] = useState(initialCreator);
  const [listings, setListings] = useState(initialListings || []);
  const [draft, setDraft] = useState({
    name: initialCreator?.name || '',
    handle: initialCreator?.handle || '',
    bio: initialCreator?.bio || '',
    tags: (initialCreator?.tags || []).join(', '),
    price: initialCreator?.price || '',
    // 'onlyass' is a legacy value from when the token was the payment
    // asset. It no longer is (see lib/brand.js), and nothing was ever
    // paid out under it, so it reads as the dollar stablecoin.
    locked: !!initialCreator?.locked,
    gateTokens: gateTokensOf(initialCreator) || '',
    payoutMethod: initialCreator?.payoutMethod === 'eth' ? 'eth' : 'usdg',
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
  const [nextUploadIsAi, setNextUploadIsAi] = useState(false);
  const creatorStatus = creator ? effectiveCreatorStatus(creator) : null;
  const isRestricted = creatorStatus === 'suspended' || creatorStatus === 'banned';

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
      setDraft((d) => ({ ...d, tags: (data.creator.tags || []).join(', ') }));
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

  const uploadContent = async (file, aiGenerated) => {
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
          'x-ai-generated': aiGenerated ? 'true' : 'false',
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
                You're set up as a fan. Head to the platform to browse creators — unlocks are paid for with credits, which you top up with dollars.
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
              {creatorStatus === 'suspended' && (
                <div className="px-4 py-3 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                  Your account is suspended until {new Date(creator.suspendedUntil).toLocaleDateString()} following a
                  confirmed content violation. Your profile is hidden and you can't post or edit content until then.
                </div>
              )}
              {creatorStatus === 'banned' && (
                <div className="px-4 py-3 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                  Your account has been permanently banned following a second confirmed content violation. Your
                  profile is hidden and you can no longer post or edit content.
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
                  <label className={`premium-button inline-block cursor-pointer text-sm py-2 px-4 ${busy || isRestricted ? 'opacity-50 pointer-events-none' : ''}`}>
                    Change PFP
                    <input type="file" accept="image/*" className="hidden" disabled={busy || isRestricted} onChange={(e) => uploadAvatar(e.target.files[0])} />
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
                <label className="block text-sm text-gray-400 mb-2">Tags (up to 8, comma-separated — how fans find you when browsing)</label>
                <input
                  value={draft.tags}
                  onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                  placeholder="e.g. cosplay, gym, redhead, asmr"
                  className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white"
                />
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

              {/* Token gating. Hold, never spend -- a fan who unlocks this way
                  has paid nobody, which is exactly why it isn't a payment.
                  See lib/token-gate.js. */}
              <div className="rounded-md border border-brand-purple/30 bg-black/20 p-4">
                <label className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!draft.locked}
                    onChange={(e) => setDraft({ ...draft, locked: e.target.checked })}
                  />
                  Token-gate my profile
                </label>
                <p className="text-xs text-gray-500 mt-2">
                  Fans have to <strong>hold</strong> $ONLYONE to see your page. They don't spend it and you
                  aren't paid from it — it's a gate, not a price, and it works alongside whatever you charge.
                </p>
                {draft.locked && (
                  <div className="mt-3">
                    <label className="block text-xs text-gray-400 mb-2">How many $ONLYONE must they hold?</label>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={draft.gateTokens}
                      onChange={(e) => setDraft({ ...draft, gateTokens: e.target.value })}
                      placeholder="e.g. 2500000"
                      className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
                    />
                    {!sanitizeGateTokens(draft.gateTokens) && (
                      <p className="text-xs text-yellow-400/80 mt-2">
                        Set a number above zero — a gate with no amount doesn't gate anything, and your page
                        stays open.
                      </p>
                    )}
                    {!tokenGateLive() && (
                      <p className="text-xs text-gray-500 mt-2">
                        $ONLYONE hasn't launched yet, so nobody is locked out in the meantime — your page
                        shows as "unlocks at launch" and stays visible. The gate starts working the day the
                        token does.
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Get Paid In</label>
                  <select
                    value={draft.payoutMethod}
                    onChange={(e) => setDraft({ ...draft, payoutMethod: e.target.value })}
                    className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white"
                  >
                    <option value="usdg">USDG (dollars)</option>
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
                Your earnings are paid out to this wallet in USDG — the dollar stablecoin on Robinhood Chain, worth $1 each. Bridge it out and it arrives as USDC, which Coinbase accepts. The platform takes a 10% fee.
              </p>

              <button onClick={saveProfile} disabled={busy || isRestricted} className="premium-button disabled:opacity-50">
                Save Profile
              </button>

              <hr className="border-brand-purple/20" />

              <ShareKit creator={creator} foundingLeft={foundingLeft} />

              <hr className="border-brand-purple/20" />

              <div>
                {(() => {
                  const limit = creator.premium ? 200 : 50;
                  const used = creator.gallery?.length || 0;
                  const atLimit = used >= limit || isRestricted;
                  return (
                    <>
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="font-bold text-brand-gold">Your Content ({used}/{limit})</h3>
                        {atLimit ? (
                          <span className="text-xs px-4 py-2 rounded-md border border-brand-purple/30 text-gray-500">
                            {isRestricted ? 'Uploads disabled' : 'Slots full'}
                          </span>
                        ) : (
                          <label className={`premium-button inline-block cursor-pointer text-sm py-2 px-4 ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
                            {busy ? 'Uploading...' : 'Upload'}
                            <input
                              type="file"
                              accept="image/*,video/*"
                              className="hidden"
                              disabled={busy}
                              onChange={(e) => {
                                const file = e.target.files[0];
                                if (!file) return;
                                uploadContent(file, nextUploadIsAi);
                                setNextUploadIsAi(false);
                                e.target.value = '';
                              }}
                            />
                          </label>
                        )}
                      </div>
                      {!atLimit && (
                        <label className="flex items-center gap-2 text-xs text-gray-400 mb-2 cursor-pointer">
                          <input type="checkbox" checked={nextUploadIsAi} onChange={(e) => setNextUploadIsAi(e.target.checked)} />
                          This upload is AI-generated or synthetic content (will be labeled "AI" on your profile)
                        </label>
                      )}
                      {!creator.premium && (
                        <p className="text-xs text-gray-500 mb-3">
                          Free accounts get 50 content slots. Premium creators get 200 and a gold check — contact us to upgrade.
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
                      {item.aiGenerated && (
                        <span className="absolute bottom-1 left-1 text-[9px] px-1.5 py-0.5 rounded bg-black/70 text-brand-gold font-bold">AI</span>
                      )}
                      <button
                        onClick={() => deleteItem(i)}
                        disabled={busy}
                        className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-white text-xs opacity-0 group-hover:opacity-100 transition disabled:opacity-30"
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
                disabled={isRestricted}
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

/**
 * The creator's own share kit: their referral link and the post that goes
 * with it.
 *
 * This is the actual mechanic behind "creator referral rewards" -- a
 * creator's audience is the platform's distribution, so the link and the
 * words have to be one copy-paste away, not something they compose
 * themselves. The text lives in lib/founding.js so every surface offers
 * the same one.
 *
 * The link goes to "/" (the public landing page), NOT to the creator's own
 * profile: the profile is behind the age gate, so a fan following it from a
 * blocked state hits /blocked-region as their first impression of both the
 * creator and the site. "/" is the one page everyone can open, it carries
 * the ?ref through to signup via the cookie in lib/referral.js, and the
 * creator's profile is one click past it.
 */
function ShareKit({ creator, foundingLeft }) {
  const [copiedField, setCopiedField] = useState('');
  const [origin, setOrigin] = useState('');

  // window is not available during SSR, and hardcoding a domain would break
  // the link on every other host this project serves (onlyone1.fun,
  // onlyass.fun, preview deployments).
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const handle = String(creator?.handle || '').replace(/^@/, '');
  const link = handle && origin ? `${origin}/?ref=${encodeURIComponent(handle)}` : '';
  const post = link ? creatorShareText(creator, link) : '';

  const copy = async (field, value) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      setTimeout(() => setCopiedField(''), 2000);
    } catch {
      setCopiedField('');
    }
  };

  const founding = isFoundingCreator(creator);
  const waiverEnds = feeWaiverEndsAt(creator);
  const gaps = foundingProfileGaps(creator);

  return (
    <div>
      <h3 className="font-bold text-brand-gold mb-2">Share Your Page</h3>

      {/* Not founding yet, slots still open: say exactly what is missing.
          The programme is decided automatically at approval, so a creator who
          is told "finish these four things" can actually act on it -- which is
          the difference between a perk and a lottery. */}
      {!founding && foundingLeft > 0 && gaps.length > 0 && (
        <div className="mb-4 px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-sm">
          <p className="font-bold text-brand-gold">
            {foundingLeft} Founding Creator {foundingLeft === 1 ? 'spot' : 'spots'} left
          </p>
          <p className="text-gray-400 mt-1">
            The first 100 creators approved with a finished profile get the badge, priority placement and
            a fee-free window. Yours still needs:
          </p>
          <ul className="list-disc pl-5 mt-2 text-gray-300 space-y-1">
            {gaps.map((g) => <li key={g}>{g}</li>)}
          </ul>
        </div>
      )}
      {!founding && foundingLeft > 0 && gaps.length === 0 && (
        <div className="mb-4 px-4 py-3 rounded-md bg-black/40 border border-brand-gold/30 text-sm">
          <p className="font-bold text-brand-gold">Your profile qualifies for Founding Creator</p>
          <p className="text-gray-400 mt-1">
            {foundingLeft} of 100 {foundingLeft === 1 ? 'spot is' : 'spots are'} left. The badge is granted
            when your profile is approved.
          </p>
        </div>
      )}

      {founding && (
        <div className="mb-4 px-4 py-3 rounded-md bg-brand-gold/10 border border-brand-gold/30 text-sm">
          <p className="font-black tracking-wide text-brand-gold">★ FOUNDING CREATOR</p>
          <p className="text-gray-300 mt-1">
            {feeWaiverPending(creator)
              ? `Your ${FEE_WAIVER_DAYS} days at 0% platform fee start the day payments go live — not today — so you get the full window when there's actually a fee to waive.`
              : waiverEnds && waiverEnds.getTime() > Date.now()
                ? `You're paying 0% platform fee until ${waiverEnds.toLocaleDateString()}.`
                : `Your ${FEE_WAIVER_DAYS}-day fee-free window has ended. The badge and priority placement are permanent.`}
          </p>
        </div>
      )}

      {!handle ? (
        <p className="text-sm text-gray-400">Set a handle above and save your profile to get your referral link.</p>
      ) : (
        <>
          <p className="text-sm text-gray-400 mb-4">
            Anyone who joins OnlyOne through this link is credited to you, for 30 days after they first click it.
          </p>

          <label className="block text-xs text-gray-500 mb-2">YOUR REFERRAL LINK</label>
          <div className="flex gap-2 mb-5">
            <input
              readOnly
              value={link}
              onFocus={(e) => e.target.select()}
              className="flex-1 px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white font-mono text-xs"
            />
            <button
              onClick={() => copy('link', link)}
              disabled={!link}
              className="px-4 py-3 rounded-md border border-brand-purple/30 text-sm text-gray-300 hover:bg-white/5 transition disabled:opacity-50"
            >
              {copiedField === 'link' ? 'Copied' : 'Copy'}
            </button>
          </div>

          <label className="block text-xs text-gray-500 mb-2">READY-TO-POST</label>
          <textarea
            readOnly
            rows={5}
            value={post}
            onFocus={(e) => e.target.select()}
            className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm resize-none"
          />
          <button
            onClick={() => copy('post', post)}
            disabled={!post}
            className="mt-2 px-4 py-2 rounded-md border border-brand-purple/30 text-sm text-gray-300 hover:bg-white/5 transition disabled:opacity-50"
          >
            {copiedField === 'post' ? 'Copied' : 'Copy Post'}
          </button>
        </>
      )}
    </div>
  );
}

function Inbox({ currentUserId }) {
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');

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
    setSendError('');
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
      } else {
        setSendError(data.error || 'Failed to send');
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
              {sendError && <p className="text-xs text-red-400 mb-2">{sendError}</p>}
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

const BLANK_LISTING_FORM = { title: '', description: '', price: '', unlimited: true, physical: false, shipping: '', signatureRequired: false, aiGenerated: false };

function MarketplaceSection({ listings, busy, disabled, onCreate, onUploadMedia, onToggleStatus }) {
  const [form, setForm] = useState(BLANK_LISTING_FORM);
  const [creating, setCreating] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const priceCents = Math.round(Number(form.price) * 100);
    if (!form.title.trim() || !priceCents || priceCents < 100) return;
    const shippingCents = form.physical ? Math.round(Number(form.shipping) * 100) || 0 : undefined;
    setCreating(true);
    const listing = await onCreate({
      title: form.title, description: form.description, priceCents, unlimited: form.unlimited,
      kind: form.physical ? 'physical' : 'digital', shippingCents,
      signatureRequired: form.physical && form.signatureRequired,
      aiGenerated: form.aiGenerated,
    });
    setCreating(false);
    if (listing) setForm(BLANK_LISTING_FORM);
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
          <input
            type="checkbox"
            checked={form.unlimited}
            disabled={form.physical}
            onChange={(e) => setForm({ ...form, unlimited: e.target.checked })}
          />
          Digital good (sell to unlimited buyers) — uncheck for a one-of-a-kind item
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-400">
          <input
            type="checkbox"
            checked={form.physical}
            onChange={(e) => setForm({ ...form, physical: e.target.checked, unlimited: e.target.checked ? false : form.unlimited })}
          />
          Physical item — ships to the buyer (no inventory tracking yet, one listing = one item to ship)
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-400">
          <input
            type="checkbox"
            checked={form.aiGenerated}
            onChange={(e) => setForm({ ...form, aiGenerated: e.target.checked })}
          />
          AI-generated or synthetic content (will be labeled "AI" on the listing)
        </label>
        {form.physical && (
          <>
            <input
              value={form.shipping}
              onChange={(e) => setForm({ ...form, shipping: e.target.value })}
              placeholder="Shipping fee (USD, 0 for free shipping)"
              type="number"
              min="0"
              step="0.01"
              className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
            />
            <label className="flex items-center gap-2 text-sm text-gray-400">
              <input
                type="checkbox"
                checked={form.signatureRequired}
                onChange={(e) => setForm({ ...form, signatureRequired: e.target.checked })}
              />
              Require signature on delivery — your call with the carrier when you ship; price your shipping fee to cover it
            </label>
          </>
        )}
        <button type="submit" disabled={creating || busy || disabled} className="premium-button text-sm disabled:opacity-50">
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
                  <p className="text-xs text-gray-500">
                    {l.status} · {l.unlimited ? 'unlimited' : 'one-of-a-kind'}
                    {l.kind === 'physical' && ` · ships to buyer${l.shippingCents ? ` (+$${(l.shippingCents / 100).toFixed(2)} shipping)` : ' (free shipping)'}${l.signatureRequired ? ' · signature required' : ''}`}
                    {l.aiGenerated && ' · AI'}
                  </p>
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
                  <label className={`aspect-square rounded-md border border-dashed border-brand-purple/30 flex items-center justify-center text-xs text-gray-500 cursor-pointer hover:bg-white/5 transition ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
                    + Add
                    <input type="file" accept="image/*,video/*" className="hidden" disabled={busy} onChange={(e) => onUploadMedia(l.id, e.target.files[0])} />
                  </label>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {listings.some((l) => l.kind === 'physical') && (
        <>
          <hr className="border-brand-purple/20 my-6" />
          <OrdersToShip />
        </>
      )}
    </div>
  );
}

function OrdersToShip() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [shipForm, setShipForm] = useState({}); // orderId -> { carrier, trackingNumber }
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/marketplace/orders/creator');
      const data = await res.json();
      if (res.ok) setOrders(data.orders || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const markShipped = async (orderId) => {
    const { carrier, trackingNumber } = shipForm[orderId] || {};
    if (!carrier || !trackingNumber) { setError('Enter a carrier and tracking number first.'); return; }
    setBusyId(orderId);
    setError('');
    try {
      const res = await fetch('/api/marketplace/orders/ship', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, carrier, trackingNumber }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to mark shipped');
      setOrders(orders.map((o) => (o.id === orderId ? data.order : o)));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const pending = orders.filter((o) => o.status === 'pending_shipment');
  const shipped = orders.filter((o) => o.status === 'shipped');

  return (
    <div>
      <h3 className="font-bold text-brand-gold mb-3">Orders to Ship</h3>
      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : orders.length === 0 ? (
        <p className="text-sm text-gray-500">No physical orders yet.</p>
      ) : (
        <div className="space-y-3">
          {error && <p className="text-xs text-red-400">{error}</p>}
          {pending.map((o) => {
            const addr = o.shippingAddress || {};
            const form = shipForm[o.id] || { carrier: '', trackingNumber: '' };
            return (
              <div key={o.id} className="premium-card border border-brand-purple/20 p-4">
                <p className="text-sm text-white font-bold">Order #{o.id} — ${(o.priceCents / 100).toFixed(2)}{o.shippingCents ? ` + $${(o.shippingCents / 100).toFixed(2)} shipping` : ''}</p>
                {o.signatureRequired && (
                  <p className="text-xs text-brand-gold mt-1">Select signature confirmation with your carrier for this one — you marked this listing as requiring it.</p>
                )}
                <p className="text-xs text-gray-400 mt-1">
                  {addr.fullName}<br />
                  {addr.line1}{addr.line2 ? `, ${addr.line2}` : ''}<br />
                  {addr.city}, {addr.region} {addr.postalCode}<br />
                  {addr.country}{addr.phone ? ` · ${addr.phone}` : ''}
                </p>
                <div className="flex flex-wrap gap-2 mt-3">
                  <input
                    value={form.carrier}
                    onChange={(e) => setShipForm({ ...shipForm, [o.id]: { ...form, carrier: e.target.value } })}
                    placeholder="Carrier (e.g. USPS)"
                    className="px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-xs"
                  />
                  <input
                    value={form.trackingNumber}
                    onChange={(e) => setShipForm({ ...shipForm, [o.id]: { ...form, trackingNumber: e.target.value } })}
                    placeholder="Tracking number"
                    className="px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-xs"
                  />
                  <button
                    onClick={() => markShipped(o.id)}
                    disabled={busyId === o.id}
                    className="premium-button text-xs px-4 disabled:opacity-50"
                  >
                    Mark Shipped
                  </button>
                </div>
              </div>
            );
          })}
          {shipped.length > 0 && (
            <details className="text-xs text-gray-500">
              <summary className="cursor-pointer">Shipped ({shipped.length})</summary>
              <div className="mt-2 space-y-1">
                {shipped.map((o) => (
                  <p key={o.id}>Order #{o.id} — {o.carrier} {o.trackingNumber}</p>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
