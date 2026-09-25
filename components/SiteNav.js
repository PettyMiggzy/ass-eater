import { useState } from 'react';
import { useRouter } from 'next/router';
import { SolidIcons, Icons } from './Brand';
import { useCart } from '../lib/cart';
import NotificationBell from './NotificationBell';

/**
 * The top bar from the OnlyOne designs: brand, section links, creator
 * search, saved-creators shortcut, and either the signed-in person's
 * avatar or log in / sign up.
 *
 * The whole site is branded OnlyOne now (decided 2026-09-19, superseding the
 * earlier "no rename" note in MEMORY.md -- joinonlyone.com is the primary
 * domain, the token is $ONLYONE, and every visible old-brand string was
 * swapped the same day).
 *
 * The mark is the founder's real lockup (supplied 2026-09-20), not the
 * hand-drawn SVG approximation that stood in for it before. It is a
 * transparent PNG extracted from art on a black background by treating the
 * composite as additive -- alpha is the brightest channel, colour is the
 * pixel un-premultiplied by it -- which is exact at every edge pixel and so
 * leaves no dark halo. Keying black to transparent, which is how the old
 * badge art was cut, keeps the darkened edge pixels and fringes the mark
 * against any background that is not the one it was cut on. Use this method
 * for any future art supplied on black.
 *
 * It is listed in proxy.js's BRAND_ART_PATHS: this nav renders on /2257,
 * which is exempt from the age gate, so without that the logo would be the
 * one broken image on a page a regulator reads.
 *
 * Below `md` the section links, the search box, Orders and (below `sm`)
 * favorites and Sign up collapse into a menu toggle. Before it existed a
 * phone had no way to reach Explore, Creators, Marketplace or Search from
 * the shared nav at all -- the Marketplace, the site's only purchase path,
 * was reachable only through a creator's Shop tab.
 */

