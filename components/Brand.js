/**
 * The brand marks and the line icons from the OnlyOne designs.
 *
 * `Lockup` is the founder's real brand art, shipped as a transparent PNG
 * (see its own note below). Everything else here -- `Mark`, `Icons`, the
 * badges -- stays inline SVG, because at UI-chrome sizes drawn vector is
 * sharper than any raster, recolours from `currentColor` instead of needing
 * a re-export every time the pink changes, weighs almost nothing, and cannot
 * fail to load on the age-gate pages that must never render broken.
 */

/**
 * The "01" mark: a thick pink ring with a padlock sitting in its centre, and a
 * ribbon-folded 1 beside it. Matches the reference artwork the founder set the
 * brand from.
 *
 * `lockFill` is the colour showing THROUGH the padlock's cut-out, so it has to
 * match whatever sits behind the mark -- the padlock is punched out of the
 * disc rather than drawn on top of it, which is what keeps it crisp at 32px
 * instead of turning into a grey smudge. Defaults to the app's ink background.
 */
export function Mark({ className = 'h-16 w-auto', lockFill = '#120a10' }) {
  return (
    <svg viewBox="0 0 150 80" className={className} role="img" aria-label="OnlyOne">
      <defs>
        {/* Punches the padlock silhouette out of the inner disc so the page
            background reads through it, exactly like the reference. */}
        <mask id="oo-lock-mask">
          <rect x="0" y="0" width="150" height="80" fill="black" />
          <circle cx="40" cy="40" r="19" fill="white" />
          <g fill="black">
            <rect x="31.5" y="39" width="17" height="13.5" rx="3" />
            <path d="M34.5 39v-4.5a5.5 5.5 0 0 1 11 0V39" fill="none" stroke="black" strokeWidth="3.6" strokeLinecap="round" />
          </g>
        </mask>
      </defs>

      {/* The "0" -- thick outer ring. */}
      <circle cx="40" cy="40" r="31" fill="none" stroke="currentColor" strokeWidth="15" />
      {/* Inner disc with the padlock knocked out of it. */}
      <circle cx="40" cy="40" r="19" fill={lockFill} mask="url(#oo-lock-mask)" />
      <circle cx="40" cy="40" r="19" fill="currentColor" mask="url(#oo-lock-mask)" />

      {/* The "1", with the ribbon fold across its top like the reference. */}
      <g fill="currentColor">
        <path d="M96 71V23h15v48z" />
        <path d="M96 23L79 33l7 12 25-15z" opacity="0.72" />
      </g>
    </svg>
  );
}

/**
 * The full horizontal lockup -- the founder's real brand art (supplied
 * 2026-09-20), not the drawn approximation of it that `Mark` still is.
 *
 * Transparent PNG, extracted from art on a black background by treating the
 * composite as additive: alpha is the brightest channel and the colour is
 * the pixel un-premultiplied by it. That is exact at every edge pixel, so it
 * leaves no dark halo on any background. Keying black to transparent -- how
 * the old badge art was cut -- keeps the darkened edge pixels and fringes
 * the mark everywhere except the colour it was cut on. Use this method for
 * any future art supplied on black.
 *
 * It is listed in proxy.js's BRAND_ART_PATHS, because this renders on the
 * age-gate pages and /2257, all of which are exempt from the age check --
 * without that it would be the one broken image on the pages a blocked
 * visitor, a regulator or a payment processor actually reads.
 */
export function Lockup({ className = 'h-12 w-auto' }) {
  return (
    <img
      src="/images/onlyone-lockup-nav.png"
      alt="OnlyOne"
      width={438}
      height={72}
      className={`w-auto ${className}`}
    />
  );
}

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

function Svg({ children, className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      {children}
    </svg>
  );
}

export const Icons = {
  video: (p) => (
    <Svg {...p}>
      <rect x="2.5" y="6.5" width="13" height="11" rx="2.5" {...STROKE} />
      <path d="M15.5 11l6-3.5v9l-6-3.5z" {...STROKE} />
    </Svg>
  ),
  message: (p) => (
    <Svg {...p}>
      <path d="M21 11.5a8 8 0 0 1-8 8H7l-4 2.5 1.2-3.6A8 8 0 1 1 21 11.5z" {...STROKE} />
    </Svg>
  ),
  lock: (p) => (
    <Svg {...p}>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" {...STROKE} />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" {...STROKE} />
    </Svg>
  ),
  heart: (p) => (
    <Svg {...p}>
      <path d="M12 20.5s-7.5-4.6-7.5-9.6A4.4 4.4 0 0 1 12 8a4.4 4.4 0 0 1 7.5 2.9c0 5-7.5 9.6-7.5 9.6z" {...STROKE} />
    </Svg>
  ),
  people: (p) => (
    <Svg {...p}>
      <circle cx="9" cy="8.5" r="3.2" {...STROKE} />
      <path d="M3 19.5c0-3 2.7-5 6-5s6 2 6 5" {...STROKE} />
      <path d="M16 6.2a3.2 3.2 0 0 1 0 6" {...STROKE} />
      <path d="M17.5 14.9c2.1.5 3.5 2.1 3.5 4.6" {...STROKE} />
    </Svg>
  ),
  star: (p) => (
    <Svg {...p}>
      <path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.7L12 16.8 6.9 19.5l1-5.7-4.1-4 5.7-.8z" {...STROKE} />
    </Svg>
  ),
};

