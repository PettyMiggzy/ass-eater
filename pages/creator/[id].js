import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import ProtectedMedia, { GUEST_MARK } from '../../components/ProtectedMedia';
import { getCreators } from '../../lib/creators-store';
import { toPublicCreator, toPublicListing, isPubliclyVisible, effectiveCreatorStatus, listingHasDeliverable } from '../../lib/creator-status';
import { getSessionUser } from '../../lib/session';
import { findUserByCreatorId } from '../../lib/users-store';
import { getListings } from '../../lib/listings-store';
import { getWallPageForCreator, toPublicWallPost, wallBlockFlagsFor, MAX_TEXT_LENGTH as WALL_MAX_TEXT_LENGTH } from '../../lib/wall-store';
import { MAX_MESSAGE_LENGTH } from '../../lib/messages-store';
import { isFavorite } from '../../lib/favorites-store';
import { viewerMarkFor } from '../../lib/viewer-mark';
import { holderGateState } from '../../lib/holder-access';
import { tokenGateLive, formatGate } from '../../lib/token-gate';
import { DM_PRICE_FLOOR_CENTS, formatCredits } from '../../lib/brand';
import { feeWaiverActive } from '../../lib/founding';
import { FoundingBadge, Icons, SolidIcons, Tagline, pickTagline } from '../../components/Brand';
import SiteNav from '../../components/SiteNav';
import DemoBadge from '../../components/public/DemoBadge';
import PremiumBadge from '../../components/public/PremiumBadge';
import ListingPreview from '../../components/public/ListingPreview';
import ReportModal, { postReport, takedownFormHref } from '../../components/public/ReportModal';
import MediaLightbox from '../../components/public/MediaLightbox';
import LengthCounter from '../../components/public/LengthCounter';
import TokenUnlockPanel from '../../components/public/TokenUnlockPanel';
import { isDemoCreator, isDemoListing, DEMO_LABEL, marketplaceHrefFor } from '../../components/public/cards';

export async function getServerSideProps({ req, params }) {
  const creators = await getCreators();
  let creator = creators.find((c) => String(c.id) === String(params.id)) || null;
  const sessionUser = await getSessionUser(req).catch(() => null);
  const viewerId = sessionUser ? sessionUser.id : null;
  const creatorUser = creator ? await findUserByCreatorId(creator.id) : null;

  // Pending applicants, suspended, and banned creators aren't public --
  // only the account owner (once they've claimed a login) can preview
  // their own pending/suspended profile; a banned creator is hidden even
  // from themselves.
  if (creator && !isPubliclyVisible(creator)) {
    const isOwner = String(viewerId) === String(creatorUser?.id);
    if (effectiveCreatorStatus(creator) === 'banned' || !isOwner) creator = null;
  }

  // Token gate, decided HERE and nowhere else: toPublicCreator strips a gated
  // creator's media srcs unless this viewer is the owner or a holder whose
  // balance the server just read (lib/holder-access.js). The page never
  // receives a src it is not allowed to show, so there is nothing for a CSS
  // blur to hide.
  const gate = creator
    ? await holderGateState(req, creator, { user: sessionUser })
    : { allowed: false, reason: 'no_creator' };
  const viewerMayUnlock = gate.allowed === true;

  // Listings reach the page through toPublicListing: a tiny blurred preview
  // per item and never a src -- the files go only to buyers, via
  // /api/marketplace/orders/delivery.
  const allListings = creator ? await getListings() : [];
  const listings = allListings
    // listingHasDeliverable: a digital listing with no files can't be bought
    // (checkout refuses it), so it isn't shown for sale. Checked on the stored
    // record, before toPublicListing strips the srcs it looks at.
    .filter((l) => String(l.creatorId) === String(creator?.id) && l.status === 'active' && listingHasDeliverable(l))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((l) => ({ ...toPublicListing(l, creator), demo: isDemoListing(l, creator) }));

  // Wall comments in their public shape: `mine` instead of every
  // commenter's account id. Only the newest page is server-rendered; the
  // Wall's "Show older" button pages back with nextBefore.
  const wallPage = creator
    ? await getWallPageForCreator(creator.id)
    : { posts: [], hasMore: false, nextBefore: null };
  // The wall's owner also gets `authorBlocked` per comment (whether they have
  // blocked its author), so Block/Unblock is right after a reload. Same rule
  // as /api/wall/list: the owner only, and never the author's id.
  const viewerOwnsWall = !!creator && !!viewerId && !!creatorUser && String(viewerId) === String(creatorUser.id);
  const wallBlockFlags = viewerOwnsWall ? await wallBlockFlagsFor(viewerId, wallPage.posts) : null;
  const wallPosts = wallPage.posts.map((p) => toPublicWallPost(
    p,
    viewerId,
    wallBlockFlags ? { authorBlocked: wallBlockFlags.get(String(p.id)) === true } : {},
  ));
  const initialFavorited = creator && viewerId ? await isFavorite(viewerId, creator.id) : false;
  // Computed server-side: the mark is an HMAC and the key never leaves the
  // server. See lib/viewer-mark.js. '' for a signed-out visitor -- the page
  // then shows a generic site mark and says plainly that it is not traceable.
  const viewerMark = viewerMarkFor(viewerId);

  // What a message to this creator costs THIS viewer: fans (and creator
  // accounts that are not live yet) pay the creator's price, never less than
  // the platform floor; a live creator messages another creator for free.
  // Display only -- /api/messages/send decides and charges.
  const viewerCreator = sessionUser?.creatorId
    ? creators.find((c) => String(c.id) === String(sessionUser.creatorId)) || null
    : null;
  const viewerIsLiveCreator =
    !!viewerCreator && effectiveCreatorStatus(viewerCreator) === 'active' && !isDemoCreator(viewerCreator);
  const ownPrice = Number.isInteger(creator?.dmPriceCents) ? creator.dmPriceCents : 0;
  const dmPriceCents = viewerIsLiveCreator ? 0 : Math.max(DM_PRICE_FLOOR_CENTS, ownPrice);
  // A Founding Creator inside their 0% window keeps the whole price:
  // lib/credits-store.js transferWithFee takes no fee while feeWaiverActive()
  // is true for the recipient. Decided from the full stored record (founding,
  // foundingSince), which toPublicCreator does not pass down. Display only --
  // the charge stays authoritative (round-18 public-pages#1).
  const dmFeeWaived = !!creator && feeWaiverActive(creator);

  return {
    props: {
      creator: creator ? toPublicCreator(creator, { viewerMayUnlock }) : null,
      viewerId: viewerId ? String(viewerId) : null,
      viewerMark,
      // Must be re-checked against the post-visibility-check `creator`
      // (null'd out above for a hidden profile), not the original
      // `creatorUser` lookup -- otherwise a pending/suspended/banned
      // creator's real internal account id still reaches the page's
      // __NEXT_DATA__ JSON even while the page itself correctly renders
      // "Creator not found".
      creatorUserId: creator && creatorUser ? String(creatorUser.id) : null,
      gate: {
        allowed: gate.allowed === true,
        reason: gate.reason || null,
        required: gate.required ?? null,
        held: gate.held ?? null,
      },
      tokenLive: tokenGateLive(),
      demo: isDemoCreator(creator),
      dmPriceCents,
      // Formatted HERE, once, with fixed locale rules: the same number
      // formatted by the server and again by the browser (whose locale may
      // differ) was a hydration mismatch on every page view.
      dmPriceLabel: dmPriceCents > 0 ? formatCredits(dmPriceCents) : '',
      dmFeeWaived,
      gateLabel: creator ? formatGate(creator) : '',
      listings,
      wallPosts,
      wallNextBefore: wallPage.hasMore ? wallPage.nextBefore : null,
      // The servers' own length limits, passed down rather than imported into
      // client code (those stores pull in the Postgres driver). The composers
      // show a counter against them and refuse over-length text before
      // sending -- never a maxLength attribute, which silently cuts a paste
      // (round-20 public-pages#0).
      dmMaxLength: MAX_MESSAGE_LENGTH,
      wallMaxLength: WALL_MAX_TEXT_LENGTH,
      initialFavorited,
    },
  };
}

