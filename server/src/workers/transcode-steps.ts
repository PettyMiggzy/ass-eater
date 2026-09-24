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
export async function sanitizeImage(buf: Buffer, mime: string): Promise<Buffer> {
  if (mime === 'image/gif') return sharp(buf, { animated: true }).gif().toBuffer();
  const img = sharp(buf, { autoOrient: true });
  if (mime === 'image/png') return img.png().toBuffer();
  if (mime === 'image/webp') return img.webp({ quality: 92 }).toBuffer();
  return img.jpeg({ quality: 92 }).toBuffer();
}
