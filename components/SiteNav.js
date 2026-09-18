import { useState } from 'react';
import { useRouter } from 'next/router';

/**
 * The top bar from the OnlyOne designs: brand, section links, creator
 * search, saved-creators shortcut, and either the signed-in person's
 * avatar or log in / sign up.
 *
 * BRAND_NAME is a single constant on purpose. The designs use "ONLYONE"
 * while the live site is still Only Ass (MEMORY.md records that a rename
 * was declined, and the OnlyOne domain is a second front door rather than
 * a replacement), so switching the wordmark is a one-line change here
 * rather than a find-and-replace across the site.
 */
const BRAND_NAME = 'ONLYONE';

export default function SiteNav({ signedIn = false, viewerAvatar = null, viewerHref = '/dashboard' }) {
  const router = useRouter();
  const [q, setQ] = useState('');

  const submit = (e) => {
    e.preventDefault();
    const term = q.trim();
    if (term) router.push(`/search?q=${encodeURIComponent(term)}`);
  };

  return (
    <header className="sticky top-0 z-50 bg-brand-ink/95 backdrop-blur border-b border-white/5">
      <div className="max-w-6xl mx-auto px-4 md:px-6 h-16 flex items-center gap-4">
        <a href="/home" className="flex items-center gap-2 shrink-0">
          <img src="/images/logo-final.png" alt="" className="h-8 w-8 object-contain" />
          <span className="font-black tracking-tight text-lg hidden sm:inline">
            {BRAND_NAME.slice(0, 4)}<span className="text-brand-pink">{BRAND_NAME.slice(4)}</span>
          </span>
        </a>

        <nav className="hidden md:flex items-center gap-6 text-sm text-gray-300">
          <a href="/home" className="hover:text-white transition">Home</a>
          <a href="/search" className="hover:text-white transition">Explore</a>
          <a href="/onlyass" className="hover:text-white transition">Creators</a>
          <a href="/marketplace" className="hover:text-white transition">Marketplace</a>
        </nav>

        <form onSubmit={submit} className="flex-1 max-w-sm ml-auto hidden sm:block">
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
        </form>

        <a href="/favorites" title="Saved creators"
           className="shrink-0 w-9 h-9 rounded-full border border-white/10 flex items-center justify-center text-gray-300 hover:text-brand-pink hover:border-brand-pink/50 transition">
          ♥
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
            <a href="/signup" className="text-sm px-4 py-1.5 rounded-full bg-brand-pink text-white font-semibold hover:bg-brand-pink-dark transition">
              Sign up
            </a>
          </div>
        )}
      </div>
    </header>
  );
}
