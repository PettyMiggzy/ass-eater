/**
 * Token-gate enforcement (server-only).
 *
 * A token-gated creator's media is only ever sent to:
 *   - the creator themselves (session),
 *   - an admin, but only on /api/media requests: the admin media cookie is
 *     Path=/api/media, so pages and /api/token-gate/status never see it and
 *     an admin viewing a gated profile page still gets locked tiles, or
 *   - a viewer holding a valid `oa_holder` cookie whose wallet's CURRENT
 *     $ONLYONE balance, read by this server from its own RPC, meets the
 *     creator's threshold.
 *
 * The `oa_holder` cookie is minted by POST /api/token-gate/verify only after
 * the wallet signed a one-time server nonce (proof of control) and the server
 * read balanceOf() itself. It is the FIFTH token type on the shared root
 * secret, so it gets its own derived key (context `oa:holder:v1`) and its own
 * `typ: 'holder_access'` -- the same two independent layers that stopped a
 * login cookie passing as an age-verification cookie. Any sixth token type
 * must do the same.
 *
 * Balance is re-read (briefly cached) on every decision rather than trusted
 * from the cookie for its whole hour, so "buy, verify, sell, keep watching"
 * only works for the cache window. If the RPC is down, the balance the server
 * itself read at verify time (inside the signed cookie) is used -- never
 * anything the client says. That fallback has to arrive quickly, since the
 * media route and page SSR both wait on it: the RPC client does not retry,
 * every read has a hard deadline, and a failure is remembered for a short
 * window so the next requests go straight to the fallback instead of each
 * waiting out the deadline again.
 *
 * Known limit: the pass is a bearer cookie bound to a wallet address, not to
 * a browser. Copying it to someone else works until it expires (1h) and only
 * while that wallet still holds enough. That is inherent to wallet gating (a
 * holder could equally sign challenges for friends); the 1h TTL and the
 * balance re-read are what bound it.
 */
import crypto from 'crypto';
import { createPublicClient, defineChain, http, getAddress, isAddress, erc20Abi } from 'viem';
import { parseCookies, getSessionUser } from './session';
import { ageVerificationSecret } from './age-verification';
import { hasAdminMediaSession } from './media';
import {
  HOLDER_COOKIE_NAME,
  isTokenGated,
  tokenGateDecision,
  tokenGateLive,
  toWholeTokens,
} from './token-gate';

export const HOLDER_TTL_SECONDS = 60 * 60;
const BALANCE_CACHE_MS = 60 * 1000;
// Per HTTP call. viem's http transport otherwise retries 3 times on a
// timeout, which turned an RPC outage into ~33s per read.
const RPC_TIMEOUT_MS = 3000;
// Hard cap on one whole balance read (decimals + balanceOf), whatever the reader does.
let rpcDeadlineMs = 4000;
// After a failed read, skip the chain for this long and use the fallback.
const RPC_DOWN_BACKOFF_MS = 20 * 1000;
const DEFAULT_CHAIN_ID = 4663;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function onlyOneTokenAddress() {
  const raw = process.env.NEXT_PUBLIC_ONLYONE_TOKEN_ADDRESS;
  return typeof raw === 'string' && isAddress(raw.trim(), { strict: false }) ? getAddress(raw.trim()) : null;
}

function rpcUrl() {
  return process.env.MARKETPLACE_RPC_URL || '';
}

/** Everything a real, server-side balance check needs is configured. */
export function holderVerificationLive() {
  return tokenGateLive() && !!onlyOneTokenAddress() && !!rpcUrl();
}

function chainId() {
  const n = Number(process.env.NEXT_PUBLIC_MARKETPLACE_CHAIN_ID || DEFAULT_CHAIN_ID);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_CHAIN_ID;
}

