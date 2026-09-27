/**
 * The category strip from the owner's mockup (147337ea):
 *   MEN | WOMEN | COUPLES | TRANS | NON-BINARY | ALL CREATORS
 *
 * Every entry links to a real, existing filter -- `?category=` on /creators
 * (or on the page passed as `basePath`, e.g. /marketplace), read by
 * lib/categories.js. "ALL CREATORS" clears the filter. The keys below MUST
 * stay keys of lib/categories.js CATEGORIES; anything else would be a link
 * to a filter that silently shows everything.
 *
 * When the page filters client-side (/creators and /marketplace do, with a
 * shallow URL update), pass `onSelect` and a plain click is handed to it
 * instead of reloading; the href still works for a new tab or no-JS.
 */
const ITEMS = [
  { key: 'men', label: 'Men' },
  { key: 'women', label: 'Women' },
  { key: 'couples', label: 'Couples' },
  { key: 'trans', label: 'Trans' },
  { key: 'nonbinary', label: 'Non-binary' },
  { key: null, label: 'All creators' },
];

function hrefFor(basePath, key) {
  return key ? `${basePath}?category=${encodeURIComponent(key)}` : basePath;
}

export default function CategoryBar({ basePath = '/creators', active = null, onSelect = null, className = '' }) {
  return (
    <nav aria-label="Browse by category" className={`border-y border-brand-pink/15 bg-black/60 ${className}`}>
      <ul className="max-w-6xl mx-auto px-2 sm:px-6 flex items-center justify-start sm:justify-center overflow-x-auto whitespace-nowrap">
        {ITEMS.map((it, i) => {
          const on = (active || null) === it.key;
          return (
            <li key={it.key || 'all'} className="flex items-center">
              {i > 0 && <span aria-hidden="true" className="h-3.5 w-px bg-brand-pink/60" />}
              <a
                href={hrefFor(basePath, it.key)}
                aria-current={on ? 'true' : undefined}
                onClick={(e) => {
                  if (!onSelect || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  onSelect(it.key);
                }}
                className={`tagline-caps block px-3 sm:px-5 py-3.5 text-[11px] sm:text-xs transition ${
                  on ? 'text-brand-pink font-bold' : 'text-gray-200 hover:text-brand-pink'
                }`}
              >
                {it.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
