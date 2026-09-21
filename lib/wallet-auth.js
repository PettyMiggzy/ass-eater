// Proving you control a wallet, without a password.
//
// The owner lives in one of the 27 states his own site blocks, so he needs a
// way back in on every fresh browser and every domain (cookies are
// host-scoped). That was a typed key; this is the same thing with nothing to
// remember: connect the wallet, sign one message, you're in.
//
// THE POINT, and why this is not just a nicer login: typing an address into
// a box proves nothing at all -- anyone can paste anyone's address, and the
// obvious "just read their balance" version of token-gating is exactly that
// mistake. A SIGNATURE is proof, because only the private key can produce
// one. So this file is deliberately written as a general
// prove-you-own-this-address primitive rather than an owner-login helper:
// token-gating needs the identical step before it can read a fan's balance
// and mean it (see lib/token-gate.js, which has no way to trust an address
// today and is honest about it).
//
// Web Crypto, not Node's crypto, matching lib/age-verification.js -- so the
// same code could run in proxy.js's Edge runtime if a gate ever needs it.

export const WALLET_NONCE_COOKIE_NAME = 'oa_wallet_nonce';
// Separate cookie for the credits-deposit proof flow (see
// depositProofMessage below) so it can never collide with an in-progress
// owner-wallet login using the same generic nonce primitive.
export const DEPOSIT_NONCE_COOKIE_NAME = 'oa_deposit_nonce';

// Long enough to connect a wallet, unlock a phone and read the message;
// short enough that a signature scraped from anywhere is dead on arrival.
export const NONCE_TTL_SECONDS = 5 * 60;

function toBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(str.length + ((4 - (str.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// The FOURTH token type on the one root secret, so it gets its own derived
// key and its own `typ`, exactly like session / age-verification / preview.
// This is not ceremony: session and age-verification tokens were once
// byte-for-byte interchangeable, and copying a login cookie into the
// age-verification slot passed as proof of a real age check. Two independent
// layers fixed it and both are repeated here. Any fifth token type does the
// same or it is a bug waiting to happen.
async function hmacKey(secret) {
  const rootKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const derived = await crypto.subtle.sign('HMAC', rootKey, new TextEncoder().encode('oa:wallet-nonce:v1'));
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/**
 * Issues a one-time challenge, carried in a signed cookie rather than a
 * server-side store.
 *
 * It has to be stateless: these are serverless functions with no shared
 * memory, so a nonce written into one instance's map is simply absent when
 * the signature posts back to another. (lib/rate-limit.js has the same
 * constraint and is honest that it is per-instance; an auth challenge cannot
 * afford to be.)
 *
 * Binding it to a cookie is what makes it single-browser: a signature
 * captured anywhere else arrives without the matching cookie and fails, even
 * inside the five-minute window.
 */
export async function createWalletNonce(secret) {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const nonce = toBase64Url(bytes);
  const payload = toBase64Url(
    new TextEncoder().encode(JSON.stringify({ typ: 'wallet_nonce', nonce, exp: Date.now() + NONCE_TTL_SECONDS * 1000 })),
  );
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return { nonce, token: `${payload}.${toBase64Url(sig)}` };
}

export async function readWalletNonce(secret, token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify('HMAC', key, fromBase64Url(sig), new TextEncoder().encode(payload));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    if (data.typ !== 'wallet_nonce') return null;
    if (data.exp < Date.now()) return null;
    if (typeof data.nonce !== 'string' || !data.nonce) return null;
    return data.nonce;
  } catch {
    return null;
  }
}

/**
 * The exact text the wallet is asked to sign, and the exact text the server
 * re-derives before recovering a signer from it.
 *
 * It names the site, what signing means, and the nonce, all three on
 * purpose. A bare "sign this random string" prompt is how people get
 * phished, and a signature over text that names no site can be farmed on one
 * site and replayed on another -- so the host goes in the message and the
 * server builds the message from ITS OWN host header, never from anything
 * the client sends.
 *
 * It also says plainly that nothing moves. Wallets show this text verbatim,
 * and a signature request with no explanation is indistinguishable, to a
 * reasonable person, from one that drains them.
 */
export function walletSignInMessage({ host, nonce }) {
  return [
    `OnlyOne — sign in as owner`,
    ``,
    `Site: ${host}`,
    `Nonce: ${nonce}`,
    ``,
    `Signing this proves you control this wallet.`,
    `It does not move any funds and does not approve any transaction.`,
  ].join('\n');
}

/**
 * The credits-deposit variant of the message above. Same reasoning, same
 * shape (host + nonce baked in server-side, never trusted from the client) --
 * this is the "prove you sent this on-chain payment" case the file's own
 * header calls out as the other real use of this primitive: without it,
 * pages/api/credits/buy.js accepted a txHash from ANY logged-in caller with
 * no check on who actually sent it, so an attacker who spotted someone
 * else's real deposit land on-chain (the payout address is public, right
 * there in the client bundle) could submit that same hash to their own
 * account first and steal the credit. A signature over this message proves
 * the caller controls the address that has to match the transaction's own
 * sender -- something only the depositor's private key can produce.
 */
export function depositProofMessage({ host, nonce }) {
  return [
    `OnlyOne — verify your deposit wallet`,
    ``,
    `Site: ${host}`,
    `Nonce: ${nonce}`,
    ``,
    `Signing this proves you control the wallet you're paying from.`,
    `It does not move any funds and does not approve any transaction.`,
  ].join('\n');
}

/**
 * Addresses compare lowercased, never as given.
 *
 * EIP-55 checksumming means the same address legitimately appears in several
 * capitalisations -- what a wallet returns, what someone pastes from an
 * explorer, and what is typed into an env var are routinely different
 * strings for the same account. A case-sensitive comparison here would
 * reject the real owner depending on where he copied his address from, which
 * would look exactly like a broken signature.
 */
export function sameAddress(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function isAddressish(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

/**
 * The configured owner wallet, or null when there isn't one.
 *
 * Env rather than a constant in the source for one reason: this repo is on
 * GitHub, and while a wallet address is public on-chain anyway, committing
 * it publishes the link between the owner as a person and that account's
 * entire history. Same instinct that keeps the EIN, the legal name and the
 * registered address out of this repo.
 *
 * Unset means no wallet login exists -- the route 404s rather than falling
 * back to anything, so a fork or preview that doesn't inherit the variable
 * has no door instead of a guessable one. Same shape as OWNER_ACCESS_KEY.
 */
export function ownerWalletAddress() {
  const raw = process.env.OWNER_WALLET_ADDRESS;
  if (!raw || !isAddressish(raw)) return null;
  return raw.trim();
}
