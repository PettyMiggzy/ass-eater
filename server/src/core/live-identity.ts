import { createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Opaque, per-stream LiveKit identities for viewers.
 *
 * A LiveKit participant's identity is shown to every other participant in the
 * room. Viewer tokens used to carry the viewer's platform user id, so every
 * fan in a stream learned every other fan's stable account id -- the same id
 * that ties them to everything else they do here, on a platform where a fan
 * is otherwise anonymous to other fans.
 *
 * A viewer's identity is now `v.<base64url(iv || AES-256-CTR(userId))>` where
 * the IV is an HMAC of (streamId, userId): deterministic (one identity per
 * viewer per stream, so LiveKit's duplicate-identity handling still replaces
 * a stale connection by the same viewer), different on every stream (nobody
 * can link a viewer across streams), and reversible only by the server --
 * the participant_joined webhook and the sweep decode it back to a user id to
 * check entitlement. Decoding re-derives the IV and compares, so a forged or
 * cross-stream identity decodes to nothing.
 *
 * Keys are derived from LIVEKIT_API_SECRET (the secret every live token is
 * already signed with), under their own context strings.
 */

const PREFIX = 'v.';

function rootSecret(): string {
  const s = process.env.LIVEKIT_API_SECRET || process.env.JWT_SECRET;
  if (!s) throw new Error('live_identity_secret_missing');
  return s;
}

const derive = (ctx: string) => createHmac('sha256', rootSecret()).update(ctx).digest();

function ivFor(streamId: string, userId: string) {
  return createHmac('sha256', derive('onlyone:live-viewer-identity:iv:v1')).update(`${streamId}\0${userId}`).digest().subarray(0, 16);
}

/** The LiveKit identity a (non-publishing) viewer token carries on this stream. */
export function viewerIdentity(streamId: string, userId: string): string {
  const iv = ivFor(streamId, userId);
  const c = createCipheriv('aes-256-ctr', derive('onlyone:live-viewer-identity:enc:v1'), iv);
  const ct = Buffer.concat([c.update(userId, 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, ct]).toString('base64url');
}

/**
 * The platform user id behind a LiveKit identity on this stream, or null.
 *
 * An identity without the viewer prefix is a raw user id -- only the
 * creator's publish token still carries one (the creator is public anyway,
 * and `identity === creatorId` is how the sweep recognises them). Anything
 * else that does not decode AND round-trip for this exact stream is null,
 * which every caller treats as "not entitled".
 */
export function resolveLiveIdentity(streamId: string, identity: string): string | null {
  if (!identity) return null;
  if (!identity.startsWith(PREFIX)) return identity;
  let raw: Buffer;
  try { raw = Buffer.from(identity.slice(PREFIX.length), 'base64url'); } catch { return null; }
  if (raw.length <= 16) return null;
  const iv = raw.subarray(0, 16);
  const d = createDecipheriv('aes-256-ctr', derive('onlyone:live-viewer-identity:enc:v1'), iv);
  const userId = Buffer.concat([d.update(raw.subarray(16)), d.final()]).toString('utf8');
  const expect = ivFor(streamId, userId);
  if (!timingSafeEqual(expect, iv)) return null;
  return userId;
}