let cachedClient = null;
let cachedClientKey = '';
function publicClient() {
  const key = `${chainId()}|${rpcUrl()}`;
  if (cachedClient && cachedClientKey === key) return cachedClient;
  const chain = defineChain({
    id: chainId(),
    name: process.env.NEXT_PUBLIC_MARKETPLACE_CHAIN_NAME || 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: process.env.NEXT_PUBLIC_MARKETPLACE_CHAIN_NATIVE_SYMBOL || 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl()] } },
  });
  cachedClient = createPublicClient({ chain, transport: http(rpcUrl(), { timeout: RPC_TIMEOUT_MS, retryCount: 0 }) });
  cachedClientKey = key;
  return cachedClient;
}

/** A viem public client for the configured chain (used by verify for ERC-1271 wallets). */
export function holderChainClient() {
  return publicClient();
}

// ---------------------------------------------------------------------------
// On-chain balance (whole tokens), briefly cached
// ---------------------------------------------------------------------------

let decimalsCache = null; // { token, decimals }
const balanceCache = new Map(); // lowercased address -> { whole: bigint, at }
const MAX_BALANCE_CACHE = 5000;

async function defaultBalanceReader(address) {
  const token = onlyOneTokenAddress();
  if (!token) throw new Error('token not configured');
  const client = publicClient();
  if (!decimalsCache || decimalsCache.token !== token) {
    const d = Number(await client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }));
    if (!Number.isInteger(d) || d < 0 || d > 36) throw new Error('unexpected token decimals');
    decimalsCache = { token, decimals: d };
  }
  const raw = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [getAddress(address)] });
  return BigInt(raw) / 10n ** BigInt(decimalsCache.decimals);
}

let balanceReader = defaultBalanceReader;
let rpcDownUntil = 0;

/** Test hook: replace the on-chain reader (fn(address) -> whole-token bigint). Pass null to restore. */
export function __setHolderBalanceReaderForTests(fn) {
  balanceReader = fn || defaultBalanceReader;
  balanceCache.clear();
  rpcDownUntil = 0;
}

/** Test hook: shorten the per-read deadline (ms). Pass null to restore the default. */
export function __setHolderRpcDeadlineForTests(ms) {
  rpcDeadlineMs = ms == null ? 4000 : ms;
}

