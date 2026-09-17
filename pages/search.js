import { useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { getCreators, toPublicCreator } from '../lib/creators-store';
import { getListings } from '../lib/listings-store';

export async function getServerSideProps({ query }) {
  const q = String(query.q || '').trim().toLowerCase();
  const tag = String(query.tag || '').trim().toLowerCase();
  const [allCreators, allListings] = await Promise.all([getCreators(), getListings()]);
  const visibleCreators = allCreators.filter((c) => c.status !== 'pending');

  const creators = tag
    ? visibleCreators.filter((c) => Array.isArray(c.tags) && c.tags.includes(tag))
    : q
    ? visibleCreators.filter((c) =>
        c.name?.toLowerCase().includes(q) || c.handle?.toLowerCase().includes(q) || c.bio?.toLowerCase().includes(q)
      )
    : [];

  const listings = !tag && q
    ? allListings
        .filter((l) => l.status === 'active' && (l.title.toLowerCase().includes(q) || (l.description || '').toLowerCase().includes(q)))
        .map((l) => {
          const creator = allCreators.find((c) => String(c.id) === String(l.creatorId));
          return { ...l, creatorName: creator?.name || 'Unknown' };
        })
    : [];

  // Every distinct tag any creator has set, for the browse-by-tag cloud shown
  // when nobody's searching for anything specific yet.
  const allTags = [...new Set(visibleCreators.flatMap((c) => (Array.isArray(c.tags) ? c.tags : [])))].sort();

  return { props: { q, tag, creators: creators.map(toPublicCreator), listings, allTags } };
}

export default function Search({ q, tag, creators, listings, allTags }) {
  const router = useRouter();
  const [value, setValue] = useState(q);

  const submit = (e) => {
    e.preventDefault();
    router.push(`/search?q=${encodeURIComponent(value)}`);
  };

  const browsing = !q && !tag;

  return (
    <>
      <Head><title>Search - Only Ass</title></Head>
      <div className="min-h-screen bg-gradient-luxury text-white px-6 py-10">
        <div className="max-w-4xl mx-auto">
          <form onSubmit={submit} className="mb-6">
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Search creators and marketplace listings..."
              className="w-full px-5 py-4 rounded-md bg-black/40 border border-brand-purple/30 text-white text-lg"
            />
          </form>

          {allTags.length > 0 && (
            <div className="mb-10">
              <h2 className="text-sm font-bold text-brand-gold uppercase tracking-wide mb-3">Browse by tag</h2>
              <div className="flex flex-wrap gap-2">
                {allTags.map((t) => (
                  <a
                    key={t}
                    href={`/search?tag=${encodeURIComponent(t)}`}
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
              <a href="/search" className="underline">clear</a>
            </p>
          )}

          {browsing ? (
            allTags.length === 0 && <p className="text-gray-500">Type something to search creators and the marketplace.</p>
          ) : creators.length === 0 && listings.length === 0 ? (
            <p className="text-gray-500">No results for "{tag ? `#${tag}` : q}".</p>
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
                            {c.premium && <img src="/icons/check.png" alt="" className="h-3.5 w-3.5" />}
                          </p>
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
                      <a key={l.id} href="/marketplace" className="premium-card border border-brand-gold/20 overflow-hidden block">
                        <div className="aspect-square relative bg-black/40">
                          {l.media?.[0] && (
                            l.media[0].type === 'video' ? (
                              <video src={l.media[0].src} className="w-full h-full object-cover blur-md scale-110" muted />
                            ) : (
                              <img src={l.media[0].src} alt="" className="w-full h-full object-cover blur-md scale-110" />
                            )
                          )}
                        </div>
                        <div className="p-2">
                          <p className="text-sm font-bold truncate">{l.title}</p>
                          <p className="text-xs text-gray-500 truncate">{l.creatorName} · ${(l.priceCents / 100).toFixed(2)}</p>
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
