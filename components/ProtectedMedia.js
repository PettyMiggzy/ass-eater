import { useMemo } from 'react';

/**
 * Creator content, with the casual ways of taking it closed off and a
 * per-viewer mark on top.
 *
 * BE STRAIGHT ABOUT WHAT THIS DOES, because a creator will ask and the wrong
 * answer is a promise the platform cannot keep:
 *
 *  - It DOES stop right-click-and-save, drag-to-desktop, and the iOS/Android
 *    long-press "Save Image" menu. That is most casual copying, and it is
 *    worth closing.
 *  - It CANNOT stop a screenshot. Not "not yet" -- there is no web API for
 *    it and there cannot be one: to show an image the browser has to put
 *    pixels in the operating system's frame buffer, and the screenshot tool
 *    reads that buffer. A web page has no authority over the OS. (Native
 *    apps get FLAG_SECURE on Android; websites get nothing. Encrypted-media
 *    DRM can blank capture for *video* in some browsers, at the cost of a
 *    licence server and packaging, and does nothing for images.)
 *  - And nothing stops a second phone pointed at the screen. Nothing ever
 *    will.
 *
 * So the mark is the point, not the blocking. A screenshot carries a code
 * tied to the account that took it (lib/viewer-mark.js), which turns "who
 * leaked this" from unanswerable into a lookup -- and a viewer who can see
 * their own mark sitting on the picture mostly does not take it.
 *
 * KNOWN LIMIT, deliberately not oversold: this overlay is drawn in the page,
 * so someone who opens devtools can delete it before screenshotting, and the
 * file itself is unmarked. The version that survives that burns the mark
 * into the bytes server-side, per request, before the image is ever sent.
 * server/src/lib/watermark.ts is that, and it is not wired to this site yet.
 */
export default function ProtectedMedia({
  src,
  type = 'image',
  alt = '',
  className = '',
  mark = '',
  children,
}) {
  const block = (e) => e.preventDefault();

  // Enough tiles to cover a tall portrait image without measuring anything.
  const tiles = useMemo(() => Array.from({ length: 12 }), []);

  return (
    <div className="relative w-full h-full select-none" onContextMenu={block}>
      {type === 'video' ? (
        <video
          src={src}
          muted
          loop
          playsInline
          disablePictureInPicture
          controlsList="nodownload noplaybackrate"
          onContextMenu={block}
          onDragStart={block}
          className={className}
        />
      ) : (
        <img
          src={src}
          alt={alt}
          draggable={false}
          onContextMenu={block}
          onDragStart={block}
          // -webkit-touch-callout is what actually suppresses the iOS
          // long-press "Save Image" sheet; onContextMenu alone does not.
          style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none' }}
          className={className}
        />
      )}

      {mark && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden flex flex-col justify-around opacity-[0.13]"
        >
          {tiles.map((_, i) => (
            <p
              key={i}
              className="whitespace-nowrap text-center text-[10px] font-mono tracking-[0.2em] text-white -rotate-[24deg]"
              style={{ textShadow: '0 0 3px rgba(0,0,0,0.9)' }}
            >
              {`ONLYONE ${mark}  `.repeat(6)}
            </p>
          ))}
        </div>
      )}

      {children}
    </div>
  );
}