// Fixed locale and time zone: the server (UTC, en-US) and the viewer's
// browser must print the same date, or React reports a hydration mismatch.
function formatWallDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
}

// A locked item has no src (toPublicCreator stripped it), so it is drawn
// from nothing but its type: the creator's public avatar, blurred, under a
// padlock. It carries no mark -- there is nothing identifiable to leak.
//
// Module scope on purpose. Declared inside CreatorProfile it was a NEW
// component type every render, so any state change on the page (opening the
// lightbox, a toast, a favorite toggle, switching tabs) unmounted and
// remounted every tile -- and each remount re-requested /api/media, which
// answers no-store with a freshly presigned redirect, so nothing could be
// reused: one serverless call (plus a holder check for a gated creator) and
// a full re-download per tile, per state change.
function GalleryTile({ item, badge, locked, creatorImg, mark, onOpen, onReport, reportHref }) {
  const isLocked = locked || !!item?.locked || !item?.src;
  return (
    <div className="relative aspect-square rounded-xl overflow-hidden bg-white/5 border border-white/5">
      {isLocked ? (
        <>
          {creatorImg ? (
            <img src={creatorImg} alt="" className="w-full h-full object-cover blur-xl scale-110 opacity-60" draggable={false} />
          ) : (
            <div className="w-full h-full bg-gradient-to-br from-brand-pink/20 to-black/40" />
          )}
          <div className="absolute inset-0 flex items-center justify-center bg-black/25">
            <span className="w-10 h-10 rounded-full bg-black/60 flex items-center justify-center text-white"><SolidIcons.lock className="h-4 w-4" /></span>
          </div>
        </>
      ) : (
        <button
          type="button"
          onClick={() => onOpen(item)}
          aria-label={item.type === 'video' ? 'Play video' : 'View photo'}
          className="block w-full h-full"
        >
          <ProtectedMedia
            src={item.src}
            type={item.type === 'video' ? 'video' : 'image'}
            mark={mark}
            className="w-full h-full object-cover"
          />
          {item.type === 'video' && (
            <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span className="w-11 h-11 rounded-full bg-black/60 flex items-center justify-center text-white">
                <svg viewBox="0 0 20 20" className="h-5 w-5 ml-0.5" fill="currentColor" aria-hidden="true"><path d="M6 4l10 6-10 6z" /></svg>
              </span>
            </span>
          )}
        </button>
      )}
      {item?.aiGenerated && (
        <span className="absolute top-2 left-2 text-[10px] px-1.5 py-0.5 rounded bg-black/70 text-brand-pink font-bold pointer-events-none">AI</span>
      )}
      {badge && (
        <span className="absolute bottom-2 left-2 text-[11px] px-2 py-0.5 rounded bg-black/70 text-white font-semibold pointer-events-none">{badge}</span>
      )}
      {/* Only an item this viewer can actually see (it has a src) can be
          reported -- the server checks the src against the creator's
          current gallery. */}
      {/* Signed out (reportHref): /api/creator/report-media needs an
          account and signups may be closed, so the flag goes straight to the
          no-account takedown form, prefilled with this item. */}
      {!isLocked && onReport && (
        <button
          type="button"
          onClick={() => onReport(item)}
          title="Report this"
          aria-label="Report this photo or video"
          className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/60 text-white/80 hover:text-brand-pink flex items-center justify-center transition"
        >
          <Icons.flag className="h-3.5 w-3.5" />
        </button>
      )}
      {!isLocked && !onReport && reportHref && (
        <a
          href={reportHref(item)}
          title="Report this"
          aria-label="Report this photo or video"
          className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/60 text-white/80 hover:text-brand-pink flex items-center justify-center transition"
        >
          <Icons.flag className="h-3.5 w-3.5" />
        </a>
      )}
    </div>
  );
}

