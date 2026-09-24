import { useState, useEffect } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { getSessionUser } from '../lib/session';
import { publicUser } from '../lib/users-store';
import { getCreators } from '../lib/creators-store';
import { effectiveCreatorStatus, isPubliclyVisible, LISTING_LIMITS } from '../lib/creator-status';
import { getListings } from '../lib/listings-store';
import { holderVerificationLive } from '../lib/holder-access';
import { signupsOpen } from '../lib/signups';
import { sanitizeGateTokens, MAX_GATE_TOKENS } from '../lib/token-gate';
import {
  creatorShareText,
  feeWaiverActive,
  feeWaiverEndsAt,
  feeWaiverPending,
  isFoundingCreator,
  foundingProfileGaps,
  foundingSlotsLeft,
  FEE_WAIVER_DAYS,
} from '../lib/founding';
import { Icons, SolidIcons } from '../components/Brand';
import SiteNav from '../components/SiteNav';
import Inbox from '../components/dashboard/Inbox';
import CashOutPanel from '../components/dashboard/CashOutPanel';
import OrdersToShip from '../components/dashboard/OrdersToShip';
import { uploadPrivateMedia, generateListingPreview, postJson } from '../components/dashboard/media-upload';
import {
  draftFromCreator,
  profileFieldsFromDraft,
  payoutWalletError,
  dollarsToCents,
  responseErrorMessage,
} from '../components/dashboard/helpers';
import { TAG_GROUPS, LISTING_TAG_GROUPS } from '../lib/tag-taxonomy';
import {
  PLATFORM_FEE_PCT,
  MARKETPLACE_FEE_PCT,
  LISTING_FEE_PCT,
  DM_PRICE_FLOOR_CENTS,
  SETTLE_ASSET,
  BRIDGE_ASSET,
  formatCredits,
} from '../lib/brand';
import { DM_PRICE_MAX_CENTS } from '../lib/field-validation';
import { marketplacePaymentsLive } from '../lib/marketplace-payment-config';

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
  let founding = null;
  if (user.role === 'creator' && user.creatorId) {
    const creators = await getCreators();
    foundingLeft = foundingSlotsLeft(creators);
    creator = creators.find((c) => String(c.id) === String(user.creatorId)) || null;
    const allListings = await getListings();
    listings = allListings
      .filter((l) => String(l.creatorId) === String(user.creatorId))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (creator) {
      // Computed HERE, not in the browser: PAYMENTS_LIVE_AT can be overridden
      // by a server-only env var the client bundle never sees, so a date
      // worked out client-side could disagree with the one transferWithFee
      // actually enforces.
      const endsAt = feeWaiverEndsAt(creator);
      founding = {
        isFounding: isFoundingCreator(creator),
        pending: feeWaiverPending(creator),
        active: feeWaiverActive(creator),
        endsAt: endsAt ? endsAt.toISOString() : null,
      };
    }
  }

  return {
    props: {
      user: publicUser(user),
      creator,
      listings,
      foundingLeft,
      founding,
      paymentsLive: marketplacePaymentsLive(),
      gateVerifierLive: holderVerificationLive(),
      signupsOpen: signupsOpen(),
      publiclyVisible: creator ? isPubliclyVisible(creator) : false,
    },
  };
}

// Fixed locale and time zone so the server render and the browser agree
// (a date formatted in the server's zone and again in the viewer's is a
// hydration mismatch on every page load near midnight).
function formatDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
}

