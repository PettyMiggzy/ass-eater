import { Worker } from 'bullmq';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import type { Readable } from 'stream';
import { hasAudio, hlsArgs, sanitizeImage } from './transcode-steps.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { prisma } from '../lib/prisma.js';
import { s3, BUCKET, deletePrefix, deleteObject, isNotFound } from '../lib/s3.js';
import { UPLOAD_LIMITS } from '../core/upload-limits.js';
import { connection } from '../lib/redis.js';
import { registerWorker, onStop } from './process-guards.js';

const run = promisify(execFile);

// ffmpeg/ffprobe are system packages (deploy/provision.sh, app-setup.sh), not
// npm dependencies. Without them every upload -- images included, for their
// blurred preview -- failed with ENOENT and ended REJECTED with nothing in
// the logs saying why. Say it once, loudly, at startup.
if (process.env.NODE_ENV !== 'test') {
  run('ffmpeg', ['-version']).catch(() =>
    console.error('transcode: ffmpeg is NOT installed on this host -- every media upload will be REJECTED. apt-get install -y ffmpeg'));
}

const ct = (f: string) => f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : f.endsWith('.ts') ? 'video/mp2t' : 'image/jpeg';

// Streamed straight to disk. transformToByteArray() buffered the whole object
// and Buffer.from() copied it again -- ~2x the upload in RAM, in the one
// process every worker shares (payouts, renewals, deposits), on a 2 GB box.
// A 1.5 GB video was enough to OOM-kill all of them.
async function download(key: string, dest: string) {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!r.Body) throw new Error('empty_object');
  await pipeline(r.Body as Readable, createWriteStream(dest));
}
async function uploadDir(dir: string, prefix: string) {
  for (const f of await readdir(dir))
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `${prefix}/${f}`, Body: await readFile(join(dir, f)), ContentType: ct(f) }));
}

/**
 * Media still PROCESSING? An admin takedown (DELETE /admin/media/:id) sets
 * REJECTED and deletes the objects while a job may be mid-flight. Every write
 * that could put content back re-checks this first, and the final READY flip
 * is guarded on it -- otherwise the job re-uploaded the derivatives (and, for
 * an image, the raw key) after the takedown and marked the media READY again.
 */
async function stillProcessing(id: string) {
  const row = await prisma.media.findUnique({ where: { id }, select: { status: true } });
  return row?.status === 'PROCESSING';
}

/** Remove what this job wrote after a takedown raced it. */
async function undoAfterTakedown(m: { id: string; key: string }, outPrefix: string, wroteRaw: boolean) {
  console.warn(`transcode: media ${m.id} was taken down mid-job; deleting what this job wrote`);
  await deletePrefix(`${outPrefix}/`);
  if (wroteRaw) await deleteObject(m.key);
}

