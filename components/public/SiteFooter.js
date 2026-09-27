import { Lockup } from '../Brand';

/**
 * The shared footer for the gated browse pages.
 *
 * These links are not decoration. The takedown form is required to be posted
 * conspicuously under the federal TAKE IT DOWN Act, and the rest are the legal
 * pages a payment processor asks for. Each points at the section that
 * actually covers it. Do not drop any of them in a redesign.
 *
 * `aiImagery` adds the "Model imagery is AI-generated." line, which every page
 * showing AI imagery (the house models, the hero art) must carry.
 * `origin` prefixes every link with an absolute site origin, for pages that
 * are also served at the root of a mirror domain (see pages/marketplace.js
 * MAIN_SITE), where a relative link would stay on the mirror.
 */
export const FOOTER_LINKS = [
  { href: '/terms', label: 'Terms of Service' },
  { href: '/privacy', label: 'Privacy Policy' },
  { href: '/privacy#cookies', label: 'Cookie Policy' },
  { href: '/2257', label: '18 U.S.C. §2257 Statement' },
  { href: '/terms#content-removal', label: 'DMCA / Takedown' },
  { href: '/terms#complaints', label: 'Complaints Policy' },
  { href: '/terms#prohibited', label: 'Acceptable Use' },
  { href: '/token', label: '$ONLYONE' },
];

export default function SiteFooter({ aiImagery = true, origin = '', extraLinks = [], note = null }) {
  const at = (href) => (href.startsWith('mailto:') || /^https?:/.test(href) ? href : `${origin}${href}`);
  return (
    <footer className="mt-16 border-t border-brand-pink/15 bg-black/40 py-10 px-4 sm:px-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-col items-center gap-6">
          <a href={at('/home')} aria-label="OnlyOne home" className="rounded-md">
            <Lockup className="h-7" />
          </a>
          <nav aria-label="Legal" className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs text-gray-400">
            {[...extraLinks, ...FOOTER_LINKS].map((l) => (
              <a key={l.href + l.label} href={at(l.href)} className="hover:text-brand-pink transition">
                {l.label}
              </a>
            ))}
            <a href={at('/report-content')} className="text-red-300 hover:text-red-200 transition font-semibold">
              Report Non-Consensual Content
            </a>
            <a href="mailto:team@onlyone1.fun" className="hover:text-brand-pink transition">Contact</a>
          </nav>
        </div>
        {aiImagery && (
          <p className="text-gray-300 text-xs text-center mt-6">Model imagery is AI-generated.</p>
        )}
        {note && <p className="text-gray-400 text-xs max-w-2xl mx-auto text-center mt-2">{note}</p>}
        <p className="text-gray-400 text-xs max-w-2xl mx-auto mt-2 text-center">
          18+ only. This site contains adult content. $ONLYONE is a meme token for entertainment purposes —
          not an investment, and not financial advice.
        </p>
        <p className="tagline-caps text-gray-500 text-[10px] text-center mt-4">© 2026 OnlyOne</p>
      </div>
    </footer>
  );
}
