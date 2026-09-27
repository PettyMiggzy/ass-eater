import Head from 'next/head';
import SiteNav from '../components/SiteNav';
import { getVerifiedSessionUserId } from '../lib/session';
import { getCreators } from '../lib/creators-store';
import { toPublicCreator, isPubliclyVisible } from '../lib/creator-status';
import { getFavoriteCreatorIds } from '../lib/favorites-store';
import { toCreatorCard } from '../components/public/cards';
import CreatorTile from '../components/public/CreatorTile';
import GatedHero from '../components/public/GatedHero';
import CategoryBar from '../components/public/CategoryBar';
import SiteFooter from '../components/public/SiteFooter';

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
      <div className="min-h-screen text-white">
        <SiteNav signedIn />
        <GatedHero
          eyebrow="Your favorites."
          line1="The creators"
          line2="you saved."
          sub="Creators you've saved -- tap the heart on their profile to add or remove one."
          primary={{ href: '/creators', label: 'Find More Creators' }}
          secondary={{ href: '/marketplace', label: 'Marketplace' }}
          modelSlug="sienna-blake"
          showTrust={false}
          compact
        />
        <CategoryBar basePath="/creators" />
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10">
          <h2 className="font-brand text-2xl font-extrabold mb-6">
            Your <span className="text-brand-pink">Favorites</span>
          </h2>

          {creators.length === 0 ? (
            <p className="text-gray-300">
              No favorites yet. <a href="/search" className="text-brand-pink-light font-semibold hover:underline">Find some creators</a> and tap the heart on their profile.
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {creators.map((c) => (
                <CreatorTile key={c.id} c={c} showHandle={false} />
              ))}
            </div>
          )}
        </div>
        <SiteFooter />
      </div>
    </>
  );
}
