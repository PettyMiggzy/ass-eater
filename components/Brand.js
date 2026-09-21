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
 * The one script-font accent on the site, for a cover photo or a hero
 * banner -- a creator's profile cover, the marketplace hero. Renders one of
 * the platform's own established taglines (see TAGLINES below), never
 * invented copy and never anything creator-specific, so it can sit on any
 * cover photo without implying a claim about that particular creator.
 *
 * Deliberately a small, fixed set rather than one fixed string: the same
 * exact line on every cover photo across the site reads as a template
 * stamp. `pick(seed)` is a stable, non-random choice (Math.random() would
 * make a server-rendered page mismatch the client on hydration) so the same
 * creator always gets the same line rather than one that changes on every
 * request.
 */
const TAGLINES = ["You're Not Alone Here", 'Real People. Real Connections.'];

export function pickTagline(seed) {
  const key = String(seed ?? '');
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return TAGLINES[Math.abs(hash) % TAGLINES.length];
}

export function Tagline({ children, className = '' }) {
  return (
    <p
      className={`font-["Dancing_Script"] text-3xl sm:text-4xl leading-none text-white drop-shadow-[0_2px_12px_rgba(0,0,0,0.6)] ${className}`}
    >
      {children}
      <SolidIcons.heart className="inline-block h-[0.6em] w-[0.6em] ml-2 -translate-y-0.5 text-brand-pink" />
    </p>
  );
}

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

/**
 * The icon set.
 *
 * Every one of these replaced an emoji or a stock PNG. Emoji are the wrong
 * tool for product chrome on any site and especially this one: each platform
 * draws them differently, so the same screen is a flat glyph on Windows, a
 * glossy 3D blob on Android and Apple's own artwork on a Mac -- a brand can
 * be pink and precise everywhere except the six characters it did not draw.
 * They also carry no colour of their own that can be themed, sit on their
 * own baseline, and read as a chat message rather than a product.
 *
 * So: one 24x24 grid, one stroke weight, round caps, `currentColor`
 * throughout. They inherit text colour, scale to any size without a
 * re-export, and cost a few hundred bytes each against a PNG round-trip.
 *
 * SOLID variants exist only where a filled state means something -- a
 * favourited heart against an unfavourited one. Everything else is line
 * work, because mixing weights is what makes an icon set look assembled
 * rather than drawn.
 */
