import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

type Db = Pick<Prisma.TransactionClient, 'media'>;

/**
 * Upload limits. Any bridged account can reach /upload-url (fans attach
 * media to DMs), and each call used to mint a presigned PUT for up to 4 GiB
 * with no quota at all -- storage billed to the platform at the global rate
 * limit, and a single huge image enough to exhaust the workers' memory.
 *
 *  - Per object: images 50 MB for everyone (sharp works on whole images);
 *    video 4 GiB for an operating creator, 100 MB for anyone else. (Media.bytes
 *    is a BIGINT for this reason: 4 GiB does not fit an int4 column.)
 *  - Outstanding: at most MAX_OPEN_UPLOADS never-completed (UPLOADING) rows
 *    per account; abandoned ones older than STALE_UPLOAD_MS stop counting
 *    and are swept (workers/transcode.ts sweepAbandonedUploads).
 *  - Rolling 24h bytes declared: 20 GiB for an operating creator, 500 MB for
 *    anyone else.
 *
 * The declared size is also the presigned URL's Content-Length, so S3
 * refuses a PUT of any other size.
 *
 * The check and the Media insert must be one serialized step per account
 * (createUploadWithinQuota): checked separately, a burst of parallel
 * /upload-url calls all passed before any of their rows existed.
 */
export const UPLOAD_LIMITS = {
  IMAGE_MAX_BYTES: 50 * 1024 ** 2,
  CREATOR_VIDEO_MAX_BYTES: 4 * 1024 ** 3,
  OTHER_VIDEO_MAX_BYTES: 100 * 1024 ** 2,
  MAX_OPEN_UPLOADS: 10,
  CREATOR_DAILY_BYTES: 20 * 1024 ** 3,
  OTHER_DAILY_BYTES: 500 * 1024 ** 2,
  STALE_UPLOAD_MS: 24 * 60 * 60 * 1000,
};

export function maxBytesFor(mime: string, isCreator: boolean) {
  if (mime.startsWith('image/')) return UPLOAD_LIMITS.IMAGE_MAX_BYTES;
  return isCreator ? UPLOAD_LIMITS.CREATOR_VIDEO_MAX_BYTES : UPLOAD_LIMITS.OTHER_VIDEO_MAX_BYTES;
}

/** Why `ownerId` may not start another upload of `bytes`, or null if they may. */
export async function uploadQuotaError(ownerId: string, bytes: number, isCreator: boolean, now = Date.now(), db: Db = prisma): Promise<string | null> {
  const staleBefore = new Date(now - UPLOAD_LIMITS.STALE_UPLOAD_MS);
  const open = await db.media.count({ where: { ownerId, status: 'UPLOADING', createdAt: { gte: staleBefore } } });
  if (open >= UPLOAD_LIMITS.MAX_OPEN_UPLOADS) return 'too_many_open_uploads';
  const day = await db.media.aggregate({
    where: { ownerId, sourceMediaId: null, createdAt: { gte: new Date(now - 24 * 60 * 60 * 1000) } },
    _sum: { bytes: true },
  });
  const cap = isCreator ? UPLOAD_LIMITS.CREATOR_DAILY_BYTES : UPLOAD_LIMITS.OTHER_DAILY_BYTES;
  // BigInt column (a single video may exceed int4); every sum here is far
  // below 2^53, so Number is exact.
  if (Number(day._sum.bytes ?? 0n) + bytes > cap) return 'upload_quota_exceeded';
  return null;
}

/**
 * Checks the quota and records the new upload's Media row in one
 * transaction holding a per-account advisory lock, so concurrent requests
 * for the same account see each other's rows. Returns the quota error
 * instead of a row when the upload is refused.
 */
export async function createUploadWithinQuota(
  ownerId: string, isCreator: boolean, data: { key: string; mime: string; bytes: number },
): Promise<{ error: string } | { media: { id: string } }> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'upload:' + ownerId}))`;
    const err = await uploadQuotaError(ownerId, data.bytes, isCreator, Date.now(), tx);
    if (err) return { error: err };
    const media = await tx.media.create({ data: { ownerId, ...data }, select: { id: true } });
    return { media };
  });
}