registerWorker(new Worker('transcode', async (job) => {
  const m = await prisma.media.findUnique({ where: { id: job.data.mediaId } });
  // Deleted, or taken down before the job started: nothing to do.
  if (!m || m.status !== 'PROCESSING') return;
  const work = await mkdtemp(join(tmpdir(), 'tc-'));
  const outPrefix = `media/${m.ownerId}/${m.id}`;
  let wroteRaw = false;
  try {
    const src = join(work, 'src'); await download(m.key, src);
    const preview = join(work, 'preview.jpg');

    if (m.mime.startsWith('video/')) {
      const hls = join(work, 'hls'); await run('mkdir', ['-p', hls]);
      // 720p + 480p ladder, 6s segments, master playlist
      await run('ffmpeg', hlsArgs(src, hls, await hasAudio(src)), { timeout: 3_600_000 });
      await run('ffmpeg', ['-y', '-ss', '00:00:01', '-i', src, '-frames:v', '1', '-vf', 'scale=480:-2,boxblur=20:5', preview]);
      if (!(await stillProcessing(m.id))) return;
      await uploadDir(hls, outPrefix + '/hls');
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `${outPrefix}/preview.jpg`, Body: await readFile(preview), ContentType: 'image/jpeg' }));
      const done = await prisma.media.updateMany({ where: { id: m.id, status: 'PROCESSING' }, data: { status: 'READY', hlsKey: `${outPrefix}/hls/master.m3u8`, previewKey: `${outPrefix}/preview.jpg` } });
      if (done.count === 0) await undoAfterTakedown(m, outPrefix, false);
    } else {
      // Images are served from their raw key (see media.ts /:id/url), so the
      // raw object is replaced in place with a metadata-stripped re-encode
      // before the media can become READY -- the unsanitized original is
      // never served to anyone. (If the bucket keeps object versions, the
      // prior version still exists there; this bucket is not versioned.)
      // From the file path, not a buffer of it: sharp streams the decode and
      // refuses anything past its pixel limit (transcode-steps.ts).
      if ((await stat(src)).size > UPLOAD_LIMITS.IMAGE_MAX_BYTES) throw new Error('image_too_large');
      const clean = await sanitizeImage(src, m.mime);
      await writeFile(src, clean);
      // Then the blurred preview shown to fans who haven't unlocked it yet.
      await run('ffmpeg', ['-y', '-i', src, '-vf', 'scale=480:-2,boxblur=20:5', preview]);
      // Re-checked right before the in-place overwrite: after a takedown the
      // raw key is gone, and writing it back would resurrect the content.
      if (!(await stillProcessing(m.id))) return;
      wroteRaw = true;
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: m.key, Body: clean, ContentType: m.mime }));
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `${outPrefix}/preview.jpg`, Body: await readFile(preview), ContentType: 'image/jpeg' }));
      const done = await prisma.media.updateMany({ where: { id: m.id, status: 'PROCESSING' }, data: { status: 'READY', previewKey: `${outPrefix}/preview.jpg`, bytes: clean.length } });
      if (done.count === 0) await undoAfterTakedown(m, outPrefix, true);
    }
  } catch (e) {
    // Only the LAST attempt rejects the media. Rejecting on an earlier one
    // left it REJECTED while BullMQ retried, and a retry can no longer flip a
    // REJECTED row to READY (the flip is guarded on PROCESSING above).
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade + 1 >= attempts) {
      await prisma.media.updateMany({ where: { id: m.id, status: 'PROCESSING' }, data: { status: 'REJECTED' } });
    }
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}, { ...connection, concurrency: 2 }));

/**
 * Never-completed uploads: a presigned PUT URL lives 15 minutes, so an
 * UPLOADING row older than UPLOAD_LIMITS.STALE_UPLOAD_MS will never be
 * completed. Its raw object (if anything was PUT) is deleted and the row
 * removed, so abandoned uploads neither cost storage forever nor count
 * against the owner's open-upload limit. This sweep is the ONLY cleanup for
 * raw/: do NOT add a bucket lifecycle rule expiring raw/ objects --
 * completed images are served from their raw key, so an expiry rule would
 * delete live content. The only bucket rule to add is one aborting
 * incomplete multipart uploads (server/deploy/DEPLOY.md).
 */
export async function sweepAbandonedUploads(now = Date.now()) {
  const stale = await prisma.media.findMany({
    where: { status: 'UPLOADING', createdAt: { lt: new Date(now - UPLOAD_LIMITS.STALE_UPLOAD_MS) } },
    select: { id: true, key: true }, take: 500,
  });
  let removed = 0;
  for (const m of stale) {
    try { await deleteObject(m.key); } catch (e) { if (!isNotFound(e)) { console.error('upload sweep: delete', m.id, e); continue; } }
    const r = await prisma.media.deleteMany({ where: { id: m.id, status: 'UPLOADING' } });
    removed += r.count;
  }
  return removed;
}

if (process.env.NODE_ENV !== 'test') {
  const t = setInterval(() => { sweepAbandonedUploads().catch((e) => console.error('upload sweep', e)); }, 60 * 60 * 1000);
  onStop(() => clearInterval(t));
}