/**
 * Founding Creator badge -- a laurel wreath around a numeral one.
 *
 * Drawn, not generated. The raster versions this replaces were made by
 * keying a black background out of a generated image, and that left a dark
 * fringe around every leaf which was plainly visible against the site's dark
 * cards. Vector has no halo to leave, stays sharp from the 16px chip on a
 * creator profile up to the hero on the recruitment page, takes its colour
 * from the surrounding text, and weighs a fraction of six PNGs.
 *
 * The leaves are placed by transform rather than drawn one at a time:
 * rotate(theta) turns the coordinate system, translate(0 -34) walks out to
 * the wreath's radius along it, and the second rotate tilts the leaf about
 * its own centre. Both sides come from the same numbers, so they match
 * exactly. The wreath is deliberately open at the top.
 */
export function FoundingBadge({ className = 'h-6 w-auto' }) {
  return (
    <svg viewBox="-50 -50 100 100" className={className} role="img" aria-label="Founding Creator">
      <g>
        <ellipse key="0--1" cx="0" cy="0" rx="4.4" ry="9.6" fill="currentColor" transform="rotate(-30.0) translate(0 -34) rotate(28)" />
        <ellipse key="0-1" cx="0" cy="0" rx="4.4" ry="9.6" fill="currentColor" transform="rotate(30.0) translate(0 -34) rotate(-28)" />
        <ellipse key="1--1" cx="0" cy="0" rx="4.4" ry="9.6" fill="currentColor" transform="rotate(-48.57) translate(0 -34) rotate(28)" />
        <ellipse key="1-1" cx="0" cy="0" rx="4.4" ry="9.6" fill="currentColor" transform="rotate(48.57) translate(0 -34) rotate(-28)" />
        <ellipse key="2--1" cx="0" cy="0" rx="4.4" ry="9.6" fill="currentColor" transform="rotate(-67.14) translate(0 -34) rotate(28)" />
        <ellipse key="2-1" cx="0" cy="0" rx="4.4" ry="9.6" fill="currentColor" transform="rotate(67.14) translate(0 -34) rotate(-28)" />
        <ellipse key="3--1" cx="0" cy="0" rx="4.4" ry="9.6" fill="currentColor" transform="rotate(-85.71) translate(0 -34) rotate(28)" />
        <ellipse key="3-1" cx="0" cy="0" rx="4.4" ry="9.6" fill="currentColor" transform="rotate(85.71) translate(0 -34) rotate(-28)" />
        <ellipse key="4--1" cx="0" cy="0" rx="4.4" ry="9.6" fill="currentColor" transform="rotate(-104.29) translate(0 -34) rotate(28)" />
        <ellipse key="4-1" cx="0" cy="0" rx="4.4" ry="9.6" fill="currentColor" transform="rotate(104.29) translate(0 -34) rotate(-28)" />
        <ellipse key="5--1" cx="0" cy="0" rx="4.4" ry="9.6" fill="currentColor" transform="rotate(-122.86) translate(0 -34) rotate(28)" />
        <ellipse key="5-1" cx="0" cy="0" rx="4.4" ry="9.6" fill="currentColor" transform="rotate(122.86) translate(0 -34) rotate(-28)" />
        <ellipse key="6--1" cx="0" cy="0" rx="4.4" ry="9.6" fill="currentColor" transform="rotate(-141.43) translate(0 -34) rotate(28)" />
        <ellipse key="6-1" cx="0" cy="0" rx="4.4" ry="9.6" fill="currentColor" transform="rotate(141.43) translate(0 -34) rotate(-28)" />
        <ellipse key="7--1" cx="0" cy="0" rx="4.4" ry="9.6" fill="currentColor" transform="rotate(-160.0) translate(0 -34) rotate(28)" />
        <ellipse key="7-1" cx="0" cy="0" rx="4.4" ry="9.6" fill="currentColor" transform="rotate(160.0) translate(0 -34) rotate(-28)" />
      </g>
      {/* The numeral is a path, not text, so it renders identically
          everywhere instead of depending on the viewer's fonts. */}
      <path d="M-5 -24 L9 -24 L9 26 L-1 26 L-1 -15 L-10 -11 L-12.5 -19 Z" fill="currentColor" />
    </svg>
  );
}

/** VIP badge -- a solid crown in a ring. Same reasoning as above. */
export function VipBadge({ className = 'h-6 w-auto' }) {
  return (
    <svg viewBox="-50 -50 100 100" className={className} role="img" aria-label="VIP">
      <circle cx="0" cy="0" r="42" fill="none" stroke="currentColor" strokeWidth="8" />
      <path d="M-26 10 L-30 -20 L-15 -8 L0 -26 L15 -8 L30 -20 L26 10 Z" fill="currentColor" strokeLinejoin="round" />
      <rect x="-26" y="14" width="52" height="8" rx="2.5" fill="currentColor" />
    </svg>
  );
}
