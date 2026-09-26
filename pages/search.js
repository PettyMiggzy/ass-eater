import { useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import SiteNav from '../components/SiteNav';
import { getSessionUser } from '../lib/session';
import { publicUser } from '../lib/users-store';
import { getCreators } from '../lib/creators-store';
import { toPublicCreator, toPublicListing, isPubliclyVisible, listingHasDeliverable } from '../lib/creator-status';
import { byPlacement, isFoundingCreator } from '../lib/founding';
import { getListings } from '../lib/listings-store';
import ListingPreview from '../components/public/ListingPreview';
import DemoBadge from '../components/public/DemoBadge';
import PremiumBadge from '../components/public/PremiumBadge';
import { toCreatorCard, isDemoListing, DEMO_LABEL, marketplaceHrefFor } from '../components/public/cards';
import { CATEGORIES, categoryFromQuery, categoryLabel, creatorInCategory, withCategoryParam } from '../lib/categories';

const str = (v) => (typeof v === 'string' ? v : '');

export async function getServerSideProps({ query, req }) {
  const sessionUser = publicUser(await getSessionUser(req));
  // A repeated ?q=a&q=b arrives as an array; only a plain string is a query.
  const q = str(query.q).trim().toLowerCase().slice(0, 200);
  const tag = str(query.tag).trim().toLowerCase().slice(0, 50);
  // ?category= (lib/categories.js) narrows whatever else was asked for, and on
  // its own lists that category's creators. Unknown values are no filter.
  const category = categoryFromQuery(query.category);
  const [allCreators, allListings] = await Promise.all([getCreators(), getListings()]);
  const visibleCreators = allCreators.filter(isPubliclyVisible);
  const inCategory = visibleCreators.filter((c) => creatorInCategory(c, category));

  // byPlacement: Founding Creators first, the same "priority placement" sort
  // /creators, /home and /marketplace apply. Every landing-page category and
  // every #tag chip lands HERE, so without it the founding promise ("lead
  // every browse page") was false on the page fans reach most.
  const creators = (tag
    ? inCategory.filter((c) => Array.isArray(c.tags) && c.tags.includes(tag))
    : q
    ? inCategory.filter((c) =>
        str(c.name).toLowerCase().includes(q) || str(c.handle).toLowerCase().includes(q) || str(c.bio).toLowerCase().includes(q)
      )
    : category
    ? inCategory
    : []
  ).sort(byPlacement);

  const listings = !tag && q
    ? allListings
        // listingHasDeliverable: a digital listing with no files can't be
        // bought (checkout refuses it), so it isn't offered here either.
        // Checked on the stored record, before toPublicListing strips srcs.
        .filter((l) => l.status === 'active' && listingHasDeliverable(l) && (str(l.title).toLowerCase().includes(q) || str(l.description).toLowerCase().includes(q)))
        .map((l) => {
          // A listing inherits its seller's categories, so resolving against
          // the category-filtered roster applies ?category= to listings too.
          const creator = inCategory.find((c) => String(c.id) === String(l.creatorId));
          // toPublicListing: blurred previews only, never a media src.
          return creator
            ? {
                ...toPublicListing(l, creator),
                creatorName: creator.name,
                creatorFounding: isFoundingCreator(creator),
                demo: isDemoListing(l, creator),
              }
            : null;
        })
        // Dropped outright, not shown as "Unknown": hiding a suspended or
        // banned creator has to hide what they are selling too, the same way
        // /marketplace and /api/marketplace/list now do.
        .filter(Boolean)
        // Founding Creators' listings first, newest first within each group --
        // the same order /marketplace uses.
        .sort((a, b) => {
          const founding = (b.creatorFounding ? 1 : 0) - (a.creatorFounding ? 1 : 0);
          if (founding !== 0) return founding;
          return new Date(b.createdAt) - new Date(a.createdAt);
        })
    : [];

  // Every distinct tag any creator has set, for the browse-by-tag cloud shown
  // when nobody's searching for anything specific yet.
  const allTags = [...new Set(visibleCreators.flatMap((c) => (Array.isArray(c.tags) ? c.tags.filter((t) => typeof t === 'string') : [])))].sort();

  // Cards only -- a result tile needs a name and an avatar, not galleries.
  return {
    props: { q, tag, category, creators: creators.map((c) => toCreatorCard(toPublicCreator(c))), listings, allTags, sessionUser },
  };
}

export default function Search({ q, tag, category = null, creators, listings, allTags, sessionUser }) {
  const router = useRouter();
  const [value, setValue] = useState(q);

  const submit = (e) => {
    e.preventDefault();
    // A picked category stays applied to the new search.
    router.push(`/search${withCategoryParam(`q=${encodeURIComponent(value)}`, category)}`);
  };

  const browsing = !q && !tag && !category;
  // A category chip keeps the current q/tag and sets (or, when it is the one
  // already picked, clears) ?category=.
  const currentParams = new URLSearchParams();
  if (q) currentParams.set('q', q);
  if (tag) currentParams.set('tag', tag);
  const categoryHref = (key) => `/search${withCategoryParam(currentParams.toString(), key === category ? null : key)}`;

  return (
    <>
      <Head><title>Search - OnlyOne</title></Head>
      <div className="min-h-screen bg-gradient-luxury text-white">
        <SiteNav signedIn={!!sessionUser} viewerAvatar={sessionUser?.img || null} />
        <div className="max-w-4xl mx-auto px-6 py-10">
          <form onSubmit={submit} className="mb-6">
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Search creators and marketplace listings..."
              className="w-full px-5 py-4 rounded-md bg-black/40 border border-brand-purple/30 text-white text-lg"
            />
          </form>

          <div className="mb-6">
            <h2 className="text-sm font-bold text-brand-gold uppercase tracking-wide mb-3">Browse by category</h2>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((c) => (
                <a
                  key={c.key}
                  href={categoryHref(c.key)}
                  aria-current={category === c.key ? 'true' : undefined}
                  className={`text-xs px-3 py-1.5 rounded-full border transition ${
                    category === c.key
                      ? 'bg-brand-pink text-white border-transparent font-bold'
                      : 'bg-white/5 border-white/15 text-gray-200 hover:bg-white/10'
                  }`}
                >
                  {c.label}
                </a>
              ))}
            </div>
          </div>

          {allTags.length > 0 && (
            <div className="mb-10">
              <h2 className="text-sm font-bold text-brand-gold uppercase tracking-wide mb-3">Browse by tag</h2>
              <div className="flex flex-wrap gap-2">
                {allTags.map((t) => (
                  <a
                    key={t}
                    href={`/search${withCategoryParam(`tag=${encodeURIComponent(t)}`, category)}`}
                    className={`text-xs px-3 py-1.5 rounded-full border transition ${
                      tag === t
                        ? 'bg-brand-gold text-black border-transparent font-bold'
                        : 'bg-brand-purple/15 border-brand-purple/30 text-brand-gold hover:bg-brand-purple/30'
                    }`}
                  >
                    #{t}
                  </a>
                ))}
              </div>
            </div>
          )}

          {tag && (
            <p className="text-gray-400 mb-6">
              Showing creators tagged <span className="text-brand-gold font-bold">#{tag}</span> ·{' '}
              <a href={`/search${withCategoryParam('', category)}`} className="underline">clear</a>
            </p>
          )}

          {category && (
            <p className="text-gray-400 mb-6">
              In category <span className="text-brand-pink font-bold">{categoryLabel(category)}</span> ·{' '}
              <a href={`/search${withCategoryParam(currentParams.toString(), null)}`} className="underline">clear</a>
            </p>
          )}

          {browsing ? (
            allTags.length === 0 && <p className="text-gray-500">Type something to search creators and the marketplace.</p>
          ) : creators.length === 0 && listings.length === 0 ? (
            <p className="text-gray-500">
              {tag || q
                ? `No results for "${tag ? `#${tag}` : q}"${category ? ` in ${categoryLabel(category)}` : ''}.`
                : `No creators in ${categoryLabel(category)} yet.`}
            </p>
          ) : (
            <div className="space-y-10">
              {creators.length > 0 && (
                <div>
                  <h2 className="text-sm font-bold text-brand-gold uppercase tracking-wide mb-4">Creators</h2>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    {creators.map((c) => (
                      <a key={c.id} href={`/creator/${c.id}`} className="premium-card border border-brand-gold/20 overflow-hidden block">
                        <div className="aspect-square">
                          <img src={c.img} alt={c.name} className="w-full h-full object-cover object-top" />
                        </div>
                        <div className="p-2">
                          <p className="text-sm font-bold truncate flex items-center gap-1">
                            {c.name}
                            {c.premium && <PremiumBadge />}
                          </p>
                          {c.demo && <DemoBadge short className="mt-1" />}
                        </div>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {listings.length > 0 && (
                <div>
                  <h2 className="text-sm font-bold text-brand-gold uppercase tracking-wide mb-4">Marketplace</h2>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    {listings.map((l) => (
                      <a key={l.id} href={marketplaceHrefFor(l)} className="premium-card border border-brand-gold/20 overflow-hidden block">
                        <div className="aspect-square relative">
                          <ListingPreview media={l.media} />
                          {l.demo && <DemoBadge short className="absolute top-2 left-2" />}
                          {/* Terms §4/§7: AI-generated content is labelled wherever it
                              shows -- same test as /marketplace and the profile. */}
                          {(l.aiGenerated || (Array.isArray(l.media) && l.media.some((m) => m && m.aiGenerated))) && (
                            <span className="absolute top-2 right-2 text-[9px] px-1.5 py-0.5 rounded bg-black/75 text-brand-pink font-bold">AI</span>
                          )}
                        </div>
                        <div className="p-2">
                          <p className="text-sm font-bold truncate">{l.title}</p>
                          <p className="text-xs text-gray-500 truncate">
                            {l.creatorName} · {l.demo ? DEMO_LABEL : `$${(l.priceCents / 100).toFixed(2)}`}
                          </p>
                        </div>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
