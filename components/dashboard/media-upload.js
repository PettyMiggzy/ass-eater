import { put } from '@vercel/blob/client';
import { isValidListingPreview } from '../../lib/creator-status';
import { inferContentType, preflightUpload, responseErrorMessage } from './helpers';

/**
 * The browser half of the private-media upload flow (lib/media.js has the
 * server half):
 *
 *   1. POST /api/media/upload-token { purpose, contentType, size, listingId? }
 *      -> { pathname, clientToken } for ONE server-chosen pathname.
 *   2. put(pathname, file, { access: 'private', token }) straight to the Blob
 *      store. File bytes never pass through one of our functions, so the
 *      4.5MB function body limit no longer applies, and the file's own name
 *      is never sent anywhere (the old x-file-name header broke on any
 *      non-Latin-1 name and put user text into the storage path).
 *   3. POST the JSON finalize route, which re-checks the stored blob and
 *      records it.
 *
 * Throws an Error with a user-facing message on any failure.
 */

async function readJsonSafe(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await readJsonSafe(res);
  return { res, data };
}

export async function getJson(url) {
  const res = await fetch(url);
  const data = await readJsonSafe(res);
  return { res, data };
}

/**
 * @param {object} o
 * @param {File} o.file
 * @param {'gallery'|'avatar'|'listing'} o.purpose
 * @param {string} o.finalizeUrl
 * @param {object} [o.finalizeBody]  extra JSON for the finalize call (aiGenerated, listingId, preview)
 * @param {string|number} [o.listingId]
 * @param {(pct:number)=>void} [o.onProgress]
 * @returns {Promise<object>} the finalize route's JSON
 */
export async function uploadPrivateMedia({ file, purpose, finalizeUrl, finalizeBody = {}, listingId, onProgress }) {
  if (!file) throw new Error('Choose a file first.');
  const contentType = inferContentType(file);
  const problem = preflightUpload(purpose, contentType, file.size);
  if (problem) throw new Error(problem);

  const tokenReq = { purpose, contentType, size: file.size };
  if (purpose === 'listing') tokenReq.listingId = listingId;
  const { res: tokenRes, data: token } = await postJson('/api/media/upload-token', tokenReq);
  if (!tokenRes.ok || !token?.pathname || !token?.clientToken) {
    throw new Error(responseErrorMessage(tokenRes.status, token, 'Could not start the upload. Please try again.'));
  }

  try {
    await put(token.pathname, file, {
      access: 'private',
      token: token.clientToken,
      contentType,
      multipart: file.size > 5 * 1024 * 1024,
      onUploadProgress: onProgress ? ({ percentage }) => onProgress(Math.round(percentage)) : undefined,
    });
  } catch (err) {
    console.error('[dashboard] blob upload failed:', err);
    throw new Error('The upload did not complete. Check your connection and try again.');
  }

  const { res, data } = await postJson(finalizeUrl, { ...finalizeBody, pathname: token.pathname });
  if (!res.ok) throw new Error(responseErrorMessage(res.status, data, 'Upload failed. Please try again.'));
  return data || {};
}

const PREVIEW_SIZE = 32; // the stored preview's longest side
const PREVIEW_SAMPLE = 8; // drawn this small first, then scaled up: a blur that works in every browser

function drawPreview(source, width, height) {
  if (!width || !height) return null;
  const scale = Math.min(1, PREVIEW_SIZE / Math.max(width, height));
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const sampleScale = PREVIEW_SAMPLE / Math.max(outW, outH);
  const sample = document.createElement('canvas');
  sample.width = Math.max(1, Math.round(outW * sampleScale));
  sample.height = Math.max(1, Math.round(outH * sampleScale));
  const sctx = sample.getContext('2d');
  if (!sctx) return null;
  sctx.drawImage(source, 0, 0, sample.width, sample.height);

  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  // ctx.filter is ignored by Safari; the 8px sample above is what guarantees
  // nothing recognisable survives even there.
  ctx.filter = 'blur(2px)';
  ctx.drawImage(sample, 0, 0, outW, outH);
  const url = out.toDataURL('image/jpeg', 0.5);
  // toDataURL falls back to PNG when JPEG is unsupported; the server only
  // accepts a JPEG/WebP data URL of at most 16KB.
  return isValidListingPreview(url) ? url : null;
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
}

function imagePreview(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        resolve(drawPreview(img, img.naturalWidth, img.naturalHeight));
      } catch {
        resolve(null);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

function videoPreview(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      resolve(value);
    };
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onloadeddata = () => {
      const d = Number.isFinite(video.duration) ? video.duration : 0;
      if (d <= 0) {
        // Nothing to seek to (and seeking 0 -> 0 fires no 'seeked').
        try {
          finish(drawPreview(video, video.videoWidth, video.videoHeight));
        } catch {
          finish(null);
        }
        return;
      }
      // A frame a little way in: the very first frame of many clips is black.
      video.currentTime = Math.min(1, d / 4);
    };
    video.onseeked = () => {
      try {
        finish(drawPreview(video, video.videoWidth, video.videoHeight));
      } catch {
        finish(null);
      }
    };
    video.onerror = () => finish(null);
    video.src = url;
  });
}

/**
 * A tiny, heavily blurred JPEG data URL of the file (a captured frame for a
 * video). This is the ONLY image of paid listing media a non-buyer ever
 * receives. Resolves null when the browser can't decode the file (HEIC on
 * most desktop browsers, for instance) -- the listing then shows a
 * placeholder, which is safe; the real file is never used instead.
 */
export async function generateListingPreview(file) {
  if (typeof document === 'undefined' || !file) return null;
  const type = inferContentType(file) || '';
  try {
    if (type.startsWith('video/')) return await withTimeout(videoPreview(file), 8000);
    if (type.startsWith('image/')) return await withTimeout(imagePreview(file), 8000);
  } catch {
    // fall through
  }
  return null;
}
