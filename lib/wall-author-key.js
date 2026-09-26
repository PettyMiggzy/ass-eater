import crypto from 'crypto';
import { ageVerificationSecret } from './age-verification';

/**
 * The per-(wall, author) key a wall-comment notification is coalesced on
 * (server-only). An HMAC under a server secret derived for this purpose only:
 * an unkeyed hash of the account id let a creator hash every id they know and
 * name the commenter, and tied one commenter across walls (round-8
 * social#1). Shared by pages/api/wall/post.js (which writes it) and
 * lib/users-store.js purgeUserContent (which finds a deleted account's
 * comment notifications by it, round-11 legal-journeys#0).
 */
export function wallAuthorDigest(creatorId, uid) {
  const key = crypto.createHmac('sha256', String(ageVerificationSecret())).update('oa:wall-author:v1').digest();
  return crypto.createHmac('sha256', key).update(`${creatorId}:${uid}`).digest('hex').slice(0, 24);
}

/** The full `meta.wallAuthorKey` value: "<creatorId>:<digest>". */
export function wallAuthorKey(creatorId, uid) {
  return `${creatorId}:${wallAuthorDigest(creatorId, uid)}`;
}
