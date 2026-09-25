import Head from 'next/head';
import SiteNav from '../components/SiteNav';
import { getVerifiedSessionUserId } from '../lib/session';
import { getCreators } from '../lib/creators-store';
import { toPublicCreator, isPubliclyVisible } from '../lib/creator-status';
import { getFavoriteCreatorIds } from '../lib/favorites-store';
import DemoBadge from '../components/public/DemoBadge';
import PremiumBadge from '../components/public/PremiumBadge';
import { toCreatorCard } from '../components/public/cards';

export async function getServerSideProps({ req }) {
  const uid = await getVerifiedSessionUserId(req);
  if (!uid) {
    return { redirect: { destination: '/login?next=/favorites', permanent: false } };
  }
  const [allCreators, favoriteIds] = await Promise.all([getCreators(), getFavoriteCreatorIds(uid)]);
  const creators = allCreators
    .filter((c) => isPubliclyVisible(c) && favoriteIds.some((id) => String(id) === String(c.id)))
    // Public projection first (private fields and gated srcs gone), then
    // just the card this page draws -- no gallery arrays.
    .map((c) => toCreatorCard(toPublicCreator(c)));
  return { props: { creators } };
}

export default function Favorites({ creators }) {
  return (
    <>
      <Head><title>Your Favorites - OnlyOne</title></Head>
      <div className="min-h-screen bg-gradient-luxury text-white">
        <SiteNav signedIn />
        <div className="max-w-4xl mx-auto px-6 py-10">
          <h1 className="text-2xl font-black premium-title mb-2">Your Favorites</h1>
          <p className="text-gray-400 mb-8">Creators you've saved -- tap the heart on their profile to add or remove one.</p>

          {creators.length === 0 ? (
            <p className="text-gray-500">
              No favorites yet. <a href="/search" className="text-brand-gold hover:underline">Find some creators</a> and tap the heart on their profile.
            </p>
          ) : (
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
          )}
        </div>
      </div>
    </>
  );
}
