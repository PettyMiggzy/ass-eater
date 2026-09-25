import { useEffect, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import SiteNav from '../components/SiteNav';
import { getSessionUser } from '../lib/session';
import { publicUser } from '../lib/users-store';
import { getListings } from '../lib/listings-store';
import { getCreators } from '../lib/creators-store';
import { isPubliclyVisible, toPublicListing, listingHasDeliverable, LISTING_LIMITS } from '../lib/creator-status';
import { isFoundingCreator } from '../lib/founding';
import { Icons, SolidIcons, Tagline } from '../components/Brand';
import { useCart } from '../lib/cart';
import { marketplacePaymentsLive, getMarketplacePaymentConfig } from '../lib/marketplace-payment-config';
import ListingPreview from '../components/public/ListingPreview';
import DemoBadge from '../components/public/DemoBadge';
import ReportModal, { postReport, takedownFormHref } from '../components/public/ReportModal';
import { isDemoListing, DEMO_LABEL } from '../components/public/cards';
import { CATEGORIES, categoriesOf, categoryFromQuery, categoryLabel, countByCategory, withCategoryParam } from '../lib/categories';

// This page is also served as the root ('/') of onlyass.shop via proxy.js's
// rewrite -- a relative href="/" there just re-renders this same page
// instead of leaving the domain (same reasoning as gateway.js's MAIN_SITE).
const MAIN_SITE = 'https://joinonlyone.com'; // primary domain as of 2026-09-19 -- onlyass.fun still works as a mirror

const KINDS = [
  { value: 'all', label: 'All' },
  { value: 'photo', label: 'Photos' },
  { value: 'video', label: 'Video' },
  { value: 'physical', label: 'Merch' },
];

// Ids are opaque strings (numeric seed ids, uuids for real rows). Anything
// else in the query is ignored rather than trusted into a filter.
function queryId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

export async function getServerSideProps({ req, query }) {
  const sessionUser = publicUser(await getSessionUser(req));
  const [listings, creators] = await Promise.all([getListings(), getCreators()]);
  // A suspended or banned creator's listings come OFF the marketplace, not
  // just their name. Masking the seller to "Unknown" left a banned creator's
  // merch on sale with a working Buy button and a link to a profile that
  // renders "Creator not found" -- which is not what hiding them means.
  const visible = new Map(
    creators.filter(isPubliclyVisible).map((c) => [String(c.id), c]),
  );
  // listingHasDeliverable: a digital listing with no files has nothing to
  // deliver, and checkout refuses it -- showing it with an Add-to-cart button
  // only led to a 409 at checkout. Checked on the stored record, BEFORE
  // toPublicListing strips the media srcs it looks at.
  const active = listings
    .filter((l) => l.status === 'active' && visible.has(String(l.creatorId)) && listingHasDeliverable(l))
    .map((l) => {
      const creator = visible.get(String(l.creatorId));
      // toPublicListing: a tiny blurred preview per media item and NEVER a
      // src. The paid files reach only buyers, through
      // /api/marketplace/orders/delivery (checked again by /api/media).
      return {
        ...toPublicListing(l, creator),
        creatorName: creator.name,
        creatorImg: creator.img || '/images/avatar-placeholder.png',
        creatorFounding: isFoundingCreator(creator),
        // A listing has no category of its own: it inherits its seller's
        // (lib/categories.js), and the Categories sidebar filters on this.
        creatorCategories: categoriesOf(creator),
        // The platform's own sample creators/listings: labelled, and never
        // given a buy button (checkout refuses them too).
        demo: isDemoListing(l, creator),
      };
    })
    // "Priority placement in Marketplace" for Founding Creators, newest
    // first within each group. A real sort, not a label.
    .sort((a, b) => {
      const founding = (b.creatorFounding ? 1 : 0) - (a.creatorFounding ? 1 : 0);
      if (founding !== 0) return founding;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
  // Every distinct tag any ACTIVE, visible listing actually has -- same
  // rule as /search's creator tag cloud. No fabricated category list with
  // invented counts like "Fetish (231)": if nothing is tagged "feet" yet,
  // "feet" simply doesn't appear as a filter option, rather than appearing
  // with a made-up number next to it.
  const tagCounts = {};
  for (const l of active) {
    for (const t of Array.isArray(l.tags) ? l.tags : []) tagCounts[t] = (tagCounts[t] || 0) + 1;
  }
  const allTags = Object.keys(tagCounts).sort();
  // ?creator=<id>&listing=<id>: the links from a creator's profile and from
  // /search land here scoped to that creator, scrolled to the item clicked.
  // Read server-side so the first render is already filtered (no flash of the
  // whole marketplace, no hydration mismatch). A creator or listing that isn't
  // on sale here simply matches nothing and the filter can be cleared.
  const focusCreatorId = queryId(query?.creator);
  const focusListingId = queryId(query?.listing);
  const focusCreatorName = focusCreatorId
    ? (visible.get(focusCreatorId)?.name || null)
    : null;
  // ?category=women: read server-side like ?creator=, so a shared link renders
  // already filtered. Only a known key filters; anything else is no filter.
  const initialCategory = categoryFromQuery(query?.category);
  return {
    props: {
      listings: active,
      allTags,
      sessionUser,
      paymentsLive: marketplacePaymentsLive(),
      stableSymbol: getMarketplacePaymentConfig().stableSymbol,
      focusCreatorId,
      focusCreatorName,
      focusListingId,
      initialCategory,
    },
  };
}

// Shared by the server-side counts above and the client-side filter below --
// two separate classifications of the same listing would eventually drift
// and show a count that doesn't match what the filter actually returns.
function kindOf(l) {
  if (l.kind === 'physical') return 'physical';
  if (l.media?.[0]?.type === 'video') return 'video';
  return 'photo';
}

// The real ceiling for the price slider, derived from what's actually
// listed. A fixed guess (e.g. $200) would silently clip out a genuinely
// priced $250 listing from the filter's own top end; $200 is only the
// FALLBACK, used while nothing is listed at all, so the slider has some
// range to show rather than a single point at $0.
const FALLBACK_MAX_CENTS = 20000;

const SORTS = [
  { value: 'newest', label: 'Newest' },
  { value: 'price-low', label: 'Price: Low to High' },
  { value: 'price-high', label: 'Price: High to Low' },
];

// How a listing is named when prefilled into the takedown form.
function listingReportRef(l) {
  if (!l) return '';
  return `Marketplace listing #${l.id} "${String(l.title || '').slice(0, 120)}" -- ${MAIN_SITE}/marketplace?creator=${encodeURIComponent(String(l.creatorId))}&listing=${encodeURIComponent(String(l.id))}`;
}

export default function Marketplace({
  listings,
  allTags,
  sessionUser,
  paymentsLive,
  stableSymbol,
  focusCreatorId = null,
  focusCreatorName = null,
  focusListingId = null,
  initialCategory = null,
}) {
  const router = useRouter();
  const cart = useCart();
  const [toast, setToast] = useState(null);
  const [reporting, setReporting] = useState(null);
  const [q, setQ] = useState('');
  const [creatorQ, setCreatorQ] = useState('');
  // Exact creator scope from a ?creator= link (by id, not by name: two
  // creators can share a display name). Cleared with the chip above the grid.
  const [creatorId, setCreatorId] = useState(focusCreatorId);
  const [highlightId, setHighlightId] = useState(focusListingId);
  const [kind, setKind] = useState('all');
  const [tag, setTag] = useState('');
  // The Categories sidebar. Lives in the URL (?category=) so a filtered view
  // is a shareable link; the state mirrors it.
  const [category, setCategoryState] = useState(initialCategory);
  const [sort, setSort] = useState('newest');
  // Clamped to the listing price ceiling the create/update routes enforce,
  // so one legacy absurd price can't make the slider useless for everyone.
  const maxCents = Math.min(
    LISTING_LIMITS.maxPriceCents,
    Math.max(FALLBACK_MAX_CENTS, ...listings.map((l) => (Number.isFinite(l.priceCents) ? l.priceCents : 0))),
  );
  const [maxPriceCents, setMaxPriceCents] = useState(maxCents);

  // Bring the listing the fan clicked into view, and fade its highlight.
  useEffect(() => {
    if (!focusListingId || typeof document === 'undefined') return undefined;
    const el = document.getElementById(`listing-${focusListingId}`);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = setTimeout(() => setHighlightId(null), 4000);
    return () => clearTimeout(t);
  }, [focusListingId]);

  // Keep the state in step with the address bar (back/forward, or a client
  // navigation to another ?category= link). Read from window.location rather
  // than router.query: on onlyass.shop this page is served at '/' by a
  // proxy.js rewrite, and the visible URL is the one that carries the param.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setCategoryState(categoryFromQuery(new URLSearchParams(window.location.search).get('category')));
  }, [router.asPath]);

  // Picking a category (or "All") rewrites ?category= in place -- shallow, so
  // getServerSideProps does not re-run for a filter that is applied here. The
  // href names the real page (router.pathname), the `as` URL keeps whatever
  // path the visitor is on, so the onlyass.shop root stays '/'.
  const setCategory = (key) => {
    const next = categoryFromQuery(key);
    setCategoryState(next);
    if (typeof window === 'undefined') return;
    const qs = withCategoryParam(window.location.search, next);
    router.replace(
      { pathname: router.pathname, query: Object.fromEntries(new URLSearchParams(qs)) },
      `${window.location.pathname}${qs}`,
      { shallow: true, scroll: false },
    );
  };

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const addToCart = (listing) => {
    if (listing.demo) return;
    // The cart's thumbnail is the listing's public blurred preview -- there
    // is no media src in a public listing to fall back on.
    cart.add({ ...listing, preview: listing.media?.[0]?.preview || null });
    showToast(`Added "${listing.title}" to your cart.`);
  };

  const submitReport = async ({ reason, category }) => {
    await postReport('/api/marketplace/report', { listingId: reporting.id, reason, category });
    setReporting(null);
    showToast('Reported — our team will review it.');
  };

  // Filters are derived, never stored -- a listing's kind/media is the source
  // of truth, so a mislabelled chip can't hide a real listing permanently.
  //
  // Written as independent predicates (one per filter dimension) rather than
  // a fixed chain, specifically so the sidebar's counts can be computed
  // correctly: a facet's own count has to reflect every OTHER active filter
  // but not itself, or picking "Video" and then looking at the tag list
  // shows tag counts computed before "Video" was ever applied -- a number
  // that visibly disagrees with what clicking the tag actually returns.
  // Derived from kindOf() itself, not a second hand-written classification --
  // two functions computing the same thing (one for the count, one for the
  // filter) is exactly how they drift: a physical listing whose first media
  // item happens to be a video used to match BOTH the "Physical" and "Video"
  // filters under the old duplicated version, so its count and its actual
  // filtered result disagreed.
  const matchesKind = (l, k) => k === 'all' || kindOf(l) === k;
  const matchesText = (l) =>
    !q.trim() || String(l.title || '').toLowerCase().includes(q.toLowerCase()) || (l.description || '').toLowerCase().includes(q.toLowerCase());
  const matchesCreator = (l) =>
    (!creatorId || String(l.creatorId) === String(creatorId))
    && (!creatorQ.trim() || String(l.creatorName || '').toLowerCase().includes(creatorQ.trim().toLowerCase()));
  const matchesTag = (l, t) => !t || (Array.isArray(l.tags) && l.tags.includes(t));
  const matchesPrice = (l) => (l.priceCents || 0) <= maxPriceCents;
  const matchesCategory = (l, c) => !c || (Array.isArray(l.creatorCategories) && l.creatorCategories.includes(c));

  const filtered0 = listings.filter(
    (l) =>
      matchesCategory(l, category) && matchesKind(l, kind) && matchesText(l) && matchesCreator(l) && matchesTag(l, tag) && matchesPrice(l),
  );
  // 'newest' needs no re-sort -- `listings` already arrives in that order
  // (Founding Creators first, then newest) from getServerSideProps, and
  // re-deriving it here would mean two places agreeing on one ordering.
  const filtered =
    sort === 'price-low'
      ? [...filtered0].sort((a, b) => (a.priceCents || 0) - (b.priceCents || 0))
      : sort === 'price-high'
      ? [...filtered0].sort((a, b) => (b.priceCents || 0) - (a.priceCents || 0))
      : filtered0;

  // Faceted counts: every OTHER active filter applied, that facet's own
  // filter left off -- so "how many if I picked this" is always accurate,
  // including under compound filters (a kind + a tag + a search term at once).
  const kindCounts = { all: 0, photo: 0, video: 0, physical: 0 };
  for (const l of listings) {
    if (matchesCategory(l, category) && matchesText(l) && matchesCreator(l) && matchesTag(l, tag) && matchesPrice(l)) {
      kindCounts.all += 1;
      kindCounts[kindOf(l)] += 1;
    }
  }
  const tagCounts = {};
  for (const t of allTags) {
    tagCounts[t] = listings.filter(
      (l) =>
        matchesCategory(l, category) && matchesKind(l, kind) && matchesText(l) && matchesCreator(l) && matchesTag(l, t) && matchesPrice(l),
    ).length;
  }
  // Same rule for categories: every other filter applied, the category left
  // off. `categoryAll` is what "All" would show.
  const { total: categoryAll, counts: categoryCounts } = countByCategory(
    listings.filter((l) => matchesKind(l, kind) && matchesText(l) && matchesCreator(l) && matchesTag(l, tag) && matchesPrice(l)),
    (l) => l.creatorCategories,
  );

  return (
    <>
      <Head>
        <title>Marketplace — OnlyOne</title>
        <meta name="description" content="Buy photo sets, video and merch direct from OnlyOne creators." />
        <meta name="rating" content="RTA-5042-1996-1400-1577-RTA" />
      </Head>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] px-6 py-3 rounded-full bg-brand-pink text-white font-bold shadow-lg">
          {toast}
        </div>
      )}

      {reporting && (
        <ReportModal
          title={`Report "${reporting.title}"`}
          subject="this listing"
          onSubmit={submitReport}
          onClose={() => setReporting(null)}
          takedownContent={listingReportRef(reporting)}
        />
      )}

      <div className="min-h-screen bg-brand-ink text-white pb-20">
        <SiteNav signedIn={!!sessionUser} viewerAvatar={sessionUser?.img || null} />

        {/* Header. Ambient glow only -- the listings themselves carry the
            imagery, and every preview is blurred until someone owns it. */}
        <div className="relative overflow-hidden border-b border-white/5">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            <div className="absolute left-1/2 -top-40 -translate-x-1/2 w-[800px] h-[500px] max-w-[160vw] rounded-full bg-brand-pink/10 blur-[130px]" />
          </div>
          <div className="relative max-w-6xl mx-auto px-6 py-12">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-[11px] tracking-[0.3em] text-brand-pink mb-3">MARKETPLACE</p>
                <h1 className="text-4xl sm:text-5xl font-black tracking-tight leading-none">
                  BUY DIRECT FROM <span className="text-brand-pink">CREATORS</span>
                </h1>
              </div>
              <Tagline className="mt-2">More Than Content</Tagline>
            </div>
            <p className="mt-4 text-sm text-gray-400 max-w-xl leading-relaxed">
              Photo sets, video, and physical merch — listed by creators at whatever price they set.
              Every purchase is between you and them.
            </p>

            {/* Said plainly and up front rather than discovered at checkout.
                paymentsLive reflects whether real crypto checkout is actually
                configured (lib/marketplace-payment-config.js) -- never
                claimed true until the payout address, USDC contract and RPC
                are all really set. */}
            <div className="mt-6 inline-flex items-start gap-2 px-4 py-2.5 rounded-xl border border-brand-pink/25 bg-brand-pink/5 text-xs text-gray-300">
              <span className="text-brand-pink font-bold">Heads up:</span>
              <span>
                {paymentsLive
                  ? `Checkout is live — pay with credits, no wallet needed at checkout. Buy credits once with a crypto wallet (${stableSymbol}) on the Credits page, then spend them on marketplace items and messages. Digital items appear under Your Orders once bought.`
                  : 'Browsing is live. Checkout opens when payments do — nothing here can charge you yet.'}
              </span>
            </div>
          </div>
        </div>

        <div className="max-w-6xl mx-auto px-6 pt-10 grid lg:grid-cols-[220px_1fr] gap-8">
          {/* Filters. Every one of these is real and wired to `filtered`
              below -- no invented counts like "Fetish (231)". CATEGORIES is
              the platform's fixed taxonomy (lib/categories.js), each with a
              real faceted count, zeros included -- the list is short and
              closed, so a zero is honest ("nothing here yet"). TAGS only
              lists values at least one active listing actually has (see
              allTags in getServerSideProps); a tag nobody's used yet simply
              isn't a button, never a zero. Below lg the categories are a
              horizontal scroll row above the grid instead (see there). */}
          <aside className="space-y-6 lg:sticky lg:top-20 self-start">
            <div className="hidden lg:block">
              <p className="text-xs font-bold tracking-widest text-gray-400 mb-3">CATEGORIES</p>
              <div className="space-y-1">
                {[{ key: null, label: 'All' }, ...CATEGORIES].map((c) => {
                  const on = (category || null) === c.key;
                  return (
                    <button
                      key={c.key || 'all'}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setCategory(c.key)}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm text-left transition ${
                        on ? 'bg-brand-pink/15 text-brand-pink font-bold' : 'text-gray-300 hover:bg-white/5'
                      }`}
                    >
                      <span className="flex-1">{c.label}</span>
                      <span className="text-[11px] text-gray-500">{c.key ? categoryCounts[c.key] : categoryAll}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <p className="text-xs font-bold tracking-widest text-gray-400 mb-3">SEARCH</p>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search listings..."
                className="w-full px-4 py-2.5 rounded-full bg-white/5 border border-white/10 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-brand-pink/60"
              />
            </div>

            <div>
              <p className="text-xs font-bold tracking-widest text-gray-400 mb-3">CONTENT TYPE</p>
              <div className="space-y-1">
                {KINDS.map((k) => (
                  <button
                    key={k.value}
                    onClick={() => setKind(k.value)}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm text-left transition ${
                      kind === k.value ? 'bg-brand-pink/15 text-brand-pink font-bold' : 'text-gray-300 hover:bg-white/5'
                    }`}
                  >
                    <span
                      className={`w-4 h-4 rounded border shrink-0 flex items-center justify-center ${
                        kind === k.value ? 'bg-brand-pink border-brand-pink' : 'border-white/25'
                      }`}
                    >
                      {kind === k.value && <Icons.check className="h-3 w-3 text-white" />}
                    </span>
                    <span className="flex-1">{k.label}</span>
                    <span className="text-[11px] text-gray-500">{kindCounts[k.value]}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs font-bold tracking-widest text-gray-400 mb-3">MAX PRICE</p>
              <input
                type="range"
                min={0}
                max={maxCents}
                step={100}
                value={maxPriceCents}
                onChange={(e) => setMaxPriceCents(Number(e.target.value))}
                className="w-full accent-brand-pink"
              />
              <p className="text-xs text-gray-500 mt-1">Up to ${(maxPriceCents / 100).toFixed(0)}</p>
            </div>

            <div>
              <p className="text-xs font-bold tracking-widest text-gray-400 mb-3">CREATOR</p>
              <input
                value={creatorQ}
                onChange={(e) => setCreatorQ(e.target.value)}
                placeholder="Filter by creator..."
                className="w-full px-4 py-2.5 rounded-full bg-white/5 border border-white/10 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-brand-pink/60"
              />
            </div>

            {allTags.length > 0 && (
              <div>
                <p className="text-xs font-bold tracking-widest text-gray-400 mb-3">TAGS</p>
                <div className="space-y-1">
                  {allTags.map((t) => (
                    <button
                      key={t}
                      onClick={() => setTag(t === tag ? '' : t)}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm text-left transition ${
                        tag === t ? 'bg-brand-pink/15 text-brand-pink font-bold' : 'text-gray-300 hover:bg-white/5'
                      }`}
                    >
                      <span
                        className={`w-4 h-4 rounded border shrink-0 flex items-center justify-center ${
                          tag === t ? 'bg-brand-pink border-brand-pink' : 'border-white/25'
                        }`}
                      >
                        {tag === t && <Icons.check className="h-3 w-3 text-white" />}
                      </span>
                      <span className="flex-1 truncate">#{t}</span>
                      <span className="text-[11px] text-gray-500">{tagCounts[t]}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </aside>

          <div>
          {/* Below lg the sidebar stacks above the grid, so the categories
              ride here instead as a horizontal scroll row -- same `category`
              state and counts as the sidebar list, not a second filter. */}
          <div className="lg:hidden -mx-6 px-6 mb-4 overflow-x-auto">
            <div className="flex gap-2 whitespace-nowrap">
              {[{ key: null, label: 'All' }, ...CATEGORIES].map((c) => {
                const on = (category || null) === c.key;
                return (
                  <button
                    key={c.key || 'all'}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setCategory(c.key)}
                    className={`text-xs px-3.5 py-1.5 rounded-full border transition ${
                      on ? 'bg-brand-pink border-brand-pink text-white font-bold' : 'border-white/15 text-gray-300 hover:bg-white/5'
                    }`}
                  >
                    {c.label} <span className={on ? 'text-white/80' : 'text-gray-500'}>{c.key ? categoryCounts[c.key] : categoryAll}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Quick content-type chips, same `kind` state as the sidebar --
              a second way to set the same filter, not a second filter. */}
          <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
            <div className="flex flex-wrap gap-2">
              {KINDS.map((k) => (
                <button
                  key={k.value}
                  onClick={() => setKind(k.value)}
                  className={`text-xs sm:text-sm px-3.5 py-1.5 rounded-full border transition ${
                    kind === k.value ? 'bg-brand-pink border-brand-pink text-white font-bold' : 'border-white/15 text-gray-300 hover:bg-white/5'
                  }`}
                >
                  {k.label}
                </button>
              ))}
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="text-xs sm:text-sm px-3 py-2 rounded-full bg-white/5 border border-white/10 text-gray-300 focus:outline-none focus:border-brand-pink/60"
            >
              {SORTS.map((s) => (
                <option key={s.value} value={s.value} className="bg-brand-ink">
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          {category && (
            <div className="mb-4 mr-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-brand-pink/40 bg-brand-pink/10 text-xs text-gray-200">
              <span>
                Category: <span className="font-bold text-white">{categoryLabel(category)}</span>
              </span>
              <button type="button" onClick={() => setCategory(null)} className="text-brand-pink hover:underline font-bold">
                Show all
              </button>
            </div>
          )}

          {creatorId && (
            <div className="mb-4 inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-brand-pink/40 bg-brand-pink/10 text-xs text-gray-200">
              <span>
                Showing listings from <span className="font-bold text-white">{focusCreatorName || 'this creator'}</span>
              </span>
              <button
                type="button"
                onClick={() => {
                  setCreatorId(null);
                  setHighlightId(null);
                }}
                className="text-brand-pink hover:underline font-bold"
              >
                Show all
              </button>
            </div>
          )}

          {filtered.length === 0 ? (
            <div className="text-center py-24">
              <p className="text-gray-400">
                {listings.length === 0 ? 'Nothing listed yet.' : 'Nothing matches that.'}
              </p>
              {listings.length === 0 && (
                <a href="/dashboard" className="mt-5 inline-block px-6 py-3 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-bold text-sm transition">
                  Creators — list the first thing
                </a>
              )}
            </div>
          ) : (
            <>
              <p className="text-xs text-gray-500 mb-4">
                {filtered.length} {filtered.length === 1 ? 'listing' : 'listings'}
              </p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {filtered.map((l) => (
                  <div
                    key={l.id}
                    id={`listing-${l.id}`}
                    className={`group rounded-2xl overflow-hidden bg-white/5 border hover:border-brand-pink/40 transition flex flex-col ${
                      highlightId && String(highlightId) === String(l.id) ? 'border-brand-pink ring-2 ring-brand-pink/60' : 'border-white/5'
                    }`}
                  >
                    <div className="aspect-square relative bg-black/40">
                      <ListingPreview media={l.media} />

                      <div className="absolute top-2 left-2 flex flex-col gap-1 items-start">
                        {l.demo && <DemoBadge short />}
                        {l.creatorFounding && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-brand-pink text-white font-black tracking-wide">FOUNDING</span>
                        )}
                        {(l.aiGenerated || l.media?.some((m) => m.aiGenerated)) && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-black/75 text-brand-pink font-bold">AI</span>
                        )}
                        {l.kind === 'physical' && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-black/75 text-gray-200 font-bold">SHIPS</span>
                        )}
                      </div>

                      {/* In-product reports need an account, and signups can be
                          closed -- so a signed-out visitor's flag goes straight to
                          the takedown form (no account needed, and it takes
                          suspected-underage reports), prefilled with this listing. */}
                      {sessionUser ? (
                        <button
                          onClick={() => setReporting(l)}
                          className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/70 text-white text-xs opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-black/90 transition"
                          title="Report this listing"
                        >
                          <Icons.flag className="h-3.5 w-3.5 mx-auto" />
                        </button>
                      ) : (
                        <a
                          href={takedownFormHref({ content: listingReportRef(l) })}
                          target="_blank"
                          rel="noreferrer"
                          className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/70 text-white text-xs opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-black/90 transition flex items-center justify-center"
                          title="Report this listing (no account needed)"
                        >
                          <Icons.flag className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </div>

                    <div className="p-3 flex flex-col flex-1">
                      <a href={`/creator/${l.creatorId}`} className="flex items-center gap-2 mb-2 group/creator">
                        <img src={l.creatorImg} alt="" className="w-5 h-5 rounded-full object-cover object-top" />
                        <span className="text-[11px] text-gray-400 truncate group-hover/creator:text-brand-pink transition">
                          {l.creatorName}
                        </span>
                      </a>
                      <p className="font-bold text-sm leading-snug mb-1 line-clamp-2">{l.title}</p>
                      {Array.isArray(l.tags) && l.tags.length > 0 && (
                        <p className="text-[10px] text-brand-pink/80 mb-2 line-clamp-1">{l.tags.map((t) => `#${t}`).join(' ')}</p>
                      )}
                      {l.demo ? (
                        <p className="mt-auto w-full py-2.5 rounded-full bg-yellow-400/15 border border-yellow-400/40 text-yellow-200 text-xs font-bold text-center">
                          {DEMO_LABEL}
                        </p>
                      ) : (
                      <button
                        onClick={() => addToCart(l)}
                        disabled={cart.has(l.id)}
                        className="mt-auto w-full py-2.5 rounded-full bg-white/10 hover:bg-brand-pink text-sm font-bold transition disabled:opacity-60 disabled:hover:bg-white/10 flex items-center justify-center gap-1.5"
                      >
                        {cart.has(l.id) ? (
                          <>
                            <Icons.check className="h-3.5 w-3.5" /> In cart
                          </>
                        ) : (
                          <>${(l.priceCents / 100).toFixed(2)} · Add to cart</>
                        )}
                      </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          </div>
        </div>

        <footer className="border-t border-white/5 mt-20 py-8 px-6">
          <div className="max-w-6xl mx-auto flex flex-wrap justify-center gap-x-5 gap-y-2 text-[11px] text-gray-600">
            <a href={MAIN_SITE} className="hover:text-brand-pink transition">OnlyOne</a>
            <a href={`${MAIN_SITE}/terms#marketplace`} className="hover:text-brand-pink transition">Marketplace Terms</a>
            <a href={`${MAIN_SITE}/privacy`} className="hover:text-brand-pink transition">Privacy</a>
            <a href={`${MAIN_SITE}/report-content`} className="text-red-400 hover:text-red-300 transition font-semibold">
              Report Non-Consensual Content
            </a>
          </div>
          <p className="text-[11px] text-gray-600 text-center mt-3">18+ only. Sales are between buyer and creator.</p>
        </footer>
      </div>
    </>
  );
}
