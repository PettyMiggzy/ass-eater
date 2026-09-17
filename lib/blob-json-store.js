import { put, head } from '@vercel/blob';

/**
 * Read-modify-write a JSON array stored as a single Vercel Blob file,
 * guarded by the blob's ETag as an optimistic-concurrency precondition
 * (Vercel Blob's `ifMatch` -- a mismatch throws BlobPreconditionFailedError,
 * per @vercel/blob's own documented behavior).
 *
 * Every store in this app used to read the whole list, compute a new list
 * in memory, then unconditionally overwrite the file. Two requests racing
 * to update the SAME file (two messages sent close together, two NCII
 * takedown reports filed within milliseconds, etc.) would both read the
 * same starting list, and whichever plain overwrite finished last silently
 * discarded the other's change -- with no error to anyone, on either side.
 * With `ifMatch`, the loser's write is rejected instead of accepted, and
 * this retries it against the winner's fresh state rather than losing it.
 */
const MAX_RETRIES = 5;

export async function readJsonList(path, fallback = []) {
  try {
    const info = await head(path);
    const res = await fetch(`${info.url}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return fallback;
    return await res.json();
  } catch {
    return fallback;
  }
}

function isPreconditionFailure(err) {
  return err?.name === 'BlobPreconditionFailedError' || /precondition/i.test(String(err?.message || ''));
}

/**
 * `transform(current)` must return `{ next, result }` -- `next` is the full
 * array to persist, `result` is whatever the caller wants back (the
 * created/updated entry, typically). Retries automatically on a write
 * conflict; throws after MAX_RETRIES straight losses (pathological
 * contention, not the normal case). `fallback` is what `current` starts as
 * when the manifest doesn't exist yet (default `[]`; creators-store.js
 * passes its seed roster instead).
 */
export async function updateJsonList(path, transform, { fallback = [] } = {}) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let etag;
    let current = fallback;
    try {
      const info = await head(path);
      etag = info.etag;
      const res = await fetch(`${info.url}?t=${Date.now()}`, { cache: 'no-store' });
      current = res.ok ? await res.json() : fallback;
    } catch {
      // Manifest doesn't exist yet -- first write for this path, no etag precondition.
    }

    const { next, result } = await transform(current);

    try {
      await put(path, JSON.stringify(next, null, 2), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 60,
        token: process.env.BLOB_READ_WRITE_TOKEN,
        ...(etag ? { ifMatch: etag } : {}),
      });
      return result;
    } catch (err) {
      if (!isPreconditionFailure(err) || attempt === MAX_RETRIES - 1) throw err;
      // Someone else wrote first -- loop and retry against their fresh state.
    }
  }
}
