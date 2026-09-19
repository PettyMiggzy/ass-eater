/**
 * The 01 lockup and the line icons from the OnlyOne designs, drawn as inline
 * SVG rather than shipped as image files.
 *
 * Inline because they have to sit on the public landing page, which is the
 * one page outside the age gate and should stay fast and dependency-free,
 * and because a wordmark that scales and recolours with CSS beats a PNG that
 * has to be re-exported every time the pink changes. It also avoids reusing
 * the old Only Ass logo asset here, which reads as a different product next
 * to the ONLYONE wordmark -- the site is fully OnlyOne-branded as of
 * 2026-09-19.
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
 * Mark + ONLYONE wordmark, the full horizontal lockup. Used anywhere the old
 * `/images/logo-final.png` used to sit -- that file still had the previous
 * brand name baked into its pixels, so it survived the text rename sweep and
 * kept saying the old name on the age-gate pages for days.
 */
export function Lockup({ className = 'h-12 w-auto' }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <Mark className="h-full w-auto text-brand-pink" />
      <span className="font-black tracking-tight leading-none text-[1.55em]">
        ONLY<span className="text-brand-pink">ONE</span>
      </span>
    </span>
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