function withDeadline(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('balance read timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Whole-token $ONLYONE balance of `address`, read from the chain by this
 * server. `fresh` skips both caches (verify uses it). Throws on RPC failure,
 * on a read slower than the deadline, and -- without touching the chain, for
 * non-fresh reads -- while a recent failure is still inside its backoff.
 */
export async function readHolderBalance(address, { fresh = false } = {}) {
  if (!isAddress(String(address || ''), { strict: false })) throw new Error('bad address');
  const key = String(address).toLowerCase();
  const now = Date.now();
  const hit = balanceCache.get(key);
  if (!fresh && hit && now - hit.at < BALANCE_CACHE_MS) return hit.whole;
  // `fresh` (verify, which a person just clicked and which is rate-limited)
  // always makes a real, deadline-bounded attempt; background decisions skip
  // the chain while a recent failure is inside its backoff.
  if (!fresh && now < rpcDownUntil) throw new Error('rpc recently unavailable');
  let raw;
  try {
    raw = await withDeadline(Promise.resolve().then(() => balanceReader(address)), rpcDeadlineMs);
  } catch (err) {
    rpcDownUntil = Date.now() + RPC_DOWN_BACKOFF_MS;
    throw err;
  }
  rpcDownUntil = 0;
  const whole = toWholeTokens(raw);
  if (whole === null) throw new Error('unreadable balance');
  if (balanceCache.size >= MAX_BALANCE_CACHE) balanceCache.delete(balanceCache.keys().next().value);
  balanceCache.set(key, { whole, at: now });
  return whole;
}

// ---------------------------------------------------------------------------
// The oa_holder token
// ---------------------------------------------------------------------------

function holderKey() {
  return crypto.createHmac('sha256', String(ageVerificationSecret())).update('oa:holder:v1').digest();
}

export function createHolderToken({ address, balance }, now = Date.now()) {
  const whole = toWholeTokens(balance);
  if (!isAddress(String(address || ''), { strict: false }) || whole === null) throw new Error('bad holder token input');
  const payload = Buffer.from(
    JSON.stringify({
      typ: 'holder_access',
      addr: String(address).toLowerCase(),
      bal: whole.toString(),
      iat: now,
      exp: now + HOLDER_TTL_SECONDS * 1000,
    }),
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', holderKey()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** { address, balance (decimal string), exp } or null (missing, forged, wrong type, expired). */
export function readHolderToken(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 1024 || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  try {
    const want = crypto.createHmac('sha256', holderKey()).update(payload).digest();
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.typ !== 'holder_access') return null;
    if (typeof data.exp !== 'number' || !(data.exp > now)) return null;
    if (typeof data.addr !== 'string' || !/^0x[0-9a-f]{40}$/.test(data.addr)) return null;
    if (toWholeTokens(data.bal) === null) return null;
    return { address: data.addr, balance: data.bal, exp: data.exp };
  } catch {
    return null;
  }
}

export function readHolderPass(req) {
  return readHolderToken(parseCookies(req)[HOLDER_COOKIE_NAME]);
}

function secureAttr() {
  return process.env.NODE_ENV === 'production' ? '; Secure' : '';
}

export function holderCookieHeader(token) {
  return `${HOLDER_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${HOLDER_TTL_SECONDS}${secureAttr()}`;
}

export function clearHolderCookieHeader() {
  return `${HOLDER_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttr()}`;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/**
 * The verified holder's current whole-token balance, or null when there is no
 * valid pass (or verification is not configured). Re-reads the chain through
 * the short cache; on RPC failure falls back to the balance the server read
 * at verify time, which is inside the signed cookie.
 */
export async function verifiedHolderBalance(req) {
  if (!holderVerificationLive()) return null;
  const pass = readHolderPass(req);
  if (!pass) return null;
  try {
    return await readHolderBalance(pass.address);
  } catch (err) {
    console.warn('[holder-access] balance re-read failed, using verified pass value:', err && err.message);
    return toWholeTokens(pass.balance);
  }
}

function isOwnerOf(user, creator) {
  return !!user && user.role === 'creator' && user.creatorId != null && String(user.creatorId) === String(creator.id);
}

/**
 * Full gate decision for this viewer and creator, for pages that want to say
 * WHY (tokenGateDecision's reasons plus 'owner' / 'admin' /
 * 'verifier_unavailable'). 'admin' can only come back on /api/media requests
 * (the admin media cookie's Path); pages and status never see it. `user` may be passed when the caller already
 * loaded the session user, to save a lookup; pass `undefined` to have it read.
 */
export async function holderGateState(req, creator, { user } = {}) {
  if (!creator) return { allowed: false, reason: 'no_creator' };
  if (!isTokenGated(creator)) return { allowed: true, reason: 'not_gated' };
  const viewer = user === undefined ? await getSessionUser(req).catch(() => null) : user;
  if (isOwnerOf(viewer, creator)) return { allowed: true, reason: 'owner' };
  if (hasAdminMediaSession(req)) return { allowed: true, reason: 'admin' };
  if (tokenGateLive() && !holderVerificationLive()) {
    return { ...tokenGateDecision(creator, null), reason: 'verifier_unavailable' };
  }
  const held = await verifiedHolderBalance(req);
  return tokenGateDecision(creator, held);
}

/**
 * The one boolean pages pass to toPublicCreator(creator, { viewerMayUnlock })
 * in getServerSideProps, and the media route uses per request. True for an
 * ungated creator, the owner, an admin, or a verified holder with enough.
 */
export async function holderCanView(req, creator, opts = {}) {
  return (await holderGateState(req, creator, opts)).allowed === true;
}