export const Icons = {
  bell: (p) => (
    <Svg {...p}>
      <path d="M6 9a6 6 0 0 1 12 0c0 4 1.5 5.5 2 6.5H4c.5-1 2-2.5 2-6.5z" {...STROKE} />
      <path d="M10 19a2 2 0 0 0 4 0" {...STROKE} />
    </Svg>
  ),
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
  check: (p) => (
    <Svg {...p}>
      <path d="M4.5 12.5l4.8 4.8L19.5 7" {...STROKE} />
    </Svg>
  ),
  close: (p) => (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6L6 18" {...STROKE} />
    </Svg>
  ),
  arrowRight: (p) => (
    <Svg {...p}>
      <path d="M4 12h15m0 0l-5.5-5.5M19 12l-5.5 5.5" {...STROKE} />
    </Svg>
  ),
  arrowLeft: (p) => (
    <Svg {...p}>
      <path d="M20 12H5m0 0l5.5-5.5M5 12l5.5 5.5" {...STROKE} />
    </Svg>
  ),
  pin: (p) => (
    <Svg {...p}>
      <path d="M12 21.5s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11z" {...STROKE} />
      <circle cx="12" cy="10.2" r="2.6" {...STROKE} />
    </Svg>
  ),
  cake: (p) => (
    <Svg {...p}>
      <path d="M3.5 20.5h17v-5a2.5 2.5 0 0 0-2.5-2.5H6a2.5 2.5 0 0 0-2.5 2.5z" {...STROKE} />
      <path d="M3.5 16.8c1.4 0 1.4 1.4 2.8 1.4s1.4-1.4 2.8-1.4 1.4 1.4 2.9 1.4 1.4-1.4 2.8-1.4 1.4 1.4 2.8 1.4 1.4-1.4 2.9-1.4" {...STROKE} />
      <path d="M8.5 13V9.8M12 13V9.2M15.5 13V9.8" {...STROKE} />
      <path d="M8.5 7.4c0-1 1-1.4 1-2.4M12 6.8c0-1 1-1.4 1-2.4M15.5 7.4c0-1 1-1.4 1-2.4" {...STROKE} />
    </Svg>
  ),
  tag: (p) => (
    <Svg {...p}>
      <path d="M11 3.5H4.5a1 1 0 0 0-1 1V11a2 2 0 0 0 .6 1.4l7.5 7.5a2 2 0 0 0 2.8 0l6-6a2 2 0 0 0 0-2.8l-7.5-7.5A2 2 0 0 0 11 3.5z" {...STROKE} />
      <circle cx="8" cy="8" r="1.6" {...STROKE} />
    </Svg>
  ),
  link: (p) => (
    <Svg {...p}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3.3-3.3a4 4 0 0 0-5.7-5.7L11.6 6.7" {...STROKE} />
      <path d="M14 10a4 4 0 0 0-5.7 0L5 13.3a4 4 0 0 0 5.7 5.7l1.6-1.7" {...STROKE} />
    </Svg>
  ),
  flag: (p) => (
    <Svg {...p}>
      <path d="M6 21.5V3.5" {...STROKE} />
      <path d="M6 4.6h10.8c.7 0 1.1.8.6 1.3l-2.3 2.6a1 1 0 0 0 0 1.3l2.3 2.6c.5.6.1 1.4-.6 1.4H6" {...STROKE} />
    </Svg>
  ),
  shield: (p) => (
    <Svg {...p}>
      <path d="M12 2.8l7.5 2.8v6c0 4.5-3.1 8.4-7.5 9.6-4.4-1.2-7.5-5.1-7.5-9.6v-6z" {...STROKE} />
      <path d="M9 12l2.2 2.2L15.5 10" {...STROKE} />
    </Svg>
  ),
  bolt: (p) => (
    <Svg {...p}>
      <path d="M13.2 2.5L5 13.2h5.3l-.7 8.3L18.5 10h-5.3z" {...STROKE} />
    </Svg>
  ),
  camera: (p) => (
    <Svg {...p}>
      <path d="M3.5 8.5h3l1.6-2.4h7.8L17.5 8.5h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" {...STROKE} />
      <circle cx="12" cy="13.6" r="3.6" {...STROKE} />
    </Svg>
  ),
  film: (p) => (
    <Svg {...p}>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" {...STROKE} />
      <path d="M2.5 9.2h19M2.5 14.8h19M7.8 4.5v15M16.2 4.5v15" {...STROKE} />
    </Svg>
  ),
  memo: (p) => (
    <Svg {...p}>
      <path d="M19.5 11.5v8a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1h8" {...STROKE} />
      <path d="M14.8 12.6l-3.4.8.8-3.4 6.4-6.4a1.8 1.8 0 0 1 2.6 2.6z" {...STROKE} />
    </Svg>
  ),
  hand: (p) => (
    <Svg {...p}>
      <path d="M9 11.5V5.2a1.6 1.6 0 1 1 3.2 0v5.6" {...STROKE} />
      <path d="M12.2 10.8V4.4a1.6 1.6 0 1 1 3.2 0v6.4" {...STROKE} />
      <path d="M15.4 11.2V6.6a1.6 1.6 0 1 1 3.2 0v7.6a7 7 0 0 1-7 7 6 6 0 0 1-4.6-2.2L4 15.1a1.7 1.7 0 0 1 2.4-2.4L9 15" {...STROKE} />
    </Svg>
  ),
  fire: (p) => (
    <Svg {...p}>
      <path d="M12 2.8s.9 3-1.4 5.3C8 10.6 6 12.4 6 15.2a6 6 0 0 0 12 0c0-2.6-1.4-4.4-2.6-6.2-.5 1.1-1.3 1.8-2.2 2 .6-2.6-.3-6-1.2-8.2z" {...STROKE} />
    </Svg>
  ),
  trending: (p) => (
    <Svg {...p}>
      <path d="M3.5 16.5l5-5.2 3.4 3.4 5.2-5.4" {...STROKE} />
      <path d="M13.8 9.3h3.8v3.8" {...STROKE} />
    </Svg>
  ),
  crown: (p) => (
    <Svg {...p}>
      <path d="M3.5 7.5l3.8 3.2L12 4.5l4.7 6.2 3.8-3.2-1.6 11.2a1 1 0 0 1-1 .8H6.1a1 1 0 0 1-1-.8z" {...STROKE} />
    </Svg>
  ),
  spark: (p) => (
    <Svg {...p}>
      <path d="M12 3.2l1.9 5.2 5.2 1.9-5.2 1.9-1.9 5.2-1.9-5.2L4.9 10.3l5.2-1.9z" {...STROKE} />
      <path d="M18.6 16.4l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z" {...STROKE} />
    </Svg>
  ),
  wallet: (p) => (
    <Svg {...p}>
      <path d="M3.5 7.8a2 2 0 0 1 2-2h11.2a1 1 0 0 1 0 2" {...STROKE} />
      <rect x="3.5" y="7.8" width="17" height="11.7" rx="2.5" {...STROKE} />
      <circle cx="16.4" cy="13.6" r="1.4" {...STROKE} />
    </Svg>
  ),
  cart: (p) => (
    <Svg {...p}>
      <path d="M3.5 4.5h2.1l1 2M6.6 6.5l1.7 8.4a1.5 1.5 0 0 0 1.5 1.2h7.1a1.5 1.5 0 0 0 1.5-1.2l1.2-6.4H6.6z" {...STROKE} />
      <circle cx="10" cy="19.2" r="1.2" {...STROKE} />
      <circle cx="16.4" cy="19.2" r="1.2" {...STROKE} />
    </Svg>
  ),
  coin: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8.8" {...STROKE} />
      <path d="M14.6 9.1a3 3 0 0 0-2.6-1.3c-1.5 0-2.6.9-2.6 2.1 0 2.9 5.3 1.5 5.3 4.3 0 1.2-1.2 2.1-2.7 2.1a3 3 0 0 1-2.6-1.3" {...STROKE} />
      <path d="M12 6.1v1.7M12 16.2v1.7" {...STROKE} />
    </Svg>
  ),
  warning: (p) => (
    <Svg {...p}>
      <path d="M12 3.6l9 15.6H3z" {...STROKE} />
      <path d="M12 9.6v4.2" {...STROKE} />
      <circle cx="12" cy="16.6" r="0.9" fill="currentColor" stroke="none" />
    </Svg>
  ),
};

