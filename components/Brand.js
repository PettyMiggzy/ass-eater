/**
 * The 01 lockup and the line icons from the OnlyOne designs, drawn as inline
 * SVG rather than shipped as image files.
 *
 * Inline because they have to sit on the public landing page, which is the
 * one page outside the age gate and should stay fast and dependency-free,
 * and because a wordmark that scales and recolours with CSS beats a PNG that
 * has to be re-exported every time the pink changes. It also avoids reusing
 * the old OnlyAss logo asset here, which reads as a different product next
 * to the ONLYONE wordmark.
 */

export function Mark({ className = 'h-16 w-auto' }) {
  return (
    <svg viewBox="0 0 132 72" className={className} role="img" aria-label="OnlyOne">
      {/* The "0" is a ring with a padlock sitting inside it. */}
      <circle cx="36" cy="36" r="30" fill="none" stroke="currentColor" strokeWidth="11" />
      <g fill="currentColor">
        <rect x="26" y="34" width="20" height="16" rx="3.5" />
        <path
          d="M30 34v-5a6 6 0 0 1 12 0v5"
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
        />
      </g>
      {/* The "1". */}
      <path
        d="M88 66V16l-12 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="11"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
