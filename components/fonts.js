import { Montserrat, Pacifico } from 'next/font/google';

/**
 * The two brand typefaces from the owner's mockups (2026-09-27 restyle):
 *
 *  - Montserrat 600-900: the big, bold geometric headlines ("MORE THAN
 *    CONTENT.") and the wide letter-spaced small-caps taglines.
 *  - Pacifico: the neon script accent ("You're Not Alone Here"). Used for
 *    one short line at a time, never for body copy or buttons.
 *
 * Loaded through next/font, so the files are downloaded at build time and
 * served from this site's own origin -- no request to Google from a
 * visitor's browser for these two (the older faces in pages/_document.js
 * still load from Google Fonts, which the Privacy Policy already discloses).
 *
 * next/font scopes a font to a generated class name. To make the faces
 * usable from plain Tailwind classes on any page without editing _app.js,
 * <BrandFonts/> publishes each generated family as a :root custom property
 * (--oo-font-display / --oo-font-script) that tailwind.config.js and
 * styles/globals.css read, with sensible fallbacks when a page does not
 * render it. It is rendered by the logo components (components/Brand.js)
 * and SiteNav, so every page that shows the brand gets the faces.
 */
export const displayFont = Montserrat({
  subsets: ['latin'],
  weight: ['500', '600', '700', '800', '900'],
  display: 'swap',
  fallback: ['Arial', 'Helvetica', 'sans-serif'],
});

export const scriptFont = Pacifico({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
  fallback: ['cursive'],
});

const ROOT_VARS = `:root{--oo-font-display:${displayFont.style.fontFamily};--oo-font-script:${scriptFont.style.fontFamily};}`;

export function BrandFonts() {
  // A plain inline <style>: the value is a build-time constant, identical on
  // the server and the client, so nothing hydrates differently. Rendered by
  // more than one component on a page, it simply repeats the same few bytes.
  return <style dangerouslySetInnerHTML={{ __html: ROOT_VARS }} />;
}
