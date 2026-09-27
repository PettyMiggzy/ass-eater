import { Icons } from '../Brand';

/**
 * The row of thin pink line icons from the mockups -- restricted to features
 * that are LIVE on this site today. The mockups also show live cams,
 * subscriptions, tips, PPV and coin logos; none of those exist here, and a
 * feature row is exactly where a page quietly starts advertising things it
 * cannot sell. Add an item only when the feature ships.
 */
export const LIVE_FEATURES = [
  { Icon: Icons.tag, title: 'Creator Marketplace', sub: 'Buy direct from creators', href: '/marketplace' },
  { Icon: Icons.message, title: 'Direct Messaging', sub: 'Talk to the creators you like' },
  { Icon: Icons.coin, title: 'USDC Credits', sub: 'Pay with USDC credits — no card needed', href: '/credits' },
  { Icon: Icons.heart, title: 'Favorites', sub: 'Save the creators you follow', href: '/favorites' },
  { Icon: Icons.people, title: 'Creator Profiles', sub: 'Photos, links and a wall', href: '/creators' },
];

export default function FeatureRow({ className = '' }) {
  return (
    <section className={`py-12 px-4 sm:px-6 border-t border-white/5 ${className}`}>
      <ul className="max-w-6xl mx-auto grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-y-8 lg:divide-x lg:divide-white/10 text-center">
        {LIVE_FEATURES.map((f) => {
          const body = (
            <>
              <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-brand-pink/50 shadow-[0_0_16px_rgba(255,45,120,0.25)]">
                <f.Icon className="h-6 w-6 text-brand-pink" />
              </span>
              <span className="block font-brand font-bold text-sm text-white">{f.title}</span>
              <span className="block text-xs text-gray-400 mt-0.5 px-2">{f.sub}</span>
            </>
          );
          return (
            <li key={f.title} className="px-2">
              {f.href ? (
                <a href={f.href} className="block rounded-xl py-1 transition hover:bg-white/[0.03]">
                  {body}
                </a>
              ) : (
                body
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
