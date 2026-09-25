/**
 * The visible label for `creator.premium`. That flag is an admin toggle that
 * only raises a creator's content-slot cap (lib/media.js galleryLimitFor); it
 * says nothing about identity or age. It used to be drawn as a bare rosette
 * with a check ("Verified creator"), which on an adult platform reads as an
 * identity/age guarantee the platform does not make for this creator over
 * any other -- every active creator passes the same §2257 review. So it is a
 * plain text pill, never a verification-style seal.
 */
export default function PremiumBadge({ className = '' }) {
  return (
    <span
      title="Premium account (more content slots). Not an identity check -- every creator on OnlyOne goes through the same review."
      className={`inline-flex items-center text-[10px] tracking-wide px-2 py-0.5 rounded-full border border-brand-pink/60 text-brand-pink font-black align-middle ${className}`}
    >
      PREMIUM
    </span>
  );
}
