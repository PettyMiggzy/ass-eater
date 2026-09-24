import { SolidIcons } from '../Brand';

/**
 * What a non-buyer sees of a marketplace listing's media: the creator's tiny,
 * pre-blurred preview (a data: URL generated in their browser at upload time,
 * validated by isValidListingPreview) or a plain placeholder. It never takes
 * a src -- public listing payloads (toPublicListing) no longer carry one, and
 * the real files are served only to buyers through /api/marketplace/orders/delivery.
 *
 * The preview is always a still image, even for a video listing (it is drawn
 * from a frame), so there is no <video> branch to get wrong.
 */
export default function ListingPreview({ media, className = '', showLock = true }) {
  const first = Array.isArray(media) ? media[0] : null;
  return (
    <div className={`relative w-full h-full bg-black/40 overflow-hidden ${className}`}>
      {first?.preview ? (
        <img src={first.preview} alt="" className="w-full h-full object-cover blur-md scale-110" />
      ) : (
        <div className="w-full h-full bg-gradient-to-br from-brand-pink/25 via-white/5 to-black/40" />
      )}
      {showLock && (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="w-10 h-10 rounded-full bg-black/60 border border-white/15 flex items-center justify-center text-white">
            <SolidIcons.lock className="h-4 w-4" />
          </span>
        </span>
      )}
      {first?.type === 'video' && (
        <span className="absolute bottom-2 right-2 text-[10px] px-1.5 py-0.5 rounded bg-black/70 text-white font-semibold">VIDEO</span>
      )}
    </div>
  );
}
