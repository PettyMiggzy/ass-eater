import { put, head, BlobNotFoundError, BlobPreconditionFailedError } from '@vercel/blob';

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
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE, and the one it previously got
 * catastrophically wrong: a read that FAILED is not an empty manifest.
 * The first version of this helper caught every read error in one block
 * commented "manifest doesn't exist yet" and carried on with `fallback` as
 * the current state. That conflated two completely different situations:
 *
 *   1. The blob genuinely is not there yet (first ever write for this path)
 *      -- `fallback` is correct.
 *   2. The blob EXISTS and is full of real records, but reading its body
 *      failed (a network blip, a 5xx from blob storage, a truncated body)
 *      -- `fallback` is catastrophically wrong.
 *
 * In case 2 the ETag had already been captured from a successful head(),
 * and nothing else had modified the blob, so the precondition MATCHED and
 * the write succeeded -- overwriting every real record with `fallback`.
 * One transient network error during any write would have destroyed that
 * entire manifest: every user account, every listing, every message, or
 * (for creators-store, whose fallback is the demo seed roster) replaced
 * every real creator with the fake launch-demo ones. Silently, with a 200.
 *
 * So: `fallback` is used ONLY on a confirmed not-found. Every other read
 * failure aborts the write and throws. Losing one write to a clear error is
 * always better than a silent successful write of the wrong data.
 */
const MAX_RETRIES = 5;

// @vercel/blob's error classes do NOT set a custom `.name` -- it reads
// "Error" on every one of them (verified against @vercel/blob 2.8.0). An
// `err.name === 'BlobPreconditionFailedError'` check, which is what this
// file used to do, is therefore dead code that never matches. instanceof is
// the real test.
//
// Deliberately instanceof ONLY, with no message fallback, unlike the
// precondition check below. The obvious regex is wrong in a way that is
// easy to miss and expensive to get wrong:
//
//   BlobNotFoundError      -> "Vercel Blob: The requested blob does not exist"
//   BlobStoreNotFoundError -> "Vercel Blob: This store does not exist."
//
// A /does not exist/ test matches both, so a misconfigured or deleted blob
// store (a wrong token, a store removed) would be read as "this manifest
// just doesn't exist yet" and quietly answered with `fallback` -- serving
// the hardcoded demo creator roster as though those were real people.
// instanceof can only fail in the safe direction: a genuine not-found that
// somehow isn't recognised throws instead of silently substituting
// defaults, which is the error this whole file exists to prefer.
function isNotFound(err) {
  return err instanceof BlobNotFoundError;
}

function isPreconditionFailure(err) {
  return err instanceof BlobPreconditionFailedError || /precondition/i.test(String(err?.message || ''));
}

/**
 * Reads the manifest and its current ETag.
 *
 * Returns `{ exists: false }` ONLY when blob storage confirms the path is
 * not there. Any other failure throws -- see the rule at the top of this
 * file. Callers must never substitute a default for a thrown error.
 */
async function readManifest(path) {
  let info;
  try {
    info = await head(path);
  } catch (err) {
    if (isNotFound(err)) return { exists: false, current: null, etag: null };
    throw err;
  }

  const res = await fetch(`${info.url}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Blob store: failed to read ${path} (HTTP ${res.status}). Refusing to treat an unreadable manifest as an empty one.`);
  }

  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error(`Blob store: ${path} did not contain a JSON array. Refusing to overwrite it.`);
  }

  return { exists: true, current: data, etag: info.etag };
}

/**
 * Reads a JSON array manifest.
 *
 * `fallback` is returned only when the manifest genuinely does not exist
 * yet. A real read failure throws rather than quietly returning `fallback`:
 * for creators-store that fallback is the hardcoded demo roster, and
 * serving invented creator profiles to real visitors as though they were
 * real people is worse than a page erroring out on a transient blip and
 * working again on the next request. Callers that genuinely can tolerate
 * missing data should catch it explicitly, so the decision is visible at
 * the call site rather than hidden in here.
 */
export async function readJsonList(path, fallback = []) {
  const { exists, current } = await readManifest(path);
  return exists ? current : fallback;
}

/**
 * `transform(current)` must return `{ next, result }` -- `next` is the full
 * array to persist, `result` is whatever the caller wants back (the
 * created/updated entry, typically). Retries automatically on a write
 * conflict AND on a transient read failure; throws after MAX_RETRIES
 * straight losses (pathological contention, not the normal case).
 * `fallback` is what `current` starts as when the manifest does not exist
 * yet (default `[]`; creators-store.js passes its seed roster instead).
 *
 * NOTE for callers: `transform` runs again on every retry, so it must be a
 * pure function of `current`. Do not put side effects inside it (sending a
 * notification, charging something, generating an id you also use
 * elsewhere) -- they will happen more than once.
 *
 * KNOWN, UNFIXED, and small: there is no atomic create. When the manifest
 * does not exist there is no ETag to make a precondition from, and
 * @vercel/blob's put() has no if-none-match equivalent (its `ifNoneMatch`
 * is a download option, not an upload one -- checked, not assumed), so two
 * concurrent first-ever writes to the same new path can both succeed and
 * one is lost. Every manifest this app uses already exists in production,
 * so this is a cold-start-only window, not an ongoing race.
 */
export async function updateJsonList(path, transform, { fallback = [] } = {}) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let snapshot;
    try {
      snapshot = await readManifest(path);
    } catch (err) {
      // Never fall through to the write with a default in hand -- that is
      // the exact bug documented at the top of this file. Retry the read,
      // and if it keeps failing, fail loudly without touching the blob.
      if (attempt === MAX_RETRIES - 1) throw err;
      continue;
    }

    const current = snapshot.exists ? snapshot.current : fallback;

    // An existing manifest must only ever be written behind its own ETag.
    // Without one this would be a blind overwrite of live data, which is
    // the whole class of bug this helper exists to prevent.
    if (snapshot.exists && !snapshot.etag) {
      throw new Error(`Blob store: ${path} exists but returned no ETag. Refusing to overwrite it without a precondition.`);
    }

    const { next, result } = await transform(current);
    if (!Array.isArray(next)) {
      throw new Error(`Blob store: transform for ${path} returned a non-array. Refusing to write it.`);
    }

    try {
      await put(path, JSON.stringify(next, null, 2), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 60,
        token: process.env.BLOB_READ_WRITE_TOKEN,
        ...(snapshot.etag ? { ifMatch: snapshot.etag } : {}),
      });
      return result;
    } catch (err) {
      if (!isPreconditionFailure(err) || attempt === MAX_RETRIES - 1) throw err;
      // Someone else wrote first -- loop and retry against their fresh state.
    }
  }

  // Unreachable: the loop either returns or throws on its final attempt.
  // Kept so a future edit to the loop can't silently start returning
  // undefined to a caller that expects the written record back.
  throw new Error(`Blob store: exhausted ${MAX_RETRIES} attempts updating ${path}.`);
}