export default function CreatorProfile({
  creator,
  viewerId,
  viewerMark,
  creatorUserId,
  gate,
  tokenLive,
  demo,
  dmPriceCents,
  dmPriceLabel,
  dmFeeWaived,
  gateLabel,
  listings,
  wallPosts,
  wallNextBefore,
  dmMaxLength = 2000,
  wallMaxLength = 500,
  initialFavorited,
}) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState('posts');
  const [toast, setToast] = useState(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [favorited, setFavorited] = useState(initialFavorited);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const [viewing, setViewing] = useState(null);
  const closeViewer = useCallback(() => setViewing(null), []);
  // Reporting one item of this profile (a gallery photo/video or the avatar)
  // through POST /api/creator/report-media: { targetType, src, label }.
  const [reportingMedia, setReportingMedia] = useState(null);
  const [mediaReportNotice, setMediaReportNotice] = useState('');
  const [disconnectBusy, setDisconnectBusy] = useState(false);

  // /creators' "Hold to Unlock" links here with ?unlock=1 -- bring the
  // unlock control into view rather than leaving the visitor to find it.
  useEffect(() => {
    if (router.query.unlock !== '1') return;
    const el = document.getElementById('unlock');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [router.query.unlock]);

  const flash = (msg, ms = 3500) => {
    setToast(msg);
    setTimeout(() => setToast(null), ms);
  };

  // A possible-minor report puts the file on hold server-side at filing, so
  // the creator can't delete it before an admin looks (see the route).
  const submitMediaReport = async ({ reason, category }) => {
    await postReport('/api/creator/report-media', {
      creatorId: creator.id,
      targetType: reportingMedia.targetType,
      src: reportingMedia.src,
      reason,
      category,
    });
    setReportingMedia(null);
    setMediaReportNotice('Thanks — an admin will review it.');
  };
  const reportGalleryItem = useCallback(
    (item) => item?.src && setReportingMedia({ targetType: 'gallery_item', src: item.src, label: item.type === 'video' ? 'this video' : 'this photo' }),
    [],
  );

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
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      setFavorited(data.favorited);
    } catch (err) {
      setFavorited(prev);
      flash(err.message, 3000);
    } finally {
      setFavoriteBusy(false);
    }
  };

  const openInbox = () => {
    if (!viewerId) {
      router.push(`/login?next=/creator/${creator.id}`);
      return;
    }
    if (demo) {
      flash('This is a demo profile — it can’t receive messages.');
      return;
    }
    if (!creatorUserId) {
      // No login is attached to this profile, and nothing can attach one
      // yet, so nothing is promised (round-18 public-pages#2).
      flash("Messaging isn't available for this creator.");
      return;
    }
    if (String(viewerId) === String(creatorUserId)) {
      flash("That's you!");
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
  // Locked is the SERVER's decision for this viewer (holderGateState), not
  // "is this creator gated": the owner and a verified holder see the real,
  // watermarked media; everyone else gets items with no src at all.
  const locked = !gate?.allowed;
  const unlockedByWallet = gate?.reason === 'holds_enough';
  // A signed-in viewer's overlay carries their account code; a signed-out
  // visitor's carries only the site name, and the page says so.
  const overlayMark = viewerMark || GUEST_MARK;

  // Everything below is drawn from what this creator actually has. Counts
  // are their stored values, not invented ones, and a section with nothing
  // real behind it does not render at all rather than showing placeholders.
  const firstViewable = gallery.find((g) => g && !g.locked && g.src) || null;
  const featured = !locked && creator.video
    ? { type: 'video', src: creator.video }
    : firstViewable;
  const latestPosts = gallery.slice(0, 4);
  const morePosts = gallery.slice(4, 8);

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
  const socials = creator.socials || {};
  const websiteUrl = socials.website || null;
  const isOwner = !!viewerId && String(viewerId) === String(creatorUserId);

  const TABS = [
    { key: 'posts', label: 'Posts' },
    { key: 'media', label: 'Media' },
    { key: 'marketplace', label: 'Marketplace' },
    { key: 'about', label: 'About' },
  ];

  // Same contract as TokenUnlockPanel's disconnect (round-16 public-pages#0):
  // reload only once the server confirms the holder cookie is cleared. A
  // failed or refused request shows an error instead of re-rendering a page
  // that still reads "Unlocked" (and never escapes as an unhandled rejection).
  const disconnectWallet = async () => {
    if (disconnectBusy) return;
    setDisconnectBusy(true);
    try {
      const res = await fetch('/api/token-gate/clear', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) throw new Error('clear_failed');
      await router.replace(router.asPath, undefined, { scroll: false });
    } catch {
      flash('Could not disconnect. Please try again.');
    } finally {
      setDisconnectBusy(false);
    }
  };

  // What the takedown form's "where is the content" field is prefilled with
  // when a reporter follows the link out of the report dialog or the sidebar.
  const profileLocation = `Creator profile ${creator.handle || ''} (#${creator.id}) -- /creator/${creator.id}`;
  // In-product reports (ReportModal -> /api/creator/report-media) need a
  // signed-in account; a signed-out visitor is sent to the no-account
  // takedown form instead, prefilled with the item -- the same split
  // marketplace.js makes.
  const signedOut = !viewerId;
  const tileProps = {
    locked,
    creatorImg: creator.img,
    mark: overlayMark,
    onOpen: setViewing,
    onReport: isOwner || signedOut ? null : reportGalleryItem,
    reportHref: signedOut ? (item) => takedownFormHref({ content: `Gallery item ${item.src} on ${profileLocation}` }) : null,
  };

  const markNotice = (
    <p className="mt-4 text-[11px] text-gray-500 text-center">
      {viewerMark
        ? 'Content on this page carries a mark tied to your account. Sharing it outside OnlyOne is traceable back to you and is grounds for losing access.'
        : 'You’re browsing signed out, so this page carries only a site watermark, not one tied to you. Signed-in viewers see a mark that traces back to their account.'}
    </p>
  );

  return (
    <>
      <Head>
        <title>{`${creator.name} — ${creator.handle}`}</title>
      </Head>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] px-6 py-3 rounded-full bg-brand-pink text-white font-bold shadow-lg">
          {toast}
        </div>
      )}

      <MediaLightbox item={viewing} mark={overlayMark} onClose={closeViewer} />

      {reportingMedia && (
        <ReportModal
          title={reportingMedia.targetType === 'avatar' ? 'Report this profile photo' : `Report ${reportingMedia.label}`}
          subject={reportingMedia.targetType === 'avatar' ? 'this profile photo' : reportingMedia.label}
          onSubmit={submitMediaReport}
          onClose={() => setReportingMedia(null)}
          takedownContent={`${reportingMedia.targetType === 'avatar' ? 'Profile photo' : 'Gallery item'} ${reportingMedia.src} on ${profileLocation}`}
        />
      )}

      <div className="min-h-screen bg-brand-ink text-white pb-20">
        <SiteNav signedIn={!!viewerId} />

        <main className="max-w-6xl mx-auto px-4 md:px-6">
          {demo && (
            <div className="mt-4 px-4 py-3 rounded-xl border border-yellow-400/40 bg-yellow-400/10 text-sm text-yellow-100 flex flex-wrap items-center gap-2">
              <DemoBadge />
              <span>This is a sample profile made by OnlyOne to show how a creator page works. It isn&apos;t a real person and nothing on it can be bought or messaged.</span>
            </div>
          )}

          {/* Cover. Only ever the creator's public avatar or a video the
              viewer is allowed to see (a gated creator's video is not sent
              until unlocked), through ProtectedMedia like every other tile,
              carrying the same viewer mark the page says its content carries. */}
          <div className="relative mt-4 h-52 sm:h-64 md:h-72 rounded-2xl overflow-hidden bg-white/5">
            {!locked && creator.video ? (
              <ProtectedMedia src={creator.video} type="video" autoPlay mark={overlayMark} className="w-full h-full object-cover blur-sm scale-105" />
            ) : creator.img ? (
              <ProtectedMedia src={creator.img} type="image" mark={overlayMark} className="w-full h-full object-cover blur-sm scale-105" />
            ) : null}
            {/* Darkest at the bottom, where the identity row overlaps the
                cover, and again at top-right so the tagline stays readable
                regardless of what's underneath it -- a plain top-to-bottom
                fade left that corner exactly as bright as the photo. */}
            <div className="absolute inset-0 bg-gradient-to-t from-brand-ink via-brand-ink/20 to-transparent pointer-events-none" />
            <div className="absolute inset-0 bg-gradient-to-bl from-black/50 via-transparent to-transparent pointer-events-none" />
            <button
              onClick={() => router.push('/creators')}
              aria-label="Back to creators"
              className="absolute top-4 left-4 w-9 h-9 rounded-full bg-black/50 backdrop-blur flex items-center justify-center hover:bg-black/70 transition"
            >
              <Icons.arrowLeft className="h-5 w-5" />
            </button>
            <div className="absolute top-4 right-5 text-right">
              {/* A demo persona is AI-generated and the banner above says it
                  isn't a real person, so its cover never gets the rotation's
                  "Real People" line -- only the neutral one. */}
              <Tagline>{demo ? 'You’re Not Alone Here' : pickTagline(creator.handle)}</Tagline>
            </div>
          </div>

          {/* Identity row */}
          <div className="relative px-1 sm:px-4">
            <div className="flex flex-col sm:flex-row sm:items-end gap-4 -mt-14 sm:-mt-16">
              <div className="w-28 h-28 sm:w-36 sm:h-36 rounded-full border-4 border-brand-ink ring-2 ring-brand-pink/70 overflow-hidden bg-white/10 shrink-0">
                {creator.img && (
                  <ProtectedMedia src={creator.img} type="image" alt={creator.name} className="w-full h-full object-cover object-top" />
                )}
              </div>

              <div className="flex-1 sm:pb-2">
                <h1 className="text-3xl font-black flex items-center gap-2 flex-wrap">
                  {creator.name}
                  {creator.premium && <PremiumBadge />}
                  {creator.founding && (
                    <span
                      title="One of the first 100 creators on OnlyOne"
                      className="inline-flex items-center gap-1.5 text-[10px] tracking-[0.15em] pl-1 pr-2.5 py-1 rounded-full bg-brand-pink text-white font-black align-middle"
                    >
                      <FoundingBadge className="h-4 w-4" />
                      FOUNDING CREATOR
                    </span>
                  )}
                  {demo && <DemoBadge />}
                </h1>
                <p className="text-gray-400 text-sm">{creator.handle}</p>
                {(creator.age || creator.location) && (
                  <p className="text-gray-500 text-xs mt-1 flex items-center gap-2">
                    {creator.age && <span>{creator.age}</span>}
                    {creator.age && creator.location && <span aria-hidden="true">·</span>}
                    {creator.location && <span className="inline-flex items-center gap-1.5"><Icons.pin className="h-4 w-4 shrink-0" />{creator.location}</span>}
                  </p>
                )}
                {creator.bio && <p className="text-gray-300 text-sm mt-1 line-clamp-1">{creator.bio}</p>}
              </div>

              {/* Subscribe and Tip buttons used to sit here, wired to a
                  "coming soon" toast. Neither can be bought on this site, so
                  they are not offered; what CAN be bought (marketplace items,
                  paid messages) is. */}
              <div className="flex items-center gap-2 sm:pb-2">
                <button
                  onClick={toggleFavorite}
                  aria-pressed={favorited}
                  title={favorited ? 'Remove from saved' : 'Save creator'}
                  className={`w-11 h-11 rounded-full border flex items-center justify-center text-lg transition ${
                    favorited ? 'border-brand-pink bg-brand-pink/20 text-brand-pink' : 'border-white/15 text-white/70 hover:border-brand-pink/60'
                  }`}
                >
                  {favorited ? <SolidIcons.heart className="h-5 w-5" /> : <Icons.heart className="h-5 w-5" />}
                </button>
                {/* No Message button for a profile with no login behind it
                    (an admin-managed model that hasn't claimed an account):
                    /api/messages/send has nobody to deliver to, and the
                    Support card says messaging opens once they claim it. */}
                {!demo && creatorUserId && (
                  <button
                    onClick={openInbox}
                    className="px-5 h-11 rounded-full bg-brand-pink hover:bg-brand-pink-dark text-white font-bold text-sm transition"
                  >
                    Message
                  </button>
                )}
                {listings.length > 0 && (
                  <button
                    onClick={() => setActiveTab('marketplace')}
                    className="px-5 h-11 rounded-full border border-white/15 font-semibold text-sm hover:border-brand-pink/60 transition"
                  >
                    Shop
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Body */}
          <div className="grid lg:grid-cols-[300px_1fr] gap-6 mt-8 px-1 sm:px-4">
            {/* Sidebar */}
            <aside className="space-y-5">
              {/* Real counts only. Followers and Likes used to show here from
                  hand-typed numbers; there are no followers or likes to count,
                  so they are not shown at all. */}
              <div className="flex gap-6">
                <div><p className="text-xl font-black">{creator.posts}</p><p className="text-xs text-gray-500">Posts</p></div>
              </div>

              {creator.bio && <p className="text-sm text-gray-300 whitespace-pre-wrap">{creator.bio}</p>}

              {creator.location && (
                <p className="text-sm text-gray-400 flex items-center gap-2"><Icons.pin className="h-4 w-4 shrink-0" />{creator.location}</p>
              )}
              {websiteUrl && (
                <a href={websiteUrl} target="_blank" rel="noopener noreferrer"
                   className="text-sm text-brand-pink hover:underline break-all flex items-center gap-2">
                  <Icons.link className="h-4 w-4 shrink-0" />{websiteUrl.replace(/^https?:\/\//, '')}
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

              {/* How to support this creator, stated as what actually works
                  today. This card used to sell a subscription at the
                  creator's price with a Subscribe button that could never
                  take the money. */}
              <div className="rounded-xl border border-white/10 bg-brand-card p-5">
                <p className="font-bold mb-1">Support {creator.name}</p>
                {demo ? (
                  <p className="text-xs text-gray-400">{DEMO_LABEL}. Real creators can be supported through their marketplace and paid messages.</p>
                ) : (
                  <>
                    <ul className="mt-3 space-y-2 text-sm text-gray-300">
                      <li className="flex items-start gap-2">
                        <Icons.check className="h-4 w-4 mt-0.5 shrink-0 text-brand-pink" />
                        <span>Buy from their marketplace with credits.</span>
                      </li>
                      <li className="flex items-start gap-2">
                        <Icons.check className="h-4 w-4 mt-0.5 shrink-0 text-brand-pink" />
                        <span>
                          {/* Same condition as the Message button: a creator
                              with no login can't be messaged, so no price is
                              offered for it (credits never refund), and no
                              future change is promised. */}
                          {!creatorUserId
                            ? "Messaging isn't available for this creator."
                            : dmPriceCents > 0
                              ? `Send a message — ${dmPriceLabel} each (${dmFeeWaived ? 'goes to the creator in full' : "goes to the creator, less OnlyOne's platform fee"}).`
                              : 'Send a message — free for you as a creator.'}
                        </span>
                      </li>
                    </ul>
                    {/* Credits only buy something here when there is a
                        listing to buy or a message that can be sent. */}
                    {(creatorUserId || listings.length > 0) && (
                      <a href="/credits" className="mt-4 block text-center w-full py-2.5 rounded-full border border-white/15 text-sm font-semibold hover:border-brand-pink/60 transition">
                        Get credits
                      </a>
                    )}
                    <p className="text-[11px] text-gray-500 mt-3">Subscriptions and tips aren&apos;t available yet.</p>
                  </>
                )}
              </div>

              {/* Reporting this profile. Each visible gallery tile has its
                  own flag; the avatar is reported from here. The takedown
                  form needs no account and starts a 48-hour removal clock. */}
              {!isOwner && (
                <div className="text-xs text-gray-500 space-y-1.5">
                  {mediaReportNotice && <p className="text-gray-400">{mediaReportNotice}</p>}
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Icons.flag className="h-3.5 w-3.5 shrink-0" />
                    {creator.img && (signedOut ? (
                      <a
                        href={takedownFormHref({ content: `Profile photo ${creator.img} on ${profileLocation}` })}
                        className="hover:text-brand-pink underline"
                      >
                        Report profile photo
                      </a>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setReportingMedia({ targetType: 'avatar', src: creator.img, label: 'this profile photo' })}
                        className="hover:text-brand-pink underline"
                      >
                        Report profile photo
                      </button>
                    ))}
                    <a href={takedownFormHref({ content: profileLocation })} className="hover:text-brand-pink underline">
                      Takedown request
                    </a>
                  </p>
                  <p>Use the flag on a photo or video to report that one item.</p>
                </div>
              )}
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

              {unlockedByWallet && (
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 rounded-xl border border-brand-pink/30 bg-brand-pink/5 text-xs text-gray-300">
                  <span>Unlocked — your verified wallet holds enough $ONLYONE for this creator.</span>
                  <button onClick={disconnectWallet} disabled={disconnectBusy} className="text-gray-400 hover:text-white underline disabled:opacity-50">Disconnect wallet</button>
                </div>
              )}

              {activeTab === 'posts' && (
                <div className="space-y-8">
                  <div className="grid md:grid-cols-[1.6fr_1fr] gap-4">
                    {/* Locked: the tile grows with the unlock panel instead of
                        being a fixed 16:9 box with overflow hidden -- on a
                        phone that box is ~185px tall and clipped the button
                        and the "no wallet found" error, so an unlock attempt
                        looked like it did nothing. */}
                    <div
                      className={`relative rounded-xl overflow-hidden bg-white/5 border border-white/5 ${
                        locked ? 'min-h-[240px] flex items-center justify-center py-6' : 'aspect-video'
                      }`}
                    >
                      {locked ? (
                        <>
                          {creator.img && (
                            <img src={creator.img} alt="" draggable={false} className="absolute inset-0 w-full h-full object-cover blur-xl scale-110 opacity-50" />
                          )}
                          <div className="absolute inset-0 bg-black/40" />
                          <div className="relative">
                            <TokenUnlockPanel gate={gate} gateLabel={gateLabel} tokenLive={tokenLive} />
                          </div>
                        </>
                      ) : featured ? (
                        <button type="button" onClick={() => setViewing(featured)} className="block w-full h-full" aria-label="Open">
                          <ProtectedMedia
                            src={featured.src}
                            type={featured.type === 'video' ? 'video' : 'image'}
                            mark={overlayMark}
                            autoPlay={featured.type === 'video'}
                            className="w-full h-full object-cover"
                          />
                        </button>
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-sm text-gray-500">No media yet.</div>
                      )}
                    </div>

                    <div className="rounded-xl border border-white/10 bg-brand-card p-4 flex flex-col">
                      <p className="font-bold mb-1">{creator.name}&apos;s Marketplace</p>
                      <p className="text-xs text-gray-400 mb-3">
                        {listings.length > 0
                          ? demo
                            ? `${listings.length} sample item${listings.length === 1 ? '' : 's'} — not for sale.`
                            : `${listings.length} item${listings.length === 1 ? '' : 's'} available to buy.`
                          : 'Nothing listed yet.'}
                      </p>
                      {listings[0] && (
                        <div className="relative rounded-lg overflow-hidden aspect-[4/3] mb-3">
                          <ListingPreview media={listings[0].media} />
                        </div>
                      )}
                      <button
                        onClick={() => setActiveTab('marketplace')}
                        disabled={listings.length === 0}
                        className="mt-auto w-full py-2.5 rounded-full border border-white/15 text-sm font-semibold hover:border-brand-pink/60 transition disabled:opacity-40 disabled:hover:border-white/15"
                      >
                        Browse Marketplace <Icons.arrowRight className="inline-block h-4 w-4 align-[-0.15em]" />
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
                          <GalleryTile key={i} item={item} badge={item.type === 'video' ? 'Video' : null} {...tileProps} />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Items 5-8. Only called "locked" when they actually are
                      for this viewer -- it used to say "Locked Content
                      Preview" over fully visible photos. */}
                  {morePosts.length > 0 && (
                    <div>
                      <h2 className="font-bold mb-3">{locked ? 'Locked Content Preview' : 'More Content'}</h2>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        {morePosts.map((item, i) => (
                          <GalleryTile key={i} item={item} badge={item.type === 'video' ? 'Video' : null} {...tileProps} />
                        ))}
                      </div>
                    </div>
                  )}

                  {!locked && gallery.length > 0 && markNotice}

                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="rounded-xl border border-white/10 bg-brand-card p-4">
                      <div className="flex items-center justify-between mb-3">
                        <h2 className="font-bold">Fan Messages</h2>
                        <button onClick={() => setActiveTab('about')} className="text-xs text-brand-pink hover:underline">About</button>
                      </div>
                      <Wall creatorId={creator.id} viewerId={viewerId} initialPosts={wallPosts} initialNextBefore={wallNextBefore} isWallOwner={isOwner} profileLocation={profileLocation} maxLength={wallMaxLength} />
                    </div>

                    <div className="rounded-xl border border-white/10 bg-brand-card p-4">
                      <h2 className="font-bold mb-3">About {creator.name}</h2>
                      <ul className="space-y-2 text-sm text-gray-300">
                        {creator.age && <li className="flex items-center gap-2"><Icons.cake className="h-4 w-4 shrink-0" />{creator.age}</li>}
                        {creator.location && <li className="flex items-center gap-2"><Icons.pin className="h-4 w-4 shrink-0" />{creator.location}</li>}
                        <li className="flex items-center gap-2"><Icons.film className="h-4 w-4 shrink-0" />{creator.media} media items</li>
                        {Array.isArray(creator.tags) && creator.tags.length > 0 && <li className="flex items-center gap-2"><Icons.tag className="h-4 w-4 shrink-0" />{creator.tags.join(', ')}</li>}
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
                    {locked && (
                      <div className="mb-5 rounded-xl border border-white/10 bg-brand-card p-5">
                        <TokenUnlockPanel gate={gate} gateLabel={gateLabel} tokenLive={tokenLive} compact />
                      </div>
                    )}
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                      {gallery.map((item, i) => <GalleryTile key={i} item={item} badge={item.type === 'video' ? 'Video' : null} {...tileProps} />)}
                    </div>
                    {/* The mark deters because the viewer knows it is there,
                        and the notice says exactly what kind of mark it is. */}
                    {!locked && markNotice}
                  </>
                )
              )}

              {activeTab === 'marketplace' && (
                listings.length === 0 ? (
                  <p className="text-sm text-gray-500">Nothing listed yet.</p>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {listings.map((l) => (
                      <a key={l.id} href={marketplaceHrefFor(l)}
                         className="group relative aspect-square rounded-xl overflow-hidden border border-white/10 hover:border-brand-pink/60 transition">
                        <ListingPreview media={l.media} />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-transparent pointer-events-none" />
                        <div className="absolute top-2 left-2 flex flex-col gap-1 items-start">
                          {l.demo && <DemoBadge short />}
                          {(l.aiGenerated || l.media?.some((m) => m.aiGenerated)) && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-black/70 text-brand-pink font-bold">AI</span>
                          )}
                        </div>
                        <div className="absolute bottom-0 left-0 right-0 p-2">
                          <p className="text-xs font-bold truncate">{l.title}</p>
                          {l.demo ? (
                            <span className="inline-block mt-1 px-2 py-0.5 rounded-full bg-yellow-400 text-black text-[11px] font-black">{DEMO_LABEL}</span>
                          ) : (
                            <span className="inline-block mt-1 px-2 py-0.5 rounded-full bg-brand-pink text-white text-[11px] font-black">
                              ${(l.priceCents / 100).toFixed(2)}
                            </span>
                          )}
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
                    {creator.location && <li className="flex items-center gap-2"><Icons.pin className="h-4 w-4 shrink-0" />{creator.location}</li>}
                    <li className="flex items-center gap-2"><Icons.memo className="h-4 w-4 shrink-0" />{creator.posts} posts</li>
                    <li className="flex items-center gap-2"><Icons.film className="h-4 w-4 shrink-0" />{creator.media} media items</li>
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
          initialPriceCents={dmPriceCents}
          feeWaived={dmFeeWaived}
          maxLength={dmMaxLength}
          onClose={() => setInboxOpen(false)}
        />
      )}
    </>
  );
}

// A fresh id per send ATTEMPT; a retry of the same attempt reuses it so the
// server can recognise a duplicate and not charge twice.
function newClientMessageId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    // fall through
  }
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

function MessagePanel({ otherUserId, otherName, otherImg, initialPriceCents, feeWaived, maxLength: MAX_DM_LENGTH = 2000, onClose }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [needsCredits, setNeedsCredits] = useState(false);
  // The price the SERVER quotes for this viewer (GET /api/messages/with),
  // sent back as expectedPriceCents. Seeded with the page's display price
  // until the thread loads.
  const [priceCents, setPriceCents] = useState(initialPriceCents || 0);
  const [canSend, setCanSend] = useState(true);
  const [cannotSendReason, setCannotSendReason] = useState('');
  const [notice, setNotice] = useState('');
  // Per-conversation block (POST /api/messages/block) and per-message report
  // (POST /api/messages/report). The endpoint can block an account with no
  // conversation yet, so the control shows once the thread has loaded.
  const [hasConversation, setHasConversation] = useState(false);
  const [blockedByMe, setBlockedByMe] = useState(false);
  const [blockedByThem, setBlockedByThem] = useState(false);
  const [blockBusy, setBlockBusy] = useState(false);
  const [reportingMessage, setReportingMessage] = useState(null);
  // Reused across retries of the SAME text, replaced once a send lands.
  const attemptId = useRef(null);
  // The price the fan has CONFIRMED: the load quote, then whatever was on
  // the Send button the last time they pressed it. A price that moves after
  // that -- a 409 dm_price_changed, or a re-quote after block/unblock -- is
  // only accepted by a deliberate press of the Send button (which shows it),
  // never by Enter, and editing the text does not re-arm Enter (round-21
  // public-pages#1, round-22 public-pages#0): Enter and every non-button
  // submit are refused while priceCents !== confirmedPriceCents.
  const [confirmedPriceCents, setConfirmedPriceCents] = useState(initialPriceCents || 0);
  const priceConfirmed = priceCents === confirmedPriceCents;
  // Set by the Send button's click, which fires before its submit event: the
  // fallback where SubmitEvent.submitter is not supported.
  const sendButtonPressed = useRef(false);
  const sendButtonRef = useRef(null);
  // The latest shown price, for re-quotes that outlive their render.
  const priceRef = useRef(priceCents);
  priceRef.current = priceCents;

  const applyConversation = (conversation) => {
    if (!conversation || typeof conversation !== 'object') return;
    setHasConversation(!!conversation.id);
    setBlockedByMe(!!conversation.blockedByMe);
    setBlockedByThem(!!conversation.blockedByThem);
  };

  const toggleBlock = async () => {
    if (blockBusy) return;
    const next = !blockedByMe;
    if (next && typeof window !== 'undefined' && !window.confirm(`Block ${otherName}? They won't be able to message you until you unblock them.`)) return;
    setBlockBusy(true);
    setError('');
    try {
      const res = await fetch('/api/messages/block', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: otherUserId, blocked: next }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || 'Could not update the block.');
      if (data.conversation && typeof data.conversation === 'object') applyConversation(data.conversation);
      else setBlockedByMe(next);
      setNotice(next ? `${otherName} is blocked.` : `${otherName} is unblocked.`);
      // canSend / the price were quoted under the old block state; re-read
      // them so Send isn't left disabled (or wrongly enabled) after this.
      await requote();
    } catch (err) {
      setError(err.message);
    } finally {
      setBlockBusy(false);
    }
  };

  // Re-reads the server's quote for this thread (price, canSend, block
  // state). Unlike the initial load it sets canSend both ways.
  const requote = async () => {
    try {
      const res = await fetch(`/api/messages/with/${encodeURIComponent(otherUserId)}`);
      const data = await readJson(res);
      if (!res.ok) return;
      applyConversation(data.conversation);
      if (Number.isInteger(data.dmPriceCents) && data.dmPriceCents !== priceRef.current) {
        // A new price is shown and said out loud, but NOT confirmed: only a
        // press of the Send button (which carries it) accepts it.
        setPriceCents(data.dmPriceCents);
        setNotice(
          data.dmPriceCents > 0
            ? `${otherName}'s message price is now ${formatCredits(data.dmPriceCents)}. Press Send to send at the new price.`
            : `Messaging ${otherName} is now free.`,
        );
      }
      setCanSend(data.canSend !== false);
      setCannotSendReason(data.canSend === false && typeof data.cannotSendReason === 'string' ? data.cannotSendReason : '');
    } catch {
      // keep what is shown; the next send gets the server's answer anyway
    }
  };

  const submitMessageReport = async ({ reason, category }) => {
    await postReport('/api/messages/report', {
      withUserId: otherUserId,
      messageId: String(reportingMessage.id),
      reason,
      category,
    });
    setReportingMessage(null);
    setNotice('Thanks — an admin will review that message. You can also block this person.');
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/messages/with/${encodeURIComponent(otherUserId)}`);
        const data = await readJson(res);
        if (cancelled) return;
        if (res.ok) {
          setMessages(Array.isArray(data.conversation?.messages) ? data.conversation.messages : []);
          applyConversation(data.conversation);
          // Exactly the quoted price -- not max(page price, quote): the value
          // shown is the value sent as expectedPriceCents, and the server
          // refuses a paid send whose expected price is not the real one.
          // The load quote is the first price the fan sees in the panel, so
          // it is the confirmed one until it changes.
          if (Number.isInteger(data.dmPriceCents)) {
            setPriceCents(data.dmPriceCents);
            setConfirmedPriceCents(data.dmPriceCents);
          }
          if (data.canSend === false) {
            setCanSend(false);
            setCannotSendReason(typeof data.cannotSendReason === 'string' ? data.cannotSendReason : '');
          }
        } else {
          setError(data.error || 'Could not load messages.');
        }
      } catch {
        if (!cancelled) setError('Could not load messages.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [otherUserId]);

  const dmTrimmedLength = text.trim().length;
  const dmOverLimit = dmTrimmedLength > MAX_DM_LENGTH;
  // Every condition that enables the Send button. send() re-checks it too:
  // form.requestSubmit() fires submit even while the button is disabled.
  const sendAllowed = !sending && !loading && canSend && !blockedByMe && !blockedByThem && !!text.trim() && !dmOverLimit;

  const send = async (e) => {
    e.preventDefault();
    const body = text.trim();
    const submitter = e.nativeEvent?.submitter;
    const fromButton = sendButtonPressed.current || (!!submitter && submitter === sendButtonRef.current);
    sendButtonPressed.current = false;
    if (!body || !sendAllowed) return;
    // A press of the Send button confirms the price it shows. Any other
    // submit (Enter's requestSubmit, anything scripted) is refused while the
    // shown price has not been confirmed.
    if (fromButton) setConfirmedPriceCents(priceCents);
    else if (!priceConfirmed) return;
    if (body.length > MAX_DM_LENGTH) {
      setError(`That message is too long (${MAX_DM_LENGTH} characters maximum).`);
      return;
    }
    if (!attemptId.current) attemptId.current = newClientMessageId();
    setSending(true);
    setError('');
    setNotice('');
    setNeedsCredits(false);
    try {
      const res = await fetch('/api/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toUserId: otherUserId,
          text: body,
          clientMessageId: attemptId.current,
          // The price shown above the box. A paid send with a missing or
          // out-of-date price is refused (409) and nothing is charged.
          expectedPriceCents: priceCents,
        }),
      });
      const data = await readJson(res);
      if (res.status === 409 && data.code === 'dm_price_changed' && Number.isInteger(data.currentPriceCents)) {
        // Nothing was charged. Show the new price; the next press of the
        // Send button (not Enter, and not Enter after an edit) confirms it.
        setPriceCents(data.currentPriceCents);
        setNotice(
          data.currentPriceCents > 0
            ? `${otherName}'s message price is now ${formatCredits(data.currentPriceCents)}. Nothing was charged — press Send again to send at the new price.`
            : 'This message is now free to send. Nothing was charged — press Send again.',
        );
        return;
      }
      if (!res.ok) {
        if (res.status === 402) setNeedsCredits(true);
        // 402 not enough credits, 403 not allowed / restricted, 409 the
        // creator is not taking messages -- the server's text says which.
        throw new Error(data.error || (res.status === 409 ? "This creator isn't accepting messages right now." : 'Failed to send'));
      }
      applyConversation(data.conversation);
      // Merged by id, not replaced: the send answers with the latest page.
      if (Array.isArray(data.conversation?.messages)) {
        const page = data.conversation.messages;
        setMessages((prev) => {
          const ids = new Set(page.map((m) => String(m.id)));
          return [...prev.filter((m) => !ids.has(String(m.id))), ...page];
        });
      }
      setText('');
      attemptId.current = null;
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
          {otherImg && <img src={otherImg} alt={otherName} className="w-9 h-9 rounded-full object-cover object-top" />}
          <p className="font-bold text-white flex-1 truncate">{otherName}</p>
          {!loading && (
            <button
              onClick={toggleBlock}
              disabled={blockBusy}
              className="text-[11px] px-2.5 py-1 rounded-full border border-white/10 text-gray-400 hover:text-white hover:border-white/30 transition disabled:opacity-50"
            >
              {blockedByMe ? 'Unblock' : 'Block'}
            </button>
          )}
          <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-white"><Icons.close className="h-5 w-5" /></button>
        </div>
        {reportingMessage && (
          <ReportModal
            title="Report this message"
            subject="this message"
            onSubmit={submitMessageReport}
            onClose={() => setReportingMessage(null)}
            takedownContent={`Direct message ${reportingMessage.id} from user ${otherUserId}`}
          />
        )}

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading ? (
            <p className="text-gray-500 text-sm text-center">Loading...</p>
          ) : messages.length === 0 ? (
            <p className="text-gray-500 text-sm text-center">Say hi to {otherName}</p>
          ) : (
            messages.map((m) => {
              const fromThem = String(m.senderId) === String(otherUserId);
              return (
                <div key={m.id} className={`flex items-end gap-1 ${fromThem ? 'justify-start' : 'justify-end'}`}>
                  <div
                    className={`max-w-[80%] px-3 py-2 rounded-lg text-sm whitespace-pre-wrap break-words ${
                      fromThem ? 'bg-black/40 text-gray-200' : 'bg-brand-pink text-black'
                    }`}
                  >
                    {m.text}
                  </div>
                  {/* Only the other side's messages can be reported (the
                      endpoint refuses your own). */}
                  {fromThem && m.id != null && (
                    <button
                      type="button"
                      onClick={() => setReportingMessage(m)}
                      title="Report this message"
                      aria-label="Report this message"
                      className="shrink-0 p-1 text-gray-600 hover:text-brand-pink transition"
                    >
                      <Icons.flag className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>

        {blockedByMe ? (
          <p className="text-[11px] text-gray-400 px-4 pt-2">
            You blocked {otherName}. Unblock them to message each other again.
          </p>
        ) : blockedByThem ? (
          <p className="text-[11px] text-gray-400 px-4 pt-2">You can&apos;t message {otherName} right now.</p>
        ) : !canSend && (
          <p className="text-[11px] text-gray-400 px-4 pt-2">
            {cannotSendReason || `You can't message ${otherName} right now.`}
          </p>
        )}
        {canSend && priceCents > 0 && (
          <p className="text-[11px] text-gray-400 px-4 pt-2">
            Each message costs {formatCredits(priceCents)} (goes to {otherName}{feeWaived ? ' in full' : <>, less OnlyOne&apos;s platform fee</>}).
          </p>
        )}
        {notice && <p className="text-yellow-300 text-xs px-4 pt-1">{notice}</p>}
        {error && (
          <p className="text-red-400 text-xs px-4 pt-1">
            {error}
            {needsCredits && (
              <>
                {' '}
                <a href="/credits" className="underline text-brand-pink">Get credits</a>
              </>
            )}
          </p>
        )}

        {/* A textarea with no maxLength (round-20 public-pages#0): a pasted
            message stays whole and visible before it is paid for, and one over
            the limit is refused below instead of being cut and charged.
            With a mouse/trackpad (fine pointer), Enter sends and Shift+Enter
            adds a new line; on touch devices Return is always a new line and
            only the button sends. Enter never sends on key auto-repeat, during
            IME composition, while the button would be disabled, or while a
            changed price has not been confirmed with the button -- editing
            the text does not re-arm it (round-21 public-pages#1, round-22
            public-pages#0). */}
        <form onSubmit={send} className="p-3 border-t border-white/10">
          <div className="flex gap-2 items-end">
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                attemptId.current = null; // different text = a new attempt
                // Editing never confirms a changed price (round-22 public-pages#0).
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.shiftKey) return;
                if (e.nativeEvent.isComposing || e.keyCode === 229) return; // IME (Safari reports 229)
                const finePointer = typeof window !== 'undefined'
                  && typeof window.matchMedia === 'function'
                  && window.matchMedia('(pointer: fine)').matches;
                if (!finePointer) return; // touch keyboards: Return is a new line
                e.preventDefault();
                if (e.repeat || !priceConfirmed || !sendAllowed) return;
                e.currentTarget.form?.requestSubmit();
              }}
              rows={2}
              placeholder="Type a message..."
              aria-invalid={dmOverLimit}
              className="flex-1 px-3 py-2 rounded-md bg-black/40 border border-white/10 text-white text-sm resize-none"
            />
            <button
              ref={sendButtonRef}
              type="submit"
              onClick={() => { sendButtonPressed.current = true; }}
              disabled={!sendAllowed}
              className="rounded-full bg-brand-pink hover:bg-brand-pink-dark text-white font-bold transition py-2 px-4 text-sm disabled:opacity-50">
              {sending ? 'Sending…' : priceCents > 0 ? `Send · $${(priceCents / 100).toFixed(2)}` : 'Send'}
            </button>
          </div>
          <LengthCounter length={dmTrimmedLength} max={MAX_DM_LENGTH} />
        </form>
      </div>
    </div>
  );
}

// Newest first, no id twice. Wall post ids come from a sequence, so a larger
// id is a newer post.
function mergeWallPosts(...lists) {
  const byId = new Map();
  for (const list of lists) for (const p of list || []) if (p && p.id != null) byId.set(String(p.id), p);
  return [...byId.values()].sort((a, b) => Number(b.id) - Number(a.id));
}

function Wall({ creatorId, viewerId, initialPosts, initialNextBefore, isWallOwner, profileLocation, maxLength: WALL_MAX = 500 }) {
  const router = useRouter();
  const [posts, setPosts] = useState(initialPosts);
  // Cursor for the next OLDER page (null = nothing older). Only the newest
  // page is server-rendered.
  const [nextBefore, setNextBefore] = useState(initialNextBefore || null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [reporting, setReporting] = useState(null);
  const [reportNotice, setReportNotice] = useState('');
  // Wall owner only: block the author of a comment (POST /api/wall/block,
  // by comment id -- the public wall never carries the author's account id).
  // The server reports each comment's current state to the owner
  // (`authorBlocked` on the post); this map holds changes made on this page
  // view, keyed by comment id, and wins over the post's own flag. A block is
  // per author, so a toggle updates every comment id the server says that
  // author has on this wall (`postIds`), not just the one clicked.
  const [blockedPosts, setBlockedPosts] = useState({});
  const isAuthorBlocked = (p) => {
    const local = blockedPosts[String(p.id)];
    return typeof local === 'boolean' ? local : p.authorBlocked === true;
  };
  const [blockBusyId, setBlockBusyId] = useState(null);

  const submitReport = async ({ reason, category }) => {
    await postReport('/api/wall/report', { postId: reporting.id, reason, category });
    setReporting(null);
    setReportNotice('Thanks — an admin will review that comment.');
  };

  // Re-reads the NEWEST page and merges it in, so older pages the viewer
  // already opened stay on screen.
  const refresh = async () => {
    try {
      const res = await fetch(`/api/wall/list?creatorId=${encodeURIComponent(creatorId)}`);
      const data = await readJson(res);
      if (res.ok && Array.isArray(data.posts)) setPosts((prev) => mergeWallPosts(prev, data.posts));
    } catch {
      // keep what is on screen
    }
  };

  const loadOlder = async () => {
    if (!nextBefore || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const res = await fetch(`/api/wall/list?creatorId=${encodeURIComponent(creatorId)}&before=${encodeURIComponent(nextBefore)}`);
      const data = await readJson(res);
      if (!res.ok || !Array.isArray(data.posts)) throw new Error(data.error || 'Could not load older comments.');
      setPosts((prev) => mergeWallPosts(prev, data.posts));
      setNextBefore(data.hasMore && typeof data.nextBefore === 'string' ? data.nextBefore : null);
    } catch (err) {
      setError(err.message || 'Could not load older comments.');
    } finally {
      setLoadingOlder(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!viewerId) {
      router.push(`/login?next=/creator/${creatorId}`);
      return;
    }
    if (!text.trim()) return;
    if (text.trim().length > WALL_MAX) {
      setError(`That post is too long (${WALL_MAX} characters maximum).`);
      return;
    }
    setSending(true);
    setError('');
    try {
      const res = await fetch('/api/wall/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creatorId, text }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || 'Failed to post');
      setText('');
      // Show the new comment at once (the server returns it in its public
      // shape, `mine: true`), then resync with everyone else's.
      if (data.post && data.post.id != null) {
        setPosts((prev) => [data.post, ...prev.filter((p) => String(p.id) !== String(data.post.id))]);
      }
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  const toggleBlockAuthor = async (post) => {
    if (blockBusyId != null) return;
    const key = String(post.id);
    const next = !isAuthorBlocked(post);
    if (next && typeof window !== 'undefined'
      && !window.confirm(`Block ${post.authorName || 'this person'}? They won't be able to comment on your wall or message you until you unblock them.`)) return;
    setBlockBusyId(key);
    setError('');
    try {
      const res = await fetch('/api/wall/block', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: key, blocked: next }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || 'Could not update the block.');
      const nowBlocked = data.blocked === true;
      const ids = Array.isArray(data.postIds) && data.postIds.length ? data.postIds.map(String) : [key];
      if (!ids.includes(key)) ids.push(key);
      setBlockedPosts((prev) => {
        const out = { ...prev };
        for (const id of ids) out[id] = nowBlocked;
        return out;
      });
      setReportNotice(data.blocked ? `${post.authorName || 'That person'} is blocked.` : `${post.authorName || 'That person'} is unblocked.`);
    } catch (err) {
      setError(err.message || 'Could not update the block.');
    } finally {
      setBlockBusyId(null);
    }
  };

  const remove = async (id) => {
    try {
      const res = await fetch('/api/wall/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (res.ok) setPosts((prev) => prev.filter((p) => String(p.id) !== String(id)));
    } catch {
      // best-effort -- the post stays visible if the delete failed, no toast needed for this
    }
  };

  return (
    <div>
      {reporting && (
        <ReportModal
          title="Report this comment"
          subject="this comment"
          onSubmit={submitReport}
          onClose={() => setReporting(null)}
          takedownContent={`Wall comment #${reporting.id} on creator #${creatorId}'s wall -- /creator/${creatorId}`}
        />
      )}
      {reportNotice && <p className="text-xs text-gray-400 mb-3">{reportNotice}</p>}

      <form onSubmit={submit} className="mb-6">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={viewerId ? 'Say something on their wall...' : 'Log in to post on the wall'}
          rows={2}
          aria-invalid={text.trim().length > WALL_MAX}
          className="w-full px-4 py-3 rounded-md bg-black/40 border border-white/10 text-white text-sm"
        />
        {/* No maxLength: a browser would silently cut a paste (round-20
            public-pages#0). Counted and refused instead, like the DM box. */}
        <div className="mb-2"><LengthCounter length={text.trim().length} max={WALL_MAX} /></div>
        {error && <p className="text-xs text-red-400 mb-2">{error}</p>}
        <button type="submit" disabled={sending || text.trim().length > WALL_MAX} className="px-6 py-2 rounded-full bg-brand-pink hover:bg-brand-pink-dark text-white font-bold transition text-sm px-6 disabled:opacity-50">
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
                  {/* `mine` is decided server-side against the session; the
                      public wall shape carries no other commenter's id. */}
                  {viewerId && !p.mine && (
                    <button onClick={() => setReporting(p)} className="text-xs text-gray-600 hover:text-brand-pink transition" title="Report">
                      <Icons.flag className="h-4 w-4" />
                    </button>
                  )}
                  {/* Signed out: in-product reports need an account (and
                      signups may be closed), so the flag goes to the
                      no-account takedown form, prefilled with this comment --
                      the same fallback gallery tiles and listings use. */}
                  {!viewerId && !p.mine && (
                    <a
                      href={takedownFormHref({ content: `Wall comment #${p.id} on ${profileLocation || `/creator/${creatorId}`}` })}
                      className="text-xs text-gray-600 hover:text-brand-pink transition"
                      title="Report this comment (no account needed)"
                      aria-label="Report this comment"
                    >
                      <Icons.flag className="h-4 w-4" />
                    </a>
                  )}
                  {isWallOwner && !p.mine && (
                    <button
                      onClick={() => toggleBlockAuthor(p)}
                      disabled={blockBusyId != null}
                      className="text-[11px] px-2 py-0.5 rounded-full border border-white/10 text-gray-500 hover:text-white hover:border-white/30 transition disabled:opacity-50"
                      title={isAuthorBlocked(p) ? 'Unblock this commenter' : 'Block this commenter'}
                    >
                      {isAuthorBlocked(p) ? 'Unblock' : 'Block'}
                    </button>
                  )}
                  {(isWallOwner || p.mine) && (
                    <button onClick={() => remove(p.id)} className="text-xs text-gray-500 hover:text-red-400 transition" title="Delete">
                      <Icons.close className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
              <p className="text-[10px] text-gray-600 mt-2">{formatWallDate(p.createdAt)}</p>
            </div>
          ))}
          {nextBefore && (
            <button
              type="button"
              onClick={loadOlder}
              disabled={loadingOlder}
              className="block mx-auto text-xs text-brand-pink hover:underline disabled:opacity-50"
            >
              {loadingOlder ? 'Loading…' : 'Show older comments'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