/**
 * Filled variants. These exist only where the fill itself carries state --
 * a saved creator against an unsaved one, a badge that has to read at 14px.
 * Keeping the rest line-only is what stops the set looking assembled from
 * two different families.
 */
export const SolidIcons = {
  heart: (p) => (
    <Svg {...p}>
      <path d="M12 20.9S3.8 15.8 3.8 10.3A4.9 4.9 0 0 1 12 7a4.9 4.9 0 0 1 8.2 3.3c0 5.5-8.2 10.6-8.2 10.6z" fill="currentColor" />
    </Svg>
  ),
  star: (p) => (
    <Svg {...p}>
      <path d="M12 2.9l2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.3l-5.6 3 1.1-6.3-4.6-4.4 6.3-.9z" fill="currentColor" />
    </Svg>
  ),
  fire: (p) => (
    <Svg {...p}>
      <path d="M12 2.2s1.2 3.4-1.3 6C8.1 10.8 6 12.6 6 15.4a6 6 0 0 0 12 0c0-2.7-1.5-4.6-2.8-6.5-.5 1.2-1.3 1.9-2.3 2.2.7-2.8-.1-6.4-.9-8.9z" fill="currentColor" />
    </Svg>
  ),
  lock: (p) => (
    <Svg {...p}>
      <path d="M8 10V7a4 4 0 0 1 8 0v3" {...STROKE} />
      <rect x="4.4" y="10" width="15.2" height="10.4" rx="2.6" fill="currentColor" />
    </Svg>
  ),
  // The verified/premium seal, replacing a generic check PNG that was doing
  // this job at eight call sites. A scalloped rosette reads as a badge at
  // 14px where a bare tick reads as a to-do item -- and it is drawn from one
  // rotated point so every lobe matches exactly.
  verified: (p) => (
    <Svg {...p}>
      <path
        d="M12 1.9l2.5 1.9 3.1-.3 1 3 2.7 1.6-1 3 1 3-2.7 1.6-1 3-3.1-.3L12 22.1l-2.5-1.9-3.1.3-1-3-2.7-1.6 1-3-1-3 2.7-1.6 1-3 3.1.3z"
        fill="currentColor"
      />
      <path d="M8.2 12.2l2.6 2.6 5-5.2" fill="none" stroke="#0b0b0e" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
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
