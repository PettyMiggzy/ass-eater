import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import sharp from 'sharp';

// Pure-ish steps of the transcode worker, kept out of transcode.ts so they can
// be tested without starting a BullMQ worker.

const run = promisify(execFile);

/** Does the source have an audio stream? Silent clips (muted teasers, screen recordings, GIF-derived MP4s) do not. */
export async function hasAudio(src: string): Promise<boolean> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', src]);
  return stdout.trim().length > 0;
}

/**
 * The HLS ladder's ffmpeg arguments. Exported for the unit test.
 *
 * var_stream_map must only name audio streams that exist: 'v:0,a:0 v:1,a:1'
 * against a source with no audio made the HLS muxer fail with "Unable to map
 * stream at a:0", so every silent video ended REJECTED.
 */
export function hlsArgs(src: string, hlsDir: string, audio: boolean): string[] {
  const audioFor = (_i: number) => (audio ? ['-map', '0:a'] : []);
  return ['-y', '-i', src,
    '-filter_complex', '[0:v]split=2[v1][v2];[v1]scale=-2:720[v720];[v2]scale=-2:480[v480]',
    '-map', '[v720]', ...audioFor(0), '-c:v:0', 'libx264', '-b:v:0', '2800k', '-preset', 'veryfast',
    '-map', '[v480]', ...audioFor(1), '-c:v:1', 'libx264', '-b:v:1', '1200k',
    ...(audio ? ['-c:a', 'aac', '-b:a', '128k'] : []),
    '-var_stream_map', audio ? 'v:0,a:0 v:1,a:1' : 'v:0 v:1', '-master_pl_name', 'master.m3u8',
    '-f', 'hls', '-hls_time', '6', '-hls_playlist_type', 'vod', '-hls_segment_filename', join(hlsDir, 's%v_%03d.ts'), join(hlsDir, 'p%v.m3u8')];
}

/**
 * Re-encodes an uploaded image with every piece of metadata dropped.
 *
 * Phone photos carry EXIF GPS coordinates by default -- often a creator's
 * home -- and the uploaded original is what anonymous viewers of a PUBLIC
 * post are served (modules/media.ts). sharp writes no metadata unless asked
 * (no withMetadata/keepMetadata here, deliberately). autoOrient bakes the
 * EXIF rotation into the pixels, since the orientation tag goes with the rest.
 * Same format out as in, so the stored mime stays true.
 */
// A decompression bomb (a small file declaring enormous dimensions) is
// refused before it is decoded into memory. ~50 megapixels covers any real
// camera/phone photo.
const LIMIT_INPUT_PIXELS = 50_000_000;

export async function sanitizeImage(input: Buffer | string, mime: string): Promise<Buffer> {
  if (mime === 'image/gif') return sharp(input, { animated: true, limitInputPixels: LIMIT_INPUT_PIXELS }).gif().toBuffer();
  const img = sharp(input, { autoOrient: true, limitInputPixels: LIMIT_INPUT_PIXELS });
  if (mime === 'image/png') return img.png().toBuffer();
  if (mime === 'image/webp') return img.webp({ quality: 92 }).toBuffer();
  return img.jpeg({ quality: 92 }).toBuffer();
}

/**
 * ffmpeg arguments for the blurred preview (the thumbnail shown to fans who
 * have not unlocked the media). ONE frame, always: the output is a single
 * JPEG, and without `-frames:v 1` an animated source (a sanitized GIF keeps
 * every frame) makes the image2 muxer refuse frame 2 ("Could not get frame
 * filename number 2 ... Use -frames:v 1"). ffmpeg exited non-zero, and every
 * animated GIF upload ended REJECTED after three attempts.
 */
export function previewArgs(src: string, out: string, opts: { seekSeconds?: number } = {}): string[] {
  const ss = opts.seekSeconds;
  return ['-y',
    ...(ss ? ['-ss', Number.isInteger(ss) ? `00:00:${String(ss).padStart(2, '0')}` : ss.toFixed(3)] : []),
    '-i', src, '-frames:v', '1', '-vf', 'scale=480:-2,boxblur=20:5', out];
}

/** The source's duration in seconds (ffprobe), NaN when it cannot be read. */
export async function probeDuration(src: string): Promise<number> {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src]);
    return Number.parseFloat(stdout.trim());
  } catch {
    return Number.NaN;
  }
}

/**
 * Where to take a video's preview frame: 1 s in (past a black first frame),
 * but never past the end. A clip shorter than a second used to be seeked to
 * 00:00:01 anyway; ffmpeg's accurate seek then discarded every frame, wrote
 * no preview.jpg and exited 0, the read of it threw ENOENT, and after three
 * full re-transcodes the upload ended REJECTED. Unknown duration: no seek.
 */
export function previewSeekSeconds(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return Math.min(1, durationSec / 2);
}
