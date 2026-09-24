import { useEffect } from 'react';
import ProtectedMedia from '../ProtectedMedia';
import { Icons } from '../Brand';

/**
 * Full-size viewer for one gallery item: the whole photo (object-contain,
 * never a square crop) or the video with real controls. Gallery tiles are
 * previews -- a video tile had no controls and no click handler, so a
 * creator's uploaded video could not be watched anywhere on the site.
 *
 * Everything ProtectedMedia does still applies here: no right-click / drag /
 * long-press save, `nodownload`, no picture-in-picture, and the same
 * per-viewer mark over the media. Callers must never open this for a locked
 * item -- a locked item has no src to show (toPublicCreator strips it).
 */
export default function MediaLightbox({ item, mark = '', onClose }) {
  useEffect(() => {
    if (!item) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [item, onClose]);

  if (!item || !item.src) return null;
  const isVideo = item.type === 'video';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isVideo ? 'Video viewer' : 'Photo viewer'}
      className="fixed inset-0 z-[400] bg-black/90 backdrop-blur-sm flex items-center justify-center p-3 sm:p-8"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        aria-label="Close"
        className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white z-10"
      >
        <Icons.close className="h-5 w-5" />
      </button>
      <div className="relative max-w-5xl w-full h-full flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
        <div className="relative max-w-full max-h-full">
          <ProtectedMedia
            src={item.src}
            type={isVideo ? 'video' : 'image'}
            mark={mark}
            controls={isVideo}
            autoPlay={isVideo}
            className="block max-w-full max-h-[85vh] w-auto h-auto object-contain mx-auto"
          />
          {item.aiGenerated && (
            <span className="absolute top-2 left-2 text-[10px] px-1.5 py-0.5 rounded bg-black/70 text-brand-pink font-bold">AI</span>
          )}
        </div>
      </div>
    </div>
  );
}
