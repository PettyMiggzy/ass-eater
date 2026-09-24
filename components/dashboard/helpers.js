import { isAddress } from 'viem';
import {
  IMAGE_TYPES,
  VIDEO_TYPES,
  mediaKindFor,
  maxBytesFor,
  normalizeContentType,
  uploadSizeMessage,
  UPLOAD_TYPE_MESSAGE,
  AVATAR_TYPE_MESSAGE,
} from '../../lib/upload-guard';
import { DM_PRICE_MIN_CENTS, DM_PRICE_MAX_CENTS } from '../../lib/field-validation';
import { gateTokensOf } from '../../lib/token-gate';

/**
 * Pure helpers for the creator dashboard. No React, no network, no
 * @vercel/blob -- so they can be unit-tested with plain node
 * (lib/dashboard-helpers.test.mjs) and imported by any dashboard component.
 */

// Browsers leave File.type empty for some formats (HEIC on most desktop
// browsers, some .mov files), and the upload-token route refuses a missing
// type. The server allowlist is still the authority -- this only recovers the
// type the file obviously is, from an extension on that same allowlist.
const EXTENSION_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

/** The content type to declare for a File, or null when it isn't one we accept at all. */
export function inferContentType(file) {
  const declared = normalizeContentType(file?.type);
  if (declared && (IMAGE_TYPES[declared] || VIDEO_TYPES[declared])) return declared;
  const name = typeof file?.name === 'string' ? file.name : '';
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return EXTENSION_TYPES[ext] || declared || null;
}

/**
 * The same checks the upload-token route makes, run before anything is sent
 * so an obviously wrong file gets a clear message instead of a round trip.
 * Returns an error string, or null when the file may be uploaded.
 */
export function preflightUpload(purpose, contentType, size) {
  if (!mediaKindFor(purpose, contentType)) {
    return purpose === 'avatar' ? AVATAR_TYPE_MESSAGE : UPLOAD_TYPE_MESSAGE;
  }
  if (!Number.isSafeInteger(size) || size <= 0) return 'That file is empty.';
  if (size > maxBytesFor(purpose, contentType)) return uploadSizeMessage(purpose, contentType);
  return null;
}

/**
 * A readable message for a failed API response. Error bodies are parsed
 * defensively by the caller (a platform-level 413 or 502 is HTML, not JSON),
 * so `data` may be null here.
 */
export function responseErrorMessage(status, data, fallback = 'Something went wrong. Please try again.') {
  const serverMessage = data && typeof data.error === 'string' && data.error.trim() ? data.error : null;
  if (status === 413) return serverMessage || 'That file is too large.';
  if (serverMessage) return serverMessage;
  if (status === 401) return 'Your session has expired. Log in again.';
  if (status === 429) return 'Too many attempts. Please wait a few minutes and try again.';
  return fallback;
}

/**
 * "12.50" -> 1250. Null for anything that isn't a plain non-negative dollar
 * amount with at most two decimals ("1e3", "12.345", "-5", "" all fail) --
 * Math.round(Number(x) * 100) silently accepted all of those.
 */
export function dollarsToCents(input) {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const s = String(input).trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function centsToDollarsInput(cents) {
  return Number.isSafeInteger(cents) ? (cents / 100).toFixed(2) : '';
}

/**
 * The dashboard's "price to message you" input, in dollars, to what
 * /api/me/profile accepts: null (blank = the platform floor) or whole cents
 * inside the same bounds the server enforces.
 */
export function dmPriceCentsFromInput(input) {
  if (input === null || input === undefined || String(input).trim() === '') return { value: null };
  const cents = dollarsToCents(input);
  if (cents === null || cents < DM_PRICE_MIN_CENTS || cents > DM_PRICE_MAX_CENTS) {
    return {
      error: `Message price must be between $${centsToDollarsInput(DM_PRICE_MIN_CENTS)} and $${centsToDollarsInput(DM_PRICE_MAX_CENTS)}, or blank for the $${centsToDollarsInput(DM_PRICE_MIN_CENTS)} default.`,
    };
  }
  return { value: cents };
}

/** Null when the wallet may be saved (blank clears it), otherwise the reason. */
export function payoutWalletError(input) {
  const wallet = String(input ?? '').trim();
  if (!wallet) return null;
  return isAddress(wallet, { strict: false })
    ? null
    : 'Payout wallet must be a valid wallet address (0x followed by 40 hex characters).';
}

/**
 * The profile editor's draft, rebuilt from the saved record. Used on load AND
 * after every save: the server normalises what it stores (handle gets its
 * "@", tags are cleaned, the wallet is trimmed, the gate amount is clamped),
 * and an editor still showing what was typed rather than what was saved
 * invites the next save to fight the last one.
 *
 * Deliberately no `img` (the avatar is only ever set by the avatar upload
 * finalize route) and no `payoutMethod` (payouts are USDG only; the server
 * stores 'usdg' whatever is sent).
 */
export function draftFromCreator(creator) {
  return {
    name: creator?.name || '',
    handle: creator?.handle || '',
    bio: creator?.bio || '',
    tags: (Array.isArray(creator?.tags) ? creator.tags : []).join(', '),
    age: creator?.age ?? '',
    location: creator?.location || '',
    price: creator?.price || '',
    locked: !!creator?.locked,
    gateTokens: gateTokensOf(creator) || '',
    walletAddress: creator?.walletAddress || '',
    dmPrice: Number.isInteger(creator?.dmPriceCents) ? centsToDollarsInput(creator.dmPriceCents) : '',
    socials: {
      twitter: creator?.socials?.twitter || '',
      instagram: creator?.socials?.instagram || '',
      tiktok: creator?.socials?.tiktok || '',
      reddit: creator?.socials?.reddit || '',
      website: creator?.socials?.website || '',
    },
  };
}

/**
 * The /api/me/profile payload for a draft. Returns { fields } or { error }
 * for the one client-side check that needs a clear message before sending
 * (the server repeats every check regardless).
 */
export function profileFieldsFromDraft(draft) {
  const walletError = payoutWalletError(draft.walletAddress);
  if (walletError) return { error: walletError };
  const dm = dmPriceCentsFromInput(draft.dmPrice);
  if (dm.error) return { error: dm.error };
  const { dmPrice, ...rest } = draft;
  return {
    fields: {
      ...rest,
      walletAddress: String(draft.walletAddress || '').trim(),
      dmPriceCents: dm.value,
    },
  };
}

/** Label and colour class for a payout request's status. */
export function payoutStatusDisplay(status) {
  if (status === 'paid') return { label: 'Paid', className: 'text-green-400' };
  if (status === 'rejected') return { label: 'Declined', className: 'text-red-400' };
  return { label: 'Pending review', className: 'text-brand-gold' };
}

/**
 * Why a creator can't cash out right now, or null when they can. Mirrors the
 * server's rules (pages/api/credits/payout-request.js, lib/credits-store.js
 * requestPayout): only an active, non-demo creator; held while suspended;
 * never paid to a banned account.
 */
export function cashOutBlockedReason(creator, effectiveStatus) {
  if (!creator) return 'No creator profile.';
  if (effectiveStatus === 'banned') {
    return 'This account is banned. Its balance is frozen and is never paid out.';
  }
  if (effectiveStatus === 'suspended') {
    return 'Your balance and any pending cash-outs are held while your account is suspended. They are not paid until the suspension ends.';
  }
  if (creator.seed === true || creator.demo === true) return 'Demo profiles cannot cash out.';
  if (effectiveStatus !== 'active') return 'Cash-outs open once your creator account is approved.';
  return null;
}
