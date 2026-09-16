import crypto from 'crypto';

// The live marketplace stores its data manifests in Vercel Blob at fixed,
// public-access paths (see lib/listings-store.js, lib/reports-store.js) --
// fine for public listing/profile data, but shipping addresses are a home
// address tied to a specific person's adult-content purchase history, which
// is a meaningfully more sensitive class of data. This encrypts just those
// fields at rest with a server-only key, so a leaked/guessed blob URL alone
// doesn't hand over plaintext addresses.

const ALGO = 'aes-256-gcm';

function getKey() {
  const raw = process.env.ORDERS_ENCRYPTION_KEY;
  if (!raw) throw new Error('ORDERS_ENCRYPTION_KEY is not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('ORDERS_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 of a 256-bit key)');
  return key;
}

export function encryptField(plaintext) {
  if (plaintext == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decryptField(packed) {
  if (packed == null) return null;
  const [ivB64, tagB64, dataB64] = String(packed).split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed encrypted field');
  const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return plaintext.toString('utf8');
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