export default function Dashboard({
  user,
  creator: initialCreator,
  listings: initialListings,
  foundingLeft,
  founding,
  paymentsLive,
  gateVerifierLive,
  signupsOpen: signupsAreOpen,
  publiclyVisible,
}) {
  const router = useRouter();
  const [creator, setCreator] = useState(initialCreator);
  const [listings, setListings] = useState(initialListings || []);
  const [draft, setDraft] = useState(() => draftFromCreator(initialCreator));
  const [origin, setOrigin] = useState('');
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [nextUploadIsAi, setNextUploadIsAi] = useState(false);
  const creatorStatus = creator ? effectiveCreatorStatus(creator) : null;
  const isRestricted = creatorStatus === 'suspended' || creatorStatus === 'banned';
  const isDemo = !!creator && (creator.seed === true || creator.demo === true);
  const walletError = payoutWalletError(draft.walletAddress);
  const walletDirty = String(draft.walletAddress || '').trim() !== String(creator?.walletAddress || '').trim();

  // window is not available during SSR; reading it in render made the
  // server and client HTML differ.
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const logout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      router.push('/');
    }
  };

  const saveProfile = async () => {
    const built = profileFieldsFromDraft(draft);
    if (built.error) {
      setStatus(`Error: ${built.error}`);
      return;
    }
    setBusy(true);
    setStatus('Saving...');
    try {
      // No `img` here: the avatar is set only by the avatar upload, and the
      // server ignores one posted with the profile.
      const { res, data } = await postJson('/api/me/profile', { fields: built.fields });
      if (!res.ok || !data?.creator) throw new Error(responseErrorMessage(res.status, data, 'Save failed'));
      setCreator(data.creator);
      // Resync every field to what was actually stored (normalised handle,
      // cleaned tags, clamped gate amount, trimmed wallet...).
      setDraft(draftFromCreator(data.creator));
      setStatus('Saved.');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const progress = (label) => (pct) => setStatus(`${label} ${pct}%`);

  const uploadAvatar = async (file) => {
    if (!file) return;
    setBusy(true);
    setStatus('Uploading avatar...');
    try {
      const data = await uploadPrivateMedia({
        file,
        purpose: 'avatar',
        finalizeUrl: '/api/me/avatar',
        onProgress: progress('Uploading avatar...'),
      });
      if (data.creator) setCreator(data.creator);
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
      const data = await uploadPrivateMedia({
        file,
        purpose: 'gallery',
        finalizeUrl: '/api/me/upload',
        finalizeBody: { aiGenerated: !!aiGenerated },
        onProgress: progress('Uploading content...'),
      });
      if (data.creator) setCreator(data.creator);
      setStatus('Content added.');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  // Addressed by src (the item's identity) with the index as a hint: a bare
  // index removed whatever sat at that position on the server, which after an
  // edit in another tab was a different photo from the one clicked.
  const deleteItem = async (item, index) => {
    if (!item?.src) return;
    setBusy(true);
    setStatus('Removing...');
    try {
      const { res, data } = await postJson('/api/me/gallery-delete', { src: item.src, index });
      if (res.status === 409) {
        setStatus('That item was already removed or changed somewhere else. Refresh the page to see your current gallery.');
        return;
      }
      if (!res.ok || !data?.creator) throw new Error(responseErrorMessage(res.status, data, 'Delete failed'));
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
      const { res, data } = await postJson('/api/marketplace/create', fields);
      if (!res.ok || !data?.listing) throw new Error(responseErrorMessage(res.status, data, 'Failed to create listing'));
      setListings((list) => [data.listing, ...list]);
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
    setBusy(true);
    setStatus('Preparing preview...');
    try {
      // The blurred preview is the only image of this media a non-buyer ever
      // gets. If the browser can't decode the file it is null and the
      // listing shows a placeholder -- never the real file.
      const preview = await generateListingPreview(file);
      const data = await uploadPrivateMedia({
        file,
        purpose: 'listing',
        listingId,
        finalizeUrl: '/api/marketplace/upload',
        finalizeBody: { listingId, preview },
        onProgress: progress('Uploading...'),
      });
      if (data.listing) setListings((list) => list.map((l) => (l.id === listingId ? data.listing : l)));
      setStatus(preview ? 'Media added.' : 'Media added. Your browser could not make a blurred preview of it, so shoppers see a placeholder instead.');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleListingStatus = async (listingId, nextStatus) => {
    setBusy(true);
    try {
      const { res, data } = await postJson('/api/marketplace/update', { listingId, fields: { status: nextStatus } });
      if (!res.ok || !data?.listing) throw new Error(responseErrorMessage(res.status, data, 'Update failed'));
      setListings((list) => list.map((l) => (l.id === listingId ? data.listing : l)));
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const profileUrl = creator ? `${origin}/creator/${creator.id}` : '';

  return (
    <>
      <Head><title>Dashboard - OnlyOne</title></Head>
      <SiteNav signedIn viewerAvatar={creator?.img || null} />
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
            <div className="mb-6 px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-brand-secondary text-sm" role="status">
              {status}
            </div>
          )}

          <Inbox currentUserId={user.id} isCreator={user.role === 'creator' && !!creator} />

          {user.role !== 'creator' && (
            <div className="premium-card p-8">
              <p className="text-gray-300 mb-2">Logged in as <span className="text-brand-gold font-bold">{user.email}</span></p>
              <p className="text-gray-400 text-sm mb-6">
                You&apos;re set up as a fan. Credits are what you spend here — on Marketplace items and on messages to
                creators — and spending them needs no wallet. Buying credits does: you send {SETTLE_ASSET} from a crypto
                wallet on the {process.env.NEXT_PUBLIC_MARKETPLACE_CHAIN_NAME || 'Robinhood Chain'} network.
              </p>
              <div className="flex flex-wrap gap-3">
                <a href="/creators" className="premium-button inline-block">Browse Creators</a>
                <a href="/credits" className="px-5 py-3 rounded-md border border-brand-purple/30 text-sm text-gray-200 hover:bg-white/5 transition">Buy Credits</a>
                <a href="/orders" className="px-5 py-3 rounded-md border border-brand-purple/30 text-sm text-gray-200 hover:bg-white/5 transition">Your Orders</a>
              </div>
            </div>
          )}

          {/* A creator account whose profile record is gone (deleted by an
              admin, or a signup that half-failed) used to render nothing at
              all below the Log Out button -- a blank page with no
              explanation. */}
          {user.role === 'creator' && !creator && (
            <div className="premium-card p-8">
              <p className="text-gray-300 mb-2">
                We can&apos;t find a creator profile attached to this account.
              </p>
              <p className="text-gray-400 text-sm mb-6">
                This usually means the profile was removed. Email{' '}
                <a href="mailto:team@onlyone1.fun" className="text-brand-pink hover:underline">team@onlyone1.fun</a>{' '}
                and we&apos;ll sort it out.
              </p>
              <a href="/creators" className="premium-button inline-block">Browse Creators</a>
            </div>
          )}

          {user.role === 'creator' && creator && (
            <div className="premium-card p-6 space-y-6">
              {isDemo && (
                <div className="px-4 py-3 rounded-md bg-white/5 border border-white/15 text-gray-300 text-sm">
                  Demo profile — not for sale. Demo listings can&apos;t be bought and demo accounts can&apos;t cash out.
                </div>
              )}
              {creatorStatus === 'pending' && (
                <div className="px-4 py-3 rounded-md bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 text-sm">
                  Your profile is pending review and not yet visible on the platform. Build it out below — you can upload
                  and create listings now, and they go live (and can sell) once our team approves your profile.
                </div>
              )}
              {creatorStatus === 'suspended' && (
                <div className="px-4 py-3 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                  Your account is suspended until {formatDate(creator.suspendedUntil)} following a confirmed content
                  violation. Your profile and listings are hidden, you can&apos;t post, edit or sell, and your balance and
                  any pending cash-outs are held until then. You can still ship orders fans have already paid for.
                </div>
              )}
              {creatorStatus === 'banned' && (
                <div className="px-4 py-3 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                  Your account has been permanently banned following a second confirmed content violation. Your
                  profile is hidden, you can no longer post, edit or sell, and your balance is frozen and never paid out.
                </div>
              )}

              <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-md bg-black/30 border border-brand-purple/20">
                <div className="min-w-0">
                  <p className="text-xs text-gray-500 mb-1">Your shareable profile link</p>
                  <p className="text-sm text-gray-300 truncate font-mono">{profileUrl || `/creator/${creator.id}`}</p>
                </div>
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(profileUrl);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    } catch {
                      setCopied(false);
                    }
                  }}
                  disabled={!profileUrl}
                  className="shrink-0 text-xs px-4 py-2 rounded-md border border-brand-gold/40 text-brand-gold hover:bg-brand-gold/10 transition disabled:opacity-50"
                >
                  {copied ? 'Copied!' : 'Copy Link'}
                </button>
              </div>

              <div className="flex items-center gap-4">
                {creator.img ? (
                  <img src={creator.img} alt={creator.name} className="w-20 h-20 rounded-full object-cover object-top border-2 border-brand-gold" />
                ) : (
                  <div className="w-20 h-20 rounded-full bg-brand-purple/30 border-2 border-brand-gold" />
                )}
                <div>
                  <p className="font-bold text-white flex items-center gap-1 mb-2">
                    {creator.name}
                    {creator.premium && <SolidIcons.verified className="h-4 w-4 text-brand-pink" title="Premium" />}
                  </p>
                  <label className={`premium-button inline-block cursor-pointer text-sm py-2 px-4 ${busy || isRestricted ? 'opacity-50 pointer-events-none' : ''}`}>
                    Change PFP
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif,image/avif,image/heic,image/heif"
                      className="hidden"
                      disabled={busy || isRestricted}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        uploadAvatar(file);
                      }}
                    />
                  </label>
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Display Name</label>
                  <input value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Handle</label>
                  <input value={draft.handle} maxLength={40} onChange={(e) => setDraft({ ...draft, handle: e.target.value })} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Price text on your profile</label>
                  <input value={draft.price} maxLength={40} onChange={(e) => setDraft({ ...draft, price: e.target.value })} placeholder="e.g. Free" className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
                  <p className="text-[11px] text-gray-500 mt-1">
                    Display text only — subscriptions aren&apos;t sold on OnlyOne yet, so nobody is charged this.
                  </p>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Price for a fan to message you ($)</label>
                  <input
                    value={draft.dmPrice}
                    inputMode="decimal"
                    onChange={(e) => setDraft({ ...draft, dmPrice: e.target.value })}
                    placeholder={`${(DM_PRICE_FLOOR_CENTS / 100).toFixed(2)} (default)`}
                    className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white"
                  />
                  <p className="text-[11px] text-gray-500 mt-1">
                    Every message a fan sends you costs this in credits (${(DM_PRICE_FLOOR_CENTS / 100).toFixed(2)} minimum,
                    ${(DM_PRICE_MAX_CENTS / 100).toFixed(2)} maximum). You earn it less the {PLATFORM_FEE_PCT}% platform fee.
                    Your replies are free. Leave blank for the ${(DM_PRICE_FLOOR_CENTS / 100).toFixed(2)} default.
                  </p>
                </div>
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-2">Bio</label>
                <textarea value={draft.bio} maxLength={1000} onChange={(e) => setDraft({ ...draft, bio: e.target.value })} rows={3} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-2">Tags (up to 8 — how fans find you when browsing)</label>
                <input
                  value={draft.tags}
                  onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                  placeholder="e.g. cosplay, gym, redhead, asmr"
                  className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white"
                />
                {/* Click-to-add suggestions, grouped. The free-text box above
                    still takes anything -- this exists so two creators who
                    both mean "feet" end up on the SAME tag instead of two
                    spellings that never find each other in search, and so a
                    niche a creator hasn't thought to type is right there. */}
                <div className="mt-3 space-y-2.5">
                  {TAG_GROUPS.map((group) => (
                    <div key={group.label} className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] font-bold tracking-wide text-gray-500 mr-1 shrink-0">
                        {group.label}:
                      </span>
                      {group.tags.map((t) => {
                        const current = draft.tags.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
                        const active = current.includes(t);
                        return (
                          <button
                            type="button"
                            key={t}
                            onClick={() => {
                              if (active) {
                                setDraft({ ...draft, tags: current.filter((x) => x !== t).join(', ') });
                              } else if (current.length < 8) {
                                setDraft({ ...draft, tags: [...current, t].join(', ') });
                              }
                            }}
                            className={`text-xs px-2.5 py-1 rounded-full border transition ${
                              active
                                ? 'bg-brand-pink border-brand-pink text-white font-bold'
                                : 'border-white/15 text-gray-400 hover:border-brand-pink/50 hover:text-white'
                            }`}
                          >
                            #{t}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
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
                  Enforced server-side (lib/token-gate.js, lib/holder-access.js):
                  while the gate is on, a gated creator's photo and video srcs
                  are never sent to anyone who hasn't proven the holding. */}
              <div className="rounded-md border border-brand-purple/30 bg-black/20 p-4">
                <label className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!draft.locked}
                    onChange={(e) => setDraft({ ...draft, locked: e.target.checked })}
                  />
                  Token-gate my photos and videos
                </label>
                <p className="text-xs text-gray-500 mt-2">
                  Fans have to <strong>hold</strong> $ONLYONE to see your photos and videos. They unlock by signing a
                  message with a wallet that holds the amount — nothing is spent, and you aren&apos;t paid from it. It&apos;s
                  a gate, not a price. Your name, bio and marketplace listings stay visible to everyone, and you always
                  see your own page.
                </p>
                {draft.locked && (
                  <div className="mt-3">
                    <label className="block text-xs text-gray-400 mb-2">How many $ONLYONE must they hold?</label>
                    <input
                      type="number"
                      min="1"
                      max={MAX_GATE_TOKENS}
                      step="1"
                      value={draft.gateTokens}
                      onChange={(e) => setDraft({ ...draft, gateTokens: e.target.value })}
                      placeholder="e.g. 2500000"
                      className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
                    />
                    {!sanitizeGateTokens(draft.gateTokens) ? (
                      <p className="text-xs text-yellow-400/80 mt-2">
                        Set a number above zero — a gate with no amount doesn&apos;t gate anything, and your page
                        stays open.
                      </p>
                    ) : !gateVerifierLive ? (
                      <p className="text-xs text-yellow-400/80 mt-2">
                        Wallet verification is switched off on the platform right now, so while this is on nobody but
                        you can see your gated photos and videos — fans have no way to unlock them until it&apos;s back.
                      </p>
                    ) : (
                      <p className="text-xs text-gray-500 mt-2">
                        Anyone who hasn&apos;t proven they hold at least {sanitizeGateTokens(draft.gateTokens).toLocaleString()} $ONLYONE
                        sees locked tiles instead of your photos and videos.
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Age</label>
                  <input
                    type="number"
                    min="18"
                    max="99"
                    value={draft.age}
                    onChange={(e) => setDraft({ ...draft, age: e.target.value })}
                    placeholder="Optional"
                    className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Location</label>
                  <input
                    value={draft.location}
                    maxLength={80}
                    onChange={(e) => setDraft({ ...draft, location: e.target.value })}
                    placeholder="e.g. Los Angeles, CA"
                    className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
                  />
                </div>
              </div>
              <p className="text-xs text-gray-500 -mt-2">
                Both show on your public profile. Leave them blank to keep them off it — plenty of creators do.
              </p>

              <div>
                <label className="block text-sm text-gray-400 mb-2">Payout Wallet Address ({SETTLE_ASSET})</label>
                <input
                  value={draft.walletAddress}
                  maxLength={120}
                  onChange={(e) => setDraft({ ...draft, walletAddress: e.target.value })}
                  placeholder="0x..."
                  aria-invalid={!!walletError}
                  className={`w-full px-4 py-3 rounded-md bg-black/40 border text-white font-mono text-sm ${walletError ? 'border-red-500/60' : 'border-brand-purple/30'}`}
                />
                {walletError && <p className="text-xs text-red-400 mt-1">{walletError}</p>}
              </div>
              <p className="text-xs text-gray-500 -mt-2">
                Payouts are {SETTLE_ASSET} only — the dollar stablecoin on {process.env.NEXT_PUBLIC_MARKETPLACE_CHAIN_NAME || 'Robinhood Chain'},
                worth $1 each — sent to this wallet. Bridge it out and it arrives as {BRIDGE_ASSET}, which Coinbase accepts.
                Double-check the address: a payout sent to the wrong one can&apos;t be recovered. The platform keeps
                {` ${PLATFORM_FEE_PCT}%`} of paid messages and {MARKETPLACE_FEE_PCT}% of marketplace sales ({PLATFORM_FEE_PCT}% platform
                fee + {LISTING_FEE_PCT}% listing fee) when a fan spends — what lands in your balance below is already net.
                {founding?.isFounding && ' As a Founding Creator you pay neither fee during your fee-free window (see below).'}
              </p>

              <button onClick={saveProfile} disabled={busy || isRestricted || !!walletError} className="premium-button disabled:opacity-50">
                Save Profile
              </button>

              <CashOutPanel
                creator={creator}
                effectiveStatus={creatorStatus}
                savedWallet={creator.walletAddress || ''}
                walletDirty={walletDirty}
              />

              <hr className="border-brand-purple/20" />

              <ShareKit
                creator={creator}
                foundingLeft={foundingLeft}
                founding={founding}
                origin={origin}
                publiclyVisible={publiclyVisible}
                signupsOpen={signupsAreOpen}
              />

              <hr className="border-brand-purple/20" />

              <div>
                {(() => {
                  const limit = creator.premium ? 200 : 50;
                  const used = creator.gallery?.length || 0;
                  const atLimit = used >= limit || isRestricted;
                  return (
                    <>
                      {/* A creator will ask whether their content is safe.
                          Telling them it can't be copied, or that every
                          viewer is marked, would be a lie they'd find out
                          about the hard way -- so this says exactly what is
                          and isn't true today. */}
                      <div className="mb-4 px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-xs text-gray-400 leading-relaxed">
                        <p className="text-brand-gold font-bold text-sm mb-1">How your content is protected</p>
                        <p>
                          Your files sit in private storage and are only handed out through OnlyOne, never at a
                          permanent public link. Right-click saving, dragging and the phone long-press &quot;Save Image&quot;
                          menu are blocked on your page.
                        </p>
                        <p className="mt-2">
                          Viewers who are logged in see a faint code over your photos and videos that identifies their
                          account, so a screenshot from a logged-in viewer points back to them. Be clear about the limits:
                          visitors who aren&apos;t logged in see your content with no code on it, and the code is drawn
                          over the picture on the page rather than stamped into the file itself, so a copy of the file
                          carries no mark.
                        </p>
                        <p className="mt-2">
                          What no website can do is block a screenshot. The browser has to hand the picture to the
                          operating system to show it to anyone, and the screenshot tool reads it from there. Anyone
                          claiming otherwise is selling something. If you want only paying or holding fans to see
                          something, sell it on the Marketplace or turn on token-gating above.
                        </p>
                      </div>
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="font-bold text-brand-gold">Your Content ({used}/{limit})</h3>
                        {atLimit ? (
                          <span className="text-xs px-4 py-2 rounded-md border border-brand-purple/30 text-gray-500">
                            {isRestricted ? 'Uploads disabled' : 'Slots full'}
                          </span>
                        ) : (
                          <label className={`premium-button inline-block cursor-pointer text-sm py-2 px-4 ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
                            {busy ? 'Working...' : 'Upload'}
                            <input
                              type="file"
                              accept="image/*,video/mp4,video/quicktime,video/webm"
                              className="hidden"
                              disabled={busy}
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                e.target.value = '';
                                if (!file) return;
                                uploadContent(file, nextUploadIsAi);
                                setNextUploadIsAi(false);
                              }}
                            />
                          </label>
                        )}
                      </div>
                      {!atLimit && (
                        <label className="flex items-center gap-2 text-xs text-gray-400 mb-2 cursor-pointer">
                          <input type="checkbox" checked={nextUploadIsAi} onChange={(e) => setNextUploadIsAi(e.target.checked)} />
                          This upload is AI-generated or synthetic content (will be labeled &quot;AI&quot; on your profile)
                        </label>
                      )}
                      {!creator.premium && (
                        <p className="text-xs text-gray-500 mb-3">
                          Free accounts get 50 content slots. Premium creators get 200 and a gold check — contact us to upgrade.
                        </p>
                      )}
                      <p className="text-xs text-gray-500 mb-3">Photos up to 25MB, videos (MP4, MOV, WebM) up to 50MB.</p>
                    </>
                  );
                })()}
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                  {(creator.gallery || []).map((item, i) => (
                    <div key={item.src || i} className="relative aspect-square rounded-md overflow-hidden border border-brand-purple/20 group">
                      {item.type === 'video' ? (
                        <video src={item.src} className="w-full h-full object-cover" muted playsInline preload="metadata" />
                      ) : (
                        <img src={item.src} alt="" className="w-full h-full object-cover" />
                      )}
                      {item.aiGenerated && (
                        <span className="absolute bottom-1 left-1 text-[9px] px-1.5 py-0.5 rounded bg-black/70 text-brand-gold font-bold">AI</span>
                      )}
                      {!isRestricted && (
                        <button
                          onClick={() => deleteItem(item, i)}
                          disabled={busy}
                          aria-label="Remove this item"
                          className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-white text-xs opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition disabled:opacity-30"
                        >
                          <Icons.close className="h-3.5 w-3.5 mx-auto" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <hr className="border-brand-purple/20" />

              <MarketplaceSection
                listings={listings}
                busy={busy}
                disabled={isRestricted}
                creatorStatus={creatorStatus}
                isDemo={isDemo}
                founding={founding}
                paymentsLive={paymentsLive}
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
 *
 * What the link actually does, stated plainly because the old copy promised
 * more: signup (pages/api/auth/signup.js) records a referral only when the
 * referring creator is publicly visible at that moment, only while account
 * signups are open at all, and no referral reward is paid today.
 */
function ShareKit({ creator, foundingLeft, founding, origin, publiclyVisible, signupsOpen }) {
  const [copiedField, setCopiedField] = useState('');

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

  const isFounding = !!founding?.isFounding;
  const gaps = foundingProfileGaps(creator);

  return (
    <div>
      <h3 className="font-bold text-brand-gold mb-2">Share Your Page</h3>

      {/* Not founding yet, slots still open: say exactly what is missing.
          The programme is decided automatically at approval, so a creator who
          is told "finish these four things" can actually act on it -- which is
          the difference between a perk and a lottery. */}
      {!isFounding && foundingLeft > 0 && gaps.length > 0 && (
        <div className="mb-4 px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-sm">
          <p className="font-bold text-brand-gold">
            {foundingLeft} Founding Creator {foundingLeft === 1 ? 'spot' : 'spots'} left
          </p>
          <p className="text-gray-400 mt-1">
            The first 100 creators approved with a finished profile get the badge, priority placement and
            a {FEE_WAIVER_DAYS}-day fee-free window. Yours still needs:
          </p>
          <ul className="list-disc pl-5 mt-2 text-gray-300 space-y-1">
            {gaps.map((g) => <li key={g}>{g}</li>)}
          </ul>
        </div>
      )}
      {!isFounding && foundingLeft > 0 && gaps.length === 0 && (
        <div className="mb-4 px-4 py-3 rounded-md bg-black/40 border border-brand-gold/30 text-sm">
          <p className="font-bold text-brand-gold">Your profile qualifies for Founding Creator</p>
          <p className="text-gray-400 mt-1">
            {foundingLeft} of 100 {foundingLeft === 1 ? 'spot is' : 'spots are'} left. The badge is granted
            when your profile is approved.
          </p>
        </div>
      )}

      {isFounding && (
        <div className="mb-4 px-4 py-3 rounded-md bg-brand-gold/10 border border-brand-gold/30 text-sm">
          <p className="font-black tracking-wide text-brand-gold inline-flex items-center gap-1.5"><SolidIcons.star className="h-4 w-4" />FOUNDING CREATOR</p>
          <p className="text-gray-300 mt-1">
            {founding.pending
              ? `Your ${FEE_WAIVER_DAYS} fee-free days start once your founding date is recorded — ask us if this doesn't update after approval.`
              : founding.active && founding.endsAt
                ? `You pay 0% — no platform fee and no listing fee — on your marketplace sales and paid messages until ${formatDate(founding.endsAt)}. You keep 100% of what fans spend on you until then.`
                : founding.endsAt && Date.parse(founding.endsAt) > Date.now()
                  ? `Your ${FEE_WAIVER_DAYS} fee-free days (no platform fee and no listing fee) run until ${formatDate(founding.endsAt)}.`
                  : `Your ${FEE_WAIVER_DAYS}-day fee-free window has ended. The badge and priority placement are permanent.`}
          </p>
        </div>
      )}

      {!handle ? (
        <p className="text-sm text-gray-400">Set a handle above and save your profile to get your referral link.</p>
      ) : (
        <>
          <p className="text-sm text-gray-400 mb-2">
            Fans who sign up within 30 days of first clicking this link are recorded as your referrals. Referral rewards
            aren&apos;t live yet — nothing is paid for referrals today.
          </p>
          {!signupsOpen && (
            <p className="text-xs text-brand-gold mb-2">
              New account signups are closed right now, so nobody can join through the link yet. Visitors can still
              browse and join the waitlist.
            </p>
          )}
          {!publiclyVisible && (
            <p className="text-xs text-brand-gold mb-2">
              Your profile isn&apos;t publicly visible yet, so signups through your link aren&apos;t recorded as yours
              until it is approved and live.
            </p>
          )}

          <label className="block text-xs text-gray-500 mb-2 mt-3">YOUR REFERRAL LINK</label>
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

const BLANK_LISTING_FORM = { title: '', description: '', price: '', unlimited: true, physical: false, shipping: '', signatureRequired: false, aiGenerated: false, tags: '' };

function MarketplaceSection({ listings, busy, disabled, creatorStatus, isDemo, founding, paymentsLive, onCreate, onUploadMedia, onToggleStatus }) {
  const [form, setForm] = useState(BLANK_LISTING_FORM);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    const priceCents = dollarsToCents(form.price);
    // Says why instead of returning silently. A blank title or a price under
    // $1 made the Create button look broken -- nothing happened and nothing
    // explained it.
    if (!form.title.trim()) {
      setFormError('Give the listing a title.');
      return;
    }
    if (priceCents === null || priceCents < LISTING_LIMITS.minPriceCents) {
      setFormError(`Set a price of at least $${(LISTING_LIMITS.minPriceCents / 100).toFixed(2)}.`);
      return;
    }
    if (priceCents > LISTING_LIMITS.maxPriceCents) {
      setFormError(`Price can be at most $${(LISTING_LIMITS.maxPriceCents / 100).toLocaleString()}.`);
      return;
    }
    let shippingCents;
    if (form.physical) {
      shippingCents = String(form.shipping).trim() === '' ? 0 : dollarsToCents(form.shipping);
      if (shippingCents === null || shippingCents > LISTING_LIMITS.maxShippingCents) {
        setFormError(`Set a shipping fee from $0 to $${(LISTING_LIMITS.maxShippingCents / 100).toLocaleString()}.`);
        return;
      }
    }
    setFormError('');
    setCreating(true);
    const listing = await onCreate({
      title: form.title, description: form.description, priceCents, unlimited: form.unlimited,
      kind: form.physical ? 'physical' : 'digital', shippingCents,
      signatureRequired: form.physical && form.signatureRequired,
      aiGenerated: form.aiGenerated,
      tags: form.tags,
    });
    setCreating(false);
    if (listing) setForm(BLANK_LISTING_FORM);
  };

  const canSellNow = creatorStatus === 'active' && !isDemo;

  return (
    <div>
      <h3 className="font-bold text-brand-gold mb-3">Sell on the Marketplace (shoponeonly.com)</h3>
      <p className="text-xs text-gray-500 mb-4">
        List images, videos, or anything else at whatever price you want (${(LISTING_LIMITS.minPriceCents / 100).toFixed(2)}
        {' '}to ${(LISTING_LIMITS.maxPriceCents / 100).toLocaleString()}). When it sells the platform keeps
        {` ${MARKETPLACE_FEE_PCT}%`} — a {PLATFORM_FEE_PCT}% platform fee plus a {LISTING_FEE_PCT}% listing fee — and the rest is
        credited to your balance.
        {founding?.isFounding && ' During your Founding Creator fee-free window neither fee is charged.'}{' '}
        {paymentsLive
          ? `Buying is live: fans pay with credits they bought with ${SETTLE_ASSET}, so they need a crypto wallet to buy credits but not to spend them.`
          : "Buying isn't switched on right now — listings show up on the Marketplace but can't be bought until it is."}
      </p>
      {!canSellNow && (
        <p className="text-xs text-brand-gold mb-4">
          {isDemo
            ? 'This is a demo profile, so its listings are labelled "Demo — not for sale" and can\'t be bought.'
            : creatorStatus === 'pending'
              ? 'Your listings stay hidden and can\'t be bought until your profile is approved.'
              : creatorStatus === 'suspended'
                ? 'Your listings are hidden and can\'t be bought while your account is suspended.'
                : creatorStatus === 'banned'
                  ? 'Your listings have been taken down and can\'t be bought.'
                  : 'Your listings can\'t be bought right now.'}
        </p>
      )}

      <form onSubmit={submit} className="grid sm:grid-cols-2 gap-3 mb-6">
        <input
          value={form.title}
          maxLength={140}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          placeholder="Title"
          className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
        />
        <input
          value={form.price}
          onChange={(e) => setForm({ ...form, price: e.target.value })}
          placeholder="Price (USD)"
          type="number"
          min={LISTING_LIMITS.minPriceCents / 100}
          max={LISTING_LIMITS.maxPriceCents / 100}
          step="0.01"
          className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
        />
        <textarea
          value={form.description}
          maxLength={4000}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="Description"
          rows={2}
          className="sm:col-span-2 w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
        />

        <div className="sm:col-span-2">
          <input
            value={form.tags}
            onChange={(e) => setForm({ ...form, tags: e.target.value })}
            placeholder="Tags (up to 8 — how fans find this while browsing)"
            className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
          />
          {/* Same picker pattern as the creator's own profile tags -- the
              free-text box above still takes anything, this exists so
              "feet", "used" and "worn" mean the same thing across every
              listing instead of three creators spelling it three ways. */}
          <div className="mt-2 space-y-2">
            {LISTING_TAG_GROUPS.map((group) => (
              <div key={group.label} className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] font-bold tracking-wide text-gray-500 mr-1 shrink-0">
                  {group.label}:
                </span>
                {group.tags.map((t) => {
                  const current = form.tags.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
                  const active = current.includes(t);
                  return (
                    <button
                      type="button"
                      key={t}
                      onClick={() =>
                        setForm({
                          ...form,
                          tags: active
                            ? current.filter((x) => x !== t).join(', ')
                            : current.length < 8
                              ? [...current, t].join(', ')
                              : form.tags,
                        })
                      }
                      className={`text-[11px] px-2 py-0.5 rounded-full border transition ${
                        active
                          ? 'bg-brand-gold border-brand-gold text-black font-bold'
                          : 'border-brand-purple/30 text-gray-500 hover:border-brand-gold/50 hover:text-gray-300'
                      }`}
                    >
                      #{t}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
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
          AI-generated or synthetic content (will be labeled &quot;AI&quot; on the listing)
        </label>
        {form.physical && (
          <>
            <input
              value={form.shipping}
              onChange={(e) => setForm({ ...form, shipping: e.target.value })}
              placeholder="Shipping fee (USD, 0 for free shipping)"
              type="number"
              min="0"
              max={LISTING_LIMITS.maxShippingCents / 100}
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
        {formError && <p className="text-sm text-red-400">{formError}</p>}
        <button type="submit" disabled={creating || busy || disabled} className="premium-button text-sm disabled:opacity-50">
          Create Listing
        </button>
      </form>

      <p className="text-xs text-gray-500 mb-3">
        Shoppers who haven&apos;t bought a listing only ever see a small blurred preview of its photos and videos;
        buyers of a digital listing get the full files from their Orders page.
      </p>

      <div className="space-y-4">
        {listings.length === 0 ? (
          <p className="text-sm text-gray-500">No listings yet.</p>
        ) : (
          listings.map((l) => {
            const editable = l.status !== 'sold' && !l.moderationRemoved;
            const mediaCount = (l.media || []).length;
            return (
              <div key={l.id} className="premium-card border border-brand-purple/20 p-4">
                <div className="flex items-center justify-between mb-2 gap-3">
                  <div className="min-w-0">
                    <p className="font-bold text-white">
                      {l.title} — ${(l.priceCents / 100).toFixed(2)}
                      {(l.demo === true || isDemo) && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-gray-300 align-middle">Demo — not for sale</span>}
                    </p>
                    <p className="text-xs text-gray-500">
                      {l.moderationRemoved ? 'removed by moderation' : l.status} · {l.unlimited ? 'unlimited' : 'one-of-a-kind'}
                      {l.kind === 'physical' && ` · ships to buyer${l.shippingCents ? ` (+$${(l.shippingCents / 100).toFixed(2)} shipping)` : ' (free shipping)'}${l.signatureRequired ? ' · signature required' : ''}`}
                      {l.aiGenerated && ' · AI'}
                    </p>
                    {Array.isArray(l.tags) && l.tags.length > 0 && (
                      <p className="text-xs text-brand-gold mt-1">{l.tags.map((t) => `#${t}`).join(' ')}</p>
                    )}
                  </div>
                  {/* 'sold' is terminal and a moderation removal can't be
                      undone by the creator -- the server refuses both, so no
                      button that can only fail. */}
                  {editable && (
                    <button
                      onClick={() => onToggleStatus(l.id, l.status === 'active' ? 'removed' : 'active')}
                      disabled={busy || disabled}
                      className="shrink-0 text-xs px-3 py-1.5 rounded-md border border-brand-purple/30 text-gray-300 hover:bg-white/5 transition disabled:opacity-50"
                    >
                      {l.status === 'active' ? 'Remove' : 'Reactivate'}
                    </button>
                  )}
                </div>
                {l.moderationRemoved && (
                  <p className="text-xs text-red-400 mb-2">This listing was taken down by moderation and can&apos;t be relisted.</p>
                )}
                <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                  {(l.media || []).map((item, i) => (
                    <div key={item.src || i} className="relative aspect-square rounded-md overflow-hidden border border-brand-purple/20">
                      {item.type === 'video' ? (
                        <video src={item.src} className="w-full h-full object-cover" muted playsInline preload="metadata" />
                      ) : (
                        <img src={item.src} alt="" className="w-full h-full object-cover" />
                      )}
                      {!item.preview && (
                        <span className="absolute bottom-0.5 left-0.5 text-[8px] px-1 rounded bg-black/70 text-gray-300" title="Shoppers see a placeholder for this item">
                          no preview
                        </span>
                      )}
                    </div>
                  ))}
                  {editable && mediaCount < LISTING_LIMITS.maxMedia && (
                    <label className={`aspect-square rounded-md border border-dashed border-brand-purple/30 flex items-center justify-center text-xs text-gray-500 cursor-pointer hover:bg-white/5 transition ${busy || disabled ? 'opacity-50 pointer-events-none' : ''}`}>
                      + Add
                      <input
                        type="file"
                        accept="image/*,video/mp4,video/quicktime,video/webm"
                        className="hidden"
                        disabled={busy || disabled}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = '';
                          onUploadMedia(l.id, file);
                        }}
                      />
                    </label>
                  )}
                </div>
              </div>
            );
          })
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
