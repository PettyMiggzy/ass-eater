import { Worker } from 'bullmq';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { prisma } from '../lib/prisma.js';
import { s3, BUCKET } from '../lib/s3.js';
import { connection } from '../lib/redis.js';

const run = promisify(execFile);
const ct = (f: string) => f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : f.endsWith('.ts') ? 'video/mp2t' : 'image/jpeg';

async function download(key: string, dest: string) {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  await writeFile(dest, Buffer.from(await r.Body!.transformToByteArray()));
}
async function uploadDir(dir: string, prefix: string) {
  for (const f of await readdir(dir))
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `${prefix}/${f}`, Body: await readFile(join(dir, f)), ContentType: ct(f) }));
}

new Worker('transcode', async (job) => {
  const m = await prisma.media.findUniqueOrThrow({ where: { id: job.data.mediaId } });
  const work = await mkdtemp(join(tmpdir(), 'tc-'));
  try {
    const src = join(work, 'src'); await download(m.key, src);
    const outPrefix = `media/${m.ownerId}/${m.id}`;
    const preview = join(work, 'preview.jpg');

    if (m.mime.startsWith('video/')) {
      const hls = join(work, 'hls'); await run('mkdir', ['-p', hls]);
      // 720p + 480p ladder, 6s segments, master playlist
      await run('ffmpeg', ['-y', '-i', src,
        '-filter_complex', '[0:v]split=2[v1][v2];[v1]scale=-2:720[v720];[v2]scale=-2:480[v480]',
        '-map', '[v720]', '-map', '0:a?', '-c:v:0', 'libx264', '-b:v:0', '2800k', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '128k',
        '-map', '[v480]', '-map', '0:a?', '-c:v:1', 'libx264', '-b:v:1', '1200k',
        '-var_stream_map', 'v:0,a:0 v:1,a:1', '-master_pl_name', 'master.m3u8',
        '-f', 'hls', '-hls_time', '6', '-hls_playlist_type', 'vod', '-hls_segment_filename', join(hls, 's%v_%03d.ts'), join(hls, 'p%v.m3u8')], { timeout: 3_600_000 });
      await run('ffmpeg', ['-y', '-ss', '00:00:01', '-i', src, '-frames:v', '1', '-vf', 'scale=480:-2,boxblur=20:5', preview]);
      await uploadDir(hls, outPrefix + '/hls');
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `${outPrefix}/preview.jpg`, Body: await readFile(preview), ContentType: 'image/jpeg' }));
      await prisma.media.update({ where: { id: m.id }, data: { status: 'READY', hlsKey: `${outPrefix}/hls/master.m3u8`, previewKey: `${outPrefix}/preview.jpg` } });
    } else {
      // Images are served directly from their raw key (see media.ts /:id/url) — this branch only
      // needs to produce the blurred preview shown to fans who haven't unlocked the content yet.
      await run('ffmpeg', ['-y', '-i', src, '-vf', 'scale=480:-2,boxblur=20:5', preview]);
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `${outPrefix}/preview.jpg`, Body: await readFile(preview), ContentType: 'image/jpeg' }));
      await prisma.media.update({ where: { id: m.id }, data: { status: 'READY', previewKey: `${outPrefix}/preview.jpg` } });
    }
  } catch (e) {
    await prisma.media.update({ where: { id: m.id }, data: { status: 'REJECTED' } });
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}, { ...connection, concurrency: 2 });
