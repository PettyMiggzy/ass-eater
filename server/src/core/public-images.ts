import { Prisma } from '@prisma/client';
import { cdnPreviewUrlOrNull } from '../lib/s3.js';
import type { Tx } from './ledger.js';

/**
 * Free, public images: a listing's preview photos (Listing.images) and a
 * creator's avatar / banner (CreatorProfile.avatarKey / bannerKey).
 *
 * STORED as the storage key of the creator's own uploaded image
 * (`raw/<ownerId>/<id>` -- the sanitized, EXIF-stripped re-encode the
 * transcode worker writes in place), NEVER as a URL. Bunny's Token
 * Authentication is a pull-zone-wide switch and the deploy kit turns it on,
 * so an unsigned https://<cdn>/<key> is refused at the edge -- and a signed
 * one cannot be stored, because it expires. Listing images used to be stored
 * as URLs under media/<creatorId>/ (the only thing there is the BLURRED
 * teaser and HLS output), so every preview was either refused by the CDN or
 * a blurred frame. They are now signed at READ time (publicImageUrl).
 *
 * Accepted at write time (assertOwnPublicImages) only as the creator's OWN
 * media that is READY, an image, and an unattached original -- not a
 * broadcast copy or a broadcast's source, not attached to a post, a DM or a
 * listing's product, and not the product of the very listing being created
 * -- so a paid or private item cannot be published through this door.
 *
 * The reverse direction is enforced where media gets ATTACHED:
 * assertNotPublicImages refuses to make an avatar, banner or any listing's
 * preview photo into a post's, a DM's, a broadcast's or a listing product's
 * content. Public images are served unwatermarked to anyone, so an item that
 * is one cannot also be sold as paid or exclusive.
 *
 * Serialized against mass DMs through the media rows themselves:
 * assertOwnPublicImages (and marketplace.ts assertNotDistributed) lock the
 * rows FOR UPDATE before counting broadcast copies, and every per-fan copy
 * the broadcast worker writes first locks-and-touches its source rows
 * (workers/broadcast.ts claimSourcesForCopy) and then re-checks
 * assertNotPublicImages. Whichever commits second sees the other: a
 * read-committed check waits for the copy and its next statement counts it;
 * a serializable one (money()) gets a serialization failure and retries; and
 * a copy transaction that waited on the lock re-checks after it.
 */

const KEY_RE = /^raw\/[0-9a-zA-Z-]{1,64}\/[A-Za-z0-9_-]{1,64}$/;

/** A signed (or, on a zone without token auth, plain) URL for a stored public image key; null if none can be made. */
export function publicImageUrl(key: string | null | undefined): string | null {
  if (typeof key !== 'string' || !KEY_RE.test(key)) return null;
  try { return cdnPreviewUrlOrNull(`/${key}`); } catch { return null; }
}

/** The list form, dropping anything that cannot be served (a legacy URL value, no CDN configured). */
export function publicImageUrls(keys: string[] | null | undefined): string[] {
  return (keys ?? []).map(publicImageUrl).filter((u): u is string => !!u);
}

/**
 * Adds `avatarUrl` / `bannerUrl` (signed) next to a creator profile's stored
 * keys. The stored key alone is not loadable by a browser (see above).
 */
export function withProfileImageUrls<T extends { avatarKey?: string | null; bannerKey?: string | null }>(c: T): T & { avatarUrl: string | null; bannerUrl: string | null } {
  return { ...c, avatarUrl: publicImageUrl(c.avatarKey), bannerUrl: publicImageUrl(c.bannerKey) };
}

export class BadPublicImages extends Error {
  statusCode = 400;
  constructor() { super('bad_images'); }
}

/**
 * Throws 400 bad_images unless every key is the storage key of `ownerId`'s
 * own READY image that is an unattached original and not the source of a
 * mass DM (whose copies sit, possibly priced, in every subscriber's inbox).
 * `reservedMediaIds` are media the same request is about to attach as paid
 * content (a new listing's product): none of them may double as a free
 * preview. Duplicates are refused.
 */
export async function assertOwnPublicImages(db: Pick<Tx, 'media' | '$queryRaw'>, ownerId: string, keys: string[], reservedMediaIds: string[] = []) {
  if (!keys.length) return;
  if (new Set(keys).size !== keys.length) throw new BadPublicImages();
  if (keys.some((k) => typeof k !== 'string' || !KEY_RE.test(k) || !k.startsWith(`raw/${ownerId}/`))) throw new BadPublicImages();
  // Lock first, count after (see the header): must run inside the
  // transaction that then publishes the image.
  await lockMedia(db, ownerId, [], keys);
  const found = await db.media.findMany({
    where: {
      key: { in: keys }, ownerId, status: 'READY', mime: { startsWith: 'image/' },
      sourceMediaId: null, postId: null, messageId: null, listingId: null,
      ...(reservedMediaIds.length ? { id: { notIn: reservedMediaIds } } : {}),
    },
    select: { id: true },
  });
  if (found.length !== keys.length) throw new BadPublicImages();
  if (await db.media.count({ where: { sourceMediaId: { in: found.map((m) => m.id) } } })) throw new BadPublicImages();
}

export class MediaIsPublicImage extends Error {
  statusCode = 400;
  constructor() { super('media_is_public_image'); }
}

/**
 * Throws 400 media_is_public_image when any of these media is currently a
 * public image: some listing's preview photo (any status -- a removed
 * listing's page still shows its photos to past buyers) or a creator's
 * avatar or banner. Called wherever media becomes paid or private content.
 */
export async function assertNotPublicImages(db: Pick<Tx, 'media' | 'listing' | 'creatorProfile'>, mediaIds: string[]) {
  if (!mediaIds.length) return;
  const keys = (await db.media.findMany({ where: { id: { in: mediaIds } }, select: { key: true } })).map((m) => m.key);
  if (!keys.length) return;
  if (await db.listing.count({ where: { images: { hasSome: keys } } })) throw new MediaIsPublicImage();
  if (await db.creatorProfile.count({ where: { OR: [{ avatarKey: { in: keys } }, { bannerKey: { in: keys } }] } })) throw new MediaIsPublicImage();
}

/**
 * Locks `ownerId`'s media rows FOR UPDATE, in id order (one statement, so two
 * lockers never take the same rows in opposite orders). Called before a
 * check that counts broadcast copies of those rows, so it cannot run while a
 * copy of them is being written (workers/broadcast.ts holds them until the
 * copy commits). Only meaningful inside a transaction.
 *
 * Only the caller's OWN rows: the ids and keys are client-supplied and are
 * locked before they are validated, so without the owner predicate a creator
 * could name another creator's media (a live mass DM's source rows included)
 * and stall that creator's copy transactions on every request. Someone
 * else's media fails validation anyway, so leaving it unlocked costs nothing.
 */
export async function lockMedia(db: Pick<Tx, '$queryRaw'>, ownerId: string, ids: string[], keys: string[] = []) {
  const conds: Prisma.Sql[] = [];
  if (ids.length) conds.push(Prisma.sql`id IN (${Prisma.join(ids)})`);
  if (keys.length) conds.push(Prisma.sql`"key" IN (${Prisma.join(keys)})`);
  if (!conds.length) return;
  await db.$queryRaw`SELECT id FROM "Media" WHERE "ownerId" = ${ownerId} AND (${Prisma.join(conds, ' OR ')}) ORDER BY id FOR UPDATE`;
}
