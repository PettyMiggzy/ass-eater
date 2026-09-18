import Head from 'next/head';
import { getVerifiedSessionUserId } from '../lib/session';
import { getCreators, toPublicCreator, isPubliclyVisible } from '../lib/creators-store';
import { getFavoriteCreatorIds } from '../lib/favorites-store';

export async function getServerSideProps({ req }) {
  const uid = await getVerifiedSessionUserId(req);
  if (!uid) {
    return { redirect: { destination: '/login?next=/favorites', permanent: false } };
  }
  const [allCreators, favoriteIds] = await Promise.all([getCreators(), getFavoriteCreatorIds(uid)]);
  const creators = allCreators
    .filter((c) => isPubliclyVisible(c) && favoriteIds.some((id) => String(id) === String(c.id)))
    .map(toPublicCreator);
  return { props: { creators } };
}

export default function Favorites({ creators }) {
  return (
    <>
      <Head><title>Your Favorites - Only Ass</title></Head>
      <div className="min-h-screen bg-gradient-luxury text-white px-6 py-10">
        <div className="max-w-4xl mx-auto">
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
                      {c.premium && <img src="/icons/check.png" alt="" className="h-3.5 w-3.5" />}
                    </p>
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
