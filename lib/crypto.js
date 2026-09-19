import crypto from 'crypto';

// The live marketplace stores its data manifests in Vercel Blob at fixed,
// public-access paths (see lib/listings-store.js, lib/reports-store.js) --
// fine for public listing/profile data, but shipping addresses are a home
// address tied to a specific person's adult-content purchase history, which
// is a meaningfully more sensitive class of data. This encrypts just those
// fields at rest with a server-only key, so a leaked/guessed blob URL alone
// doesn't hand over plaintext addresses.

const ALGO = 'aes-256-gcm';

/**
 * Two separate keys, deliberately.
 *
 * Shipping addresses and 18 U.S.C. §2257 performer records are different
 * trust boundaries: one is a customer's delivery address, the other is a
 * named person's government ID and date of birth. Signing both with one
 * secret means a single leaked key exposes both sets, and rotating one
 * forces rotating the other. This codebase has made the coupled-secret
 * mistake before (SESSION_SECRET silently reusing the admin panel key --
 * see MEMORY.md), so the records key is its own from the start.
 */
const KEYS = {
  orders: 'ORDERS_ENCRYPTION_KEY',
  records: 'RECORDS_ENCRYPTION_KEY',
};

function getKey(which) {
  const envName = KEYS[which];
  const raw = process.env[envName];
  if (!raw) throw new Error(`${envName} is not set`);
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error(`${envName} must decode to exactly 32 bytes (base64 of a 256-bit key)`);
  return key;
}

function encrypt(which, plaintext) {
  if (plaintext == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(which), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(String(plaintext), 'utf8')), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join('.');
}

function decrypt(which, packed) {
  if (packed == null) return null;
  const [ivB64, tagB64, dataB64] = String(packed).split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed encrypted field');
  const decipher = crypto.createDecipheriv(ALGO, getKey(which), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return plaintext.toString('utf8');
}

export function encryptField(plaintext) {
  return encrypt('orders', plaintext);
}

export function decryptField(packed) {
  return decrypt('orders', packed);
}

/** §2257 performer records -- see lib/performer-records-store.js. */
export function encryptRecordField(plaintext) {
  return encrypt('records', plaintext);
}

export function decryptRecordField(packed) {
  return decrypt('records', packed);
}

/**
 * Binary (an ID document scan) rather than text. Base64 at the boundary so
 * the ciphertext fits the same packed string shape and a text column, but
 * the bytes are never round-tripped through a UTF-8 decode, which would
 * corrupt them.
 */
export function encryptRecordDocument(buffer) {
  if (buffer == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey('records'), iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decryptRecordDocument(packed) {
  if (packed == null) return null;
  const [ivB64, tagB64, dataB64] = String(packed).split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed encrypted document');
  const decipher = crypto.createDecipheriv(ALGO, getKey('records'), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
}

/**
 * null when the records key is usable, otherwise the reason it is not.
 *
 * Returns the reason rather than a boolean because "not set" and "set but
 * the wrong length" send you to two completely different places, and
 * collapsing them into false meant a malformed key reported itself as a
 * missing one.
 */
export function recordsEncryptionProblem() {
  try {
    getKey('records');
    return null;
  } catch (err) {
    return err.message;
  }
}

const ADDRESS_FIELDS = ['fullName', 'line1', 'line2', 'city', 'region', 'postalCode', 'country', 'phone'];

export function encryptShippingAddress(address) {
  if (!address) return null;
  const out = {};
  for (const key of ADDRESS_FIELDS) {
    if (address[key]) out[key] = encryptField(address[key]);
  }
  return out;
}

export function decryptShippingAddress(encrypted) {
  if (!encrypted) return null;
  const out = {};
  for (const key of ADDRESS_FIELDS) {
    if (encrypted[key]) out[key] = decryptField(encrypted[key]);
  }
  return out;
}