export default function SiteNav({ signedIn = false, viewerAvatar = null, viewerHref = '/dashboard' }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const cart = useCart();

  const submit = (e) => {
    e.preventDefault();
    const term = q.trim();
    setMenuOpen(false);
    if (term) router.push(`/search?q=${encodeURIComponent(term)}`);
  };

  const searchField = (
    <label className="relative block">
      <span className="sr-only">Search creators</span>
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"
           className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500">
        <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="2" />
        <path d="M14 14l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search creators..."
        className="w-full pl-9 pr-4 py-2 rounded-full bg-white/5 border border-white/10 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-brand-pink/60"
      />
    </label>
  );

  return (
    <header className="sticky top-0 z-50 bg-brand-ink/95 backdrop-blur border-b border-white/5">
      <div className="max-w-6xl mx-auto px-4 md:px-6 h-16 flex items-center gap-2 sm:gap-4">
        <a href="/home" className="flex items-center shrink-0" aria-label="OnlyOne home">
          <img
            src="/images/onlyone-lockup-nav.png"
            alt="OnlyOne"
            width={438}
            height={72}
            className="h-6 sm:h-7 w-auto"
          />
        </a>

        <nav className="hidden md:flex items-center gap-6 text-sm text-gray-300">
          <a href="/home" className="hover:text-white transition">Home</a>
          <a href="/search" className="hover:text-white transition">Explore</a>
          <a href="/creators" className="hover:text-white transition">Creators</a>
          <a href="/marketplace" className="hover:text-white transition">Marketplace</a>
        </nav>

        <form onSubmit={submit} className="flex-1 max-w-sm ml-auto hidden md:block">
          {searchField}
        </form>
        <div className="flex-1 md:hidden" />

        <a href="/favorites" title="Saved creators"
           className="hidden sm:flex shrink-0 w-9 h-9 rounded-full border border-white/10 items-center justify-center text-gray-300 hover:text-brand-pink hover:border-brand-pink/50 transition">
          <SolidIcons.heart className="h-4 w-4" />
        </a>

        {signedIn && (
          <a href="/orders" title="Your orders" className="hidden md:block shrink-0 text-xs text-gray-400 hover:text-brand-pink transition">
            Orders
          </a>
        )}

        {signedIn && (
          <a href="/settings" title="Account settings" className="hidden md:block shrink-0 text-xs text-gray-400 hover:text-brand-pink transition">
            Settings
          </a>
        )}

        {signedIn && <NotificationBell />}

        <a href="/cart" title="Cart" className="relative shrink-0 w-9 h-9 rounded-full border border-white/10 flex items-center justify-center text-gray-300 hover:text-brand-pink hover:border-brand-pink/50 transition">
          <Icons.cart className="h-4 w-4" />
          {cart.items.length > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-brand-pink text-white text-[10px] font-bold flex items-center justify-center">
              {cart.items.length}
            </span>
          )}
        </a>

        {viewerAvatar ? (
          <a href={viewerHref} className="shrink-0 w-9 h-9 rounded-full overflow-hidden border border-white/10 hover:border-brand-pink/60 transition">
            <img src={viewerAvatar} alt="Your account" className="w-full h-full object-cover" />
          </a>
        ) : signedIn ? (
          // Signed in but we have no picture for them. Deliberately not
          // substituting a stock face -- a placeholder avatar reads as
          // "this is you" and it isn't.
          <a href={viewerHref} className="shrink-0 text-sm px-4 py-1.5 rounded-full border border-white/15 text-gray-200 hover:border-brand-pink/50 transition">
            Account
          </a>
        ) : (
          <div className="flex items-center gap-2 shrink-0">
            <a href="/login" className="text-sm px-4 py-1.5 rounded-full border border-white/15 text-gray-200 hover:border-white/40 transition">
              Log in
            </a>
            <a href="/signup" className="hidden sm:inline-block text-sm px-4 py-1.5 rounded-full bg-brand-pink text-white font-semibold hover:bg-brand-pink-dark transition">
              Sign up
            </a>
          </div>
        )}

        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          aria-expanded={menuOpen}
          aria-controls="site-nav-menu"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          className="md:hidden shrink-0 w-9 h-9 rounded-full border border-white/10 flex items-center justify-center text-gray-300 hover:text-white transition"
        >
          {menuOpen ? (
            <Icons.close className="h-4 w-4" />
          ) : (
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
              <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          )}
        </button>
      </div>

      {menuOpen && (
        <div id="site-nav-menu" className="md:hidden border-t border-white/5 bg-brand-ink px-4 pb-4 pt-3">
          <form onSubmit={submit} className="mb-3">
            {searchField}
          </form>
          <nav className="grid grid-cols-2 gap-1 text-sm text-gray-200">
            <a href="/home" className="px-3 py-2 rounded-lg hover:bg-white/5">Home</a>
            <a href="/search" className="px-3 py-2 rounded-lg hover:bg-white/5">Explore</a>
            <a href="/creators" className="px-3 py-2 rounded-lg hover:bg-white/5">Creators</a>
            <a href="/marketplace" className="px-3 py-2 rounded-lg hover:bg-white/5">Marketplace</a>
            <a href="/favorites" className="px-3 py-2 rounded-lg hover:bg-white/5">Saved creators</a>
            {signedIn ? (
              <>
                <a href="/orders" className="px-3 py-2 rounded-lg hover:bg-white/5">Orders</a>
                <a href="/credits" className="px-3 py-2 rounded-lg hover:bg-white/5">Credits</a>
                <a href={viewerHref} className="px-3 py-2 rounded-lg hover:bg-white/5">Account</a>
                <a href="/settings" className="px-3 py-2 rounded-lg hover:bg-white/5">Settings</a>
              </>
            ) : (
              <>
                <a href="/login" className="px-3 py-2 rounded-lg hover:bg-white/5">Log in</a>
                <a href="/signup" className="px-3 py-2 rounded-lg hover:bg-white/5 text-brand-pink font-semibold">Sign up</a>
              </>
            )}
          </nav>
        </div>
      )}
    </header>
  );
}
