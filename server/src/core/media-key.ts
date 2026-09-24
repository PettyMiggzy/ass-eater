/**
 * The storage object behind a Media row.
 *
 * Media.key is unique, so the per-recipient copies a mass DM makes
 * (workers/broadcast.ts) can't reuse their source's key -- that collision
 * made every media broadcast fail after the first fan. A copy's key is
 * `<source key>#<messageId>`; everything that touches storage (signed URLs,
 * watermarking, deletion) resolves it back to the real object here.
 * '#' never appears in a real upload key (modules/media.ts builds them from
 * a user id and a nanoid).
 */
export function storageKeyOf(key: string): string {
  const i = key.indexOf('#');
  return i === -1 ? key : key.slice(0, i);
}

export function broadcastCopyKey(sourceKey: string, messageId: string): string {
  return `${storageKeyOf(sourceKey)}#${messageId}`;
}
