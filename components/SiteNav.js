import { useState } from 'react';
import { useRouter } from 'next/router';
import { SolidIcons, Icons, Lockup } from './Brand';
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
 * The logo is the drawn "01" lockup from components/Brand.js (inline SVG,
 * restyled to the owner's 2026-09-27 mockups): nothing to fetch, so it can
 * never be the one broken image on /2257 or an age-gate page.
 *
 * Layout per the mockups: logo left, section links centred, then search,
 * the signed-in icons (saved creators, bell, cart) and the account pills --
 * "Log in" outlined, "Sign up" solid pink.
 *
 * Below `lg` the section links, the search box, Orders and (below `sm`)
 * favorites and Sign up collapse into a menu toggle. Before it existed a
 * phone had no way to reach Explore, Creators, Marketplace or Search from
 * the shared nav at all -- the Marketplace, the site's only purchase path,
 * was reachable only through a creator's Shop tab.
 */

// The centred section links (desktop). The phone menu below lists the same
// four plus the account links.
const NAV_LINKS = [
  { href: '/home', label: 'Home' },
  { href: '/search', label: 'Explore' },
  { href: '/creators', label: 'Creators' },
  { href: '/marketplace', label: 'Marketplace' },
];

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
        className="w-full pl-9 pr-4 py-2 rounded-full bg-white/5 border border-white/15 text-sm text-white placeholder:text-gray-400 focus:outline-none focus:border-brand-pink/70"
      />
    </label>
  );

  return (
    <header className="sticky top-0 z-50 bg-[#08060a]/90 backdrop-blur-md border-b border-brand-pink/15 shadow-[0_1px_24px_rgba(255,45,120,0.08)]">
      <div className="max-w-6xl mx-auto px-4 md:px-6 h-16 flex items-center gap-2 sm:gap-4">
        <a href="/home" className="flex items-center shrink-0 rounded-md" aria-label="OnlyOne home">
          <Lockup className="h-6 sm:h-7" />
        </a>

        <nav aria-label="Main" className="hidden lg:flex flex-1 items-center justify-center gap-7 font-brand text-[13px] font-semibold tracking-wide text-gray-200">
          {NAV_LINKS.map((l) => {
            const on = router.pathname === l.href;
            return (
              <a
                key={l.href}
                href={l.href}
                aria-current={on ? 'page' : undefined}
                className={`relative py-1 transition hover:text-white ${on ? 'text-white' : ''}`}
              >
                {l.label}
                {on && <span aria-hidden="true" className="absolute left-0 right-0 -bottom-1 h-0.5 rounded-full bg-brand-pink shadow-[0_0_8px_rgba(255,45,120,0.8)]" />}
              </a>
            );
          })}
        </nav>

        <form onSubmit={submit} className="w-52 xl:w-60 hidden lg:block">
          {searchField}
        </form>
        <div className="flex-1 lg:hidden" />

        <a href="/favorites" title="Saved creators"
           className="hidden sm:flex shrink-0 w-9 h-9 rounded-full border border-white/15 items-center justify-center text-gray-200 hover:text-brand-pink hover:border-brand-pink/60 transition">
          <SolidIcons.heart className="h-4 w-4" />
        </a>

        {signedIn && (
          <a href="/orders" title="Your orders" className="hidden lg:block shrink-0 text-xs text-gray-400 hover:text-brand-pink transition">
            Orders
          </a>
        )}

        {signedIn && (
          <a href="/settings" title="Account settings" className="hidden lg:block shrink-0 text-xs text-gray-400 hover:text-brand-pink transition">
            Settings
          </a>
        )}

        {signedIn && <NotificationBell />}

        <a href="/cart" title="Cart" aria-label={`Cart${cart.items.length ? ` (${cart.items.length})` : ''}`} className="relative shrink-0 w-9 h-9 rounded-full border border-white/15 flex items-center justify-center text-gray-300 hover:text-brand-pink hover:border-brand-pink/50 transition">
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
          <a href={viewerHref} className="shrink-0 font-brand text-[13px] font-semibold px-4 py-1.5 rounded-full border border-white/50 text-white hover:border-brand-pink transition">
            Account
          </a>
        ) : (
          <div className="flex items-center gap-2 shrink-0">
            <a href="/login" className="font-brand text-[13px] font-semibold px-4 py-1.5 rounded-full border border-white/50 text-white hover:border-brand-pink transition">
              Log in
            </a>
            <a href="/signup" className="hidden sm:inline-block font-brand text-[13px] font-bold px-4 py-1.5 rounded-full bg-brand-pink text-white shadow-[0_0_18px_rgba(255,45,120,0.45)] hover:bg-brand-pink-dark transition">
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
          className="lg:hidden shrink-0 w-9 h-9 rounded-full border border-white/15 flex items-center justify-center text-gray-200 hover:text-white transition"
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
        <div id="site-nav-menu" className="lg:hidden border-t border-brand-pink/15 bg-[#08060a] px-4 pb-4 pt-3">
          <form onSubmit={submit} className="mb-3">
            {searchField}
          </form>
          <nav aria-label="Main" className="grid grid-cols-2 gap-1 font-brand text-sm font-semibold text-gray-200">
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
