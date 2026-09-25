/**
 * Token-gated creators: hold $ONLYONE to see this profile.
 *
 * This is the token's second real job after the VIP burn, and it is the one
 * that scales, because the creator sets it and then markets it. Nobody has
 * to be persuaded by the platform to want the token if the person they came
 * for is the one asking.
 *
 * It obeys the rule in lib/brand.js: HOLD, never spend. Nothing is
 * transferred, nothing is charged, no balance moves. The check is "does this
 * wallet hold at least N" and the answer changes by itself when they buy or
 * sell. A fan who unlocks a creator this way has paid nobody -- which is
 * exactly why it isn't a payment.
 *
 * HOW IT IS ENFORCED (lib/holder-access.js + pages/api/token-gate/*):
 * a fan signs a one-time server nonce with their wallet (proof they control
 * the address -- typing an address into a box proves nothing, anyone can
 * paste a whale's), the server reads balanceOf/decimals of
 * NEXT_PUBLIC_ONLYONE_TOKEN_ADDRESS on its OWN RPC, and issues a short-lived
 * signed `oa_holder` cookie. Pages and the media route then decide
 * server-side, through holderCanView(), whether a gated creator's media srcs
 * are sent at all. Nothing on the client can report a balance. Before that
 * existed the gate was a CSS blur over full-resolution URLs in page props,
 * and no holder had any way in.
 *
 * This file stays PURE (no pg, no node crypto, no viem) so client-rendered
 * pages can import it.
 */

/** Nobody sensibly gates on more than this, and it stops a fat finger from setting an unreachable bar. */
export const MAX_GATE_TOKENS = 1_000_000_000;

/**
 * The $ONLYONE contract exists (build-time public env). Client-safe. The
 * server additionally needs an RPC to read balances -- see
 * holderVerificationLive() in lib/holder-access.js; a gate whose verifier is
 * not configured stays closed to everyone but the owner/admin rather than
 * opening.
 */
export function tokenGateLive() {
  return !!process.env.NEXT_PUBLIC_ONLYONE_TOKEN_ADDRESS;
}

/** Cookie holding the server-signed proof of a wallet's $ONLYONE holding. */
export const HOLDER_COOKIE_NAME = 'oa_holder';
/** One-time challenge cookie for the holder proof (separate from every other wallet flow). */
export const HOLDER_NONCE_COOKIE_NAME = 'oa_holder_nonce';

/**
 * Whole-token counts are compared as BigInt: a balance is an on-chain
 * integer that can exceed Number's safe range, and rounding one down (or up)
 * into a threshold would be a gate that lets the wrong people in. Returns
 * null for anything that is not a non-negative integer.
 */
export function toWholeTokens(value) {
  try {
    if (typeof value === 'bigint') return value >= 0n ? value : null;
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
    if (typeof value === 'string' && /^[0-9]{1,78}$/.test(value)) return BigInt(value);
  } catch {
    // fall through
  }
  return null;
}

export function sanitizeGateTokens(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_GATE_TOKENS);
}

/**
 * Is this creator actually gated?
 *
 * Requires BOTH the flag and a real threshold. `locked` on its own used to
 * mean "blur this card", was set on every new signup, and meant a real
 * creator's photos were blurred behind a button that went nowhere. A gate
 * with no number is not a gate.
 */
export function isTokenGated(creator) {
  return gateConfigured(creator) && gateEnforceable(creator);
}

/**
 * The raw setting: flag AND threshold, nothing else. This -- not
 * isTokenGated -- is what ENFORCEMENT reads (the /api/media holder check,
 * holderGateState, tokenGateDecision, and which srcs toPublicCreator
 * withholds), so enforcement fails CLOSED: a gated creator who somehow also
 * carries a non-/api/media src (legacy data, an admin-set path) still has
 * every private upload held back. isTokenGated is for DISPLAY only -- whether
 * to show the gate badge and padlocks -- and says no when a gate could not
 * hold everything back.
 */
export function gateConfigured(creator) {
  return !!creator?.locked && sanitizeGateTokens(creator?.gateTokens) > 0;
}

/**
 * Whether a gate on this creator could actually hold anything back. The gate
 * is enforced where files are served: /api/media/<pathname> checks the
 * holder per request, and the public projection withholds srcs. A file under
 * /images/ or /videos/ (every seed/demo creator's) is served straight from
 * /public, its name is in the repo, and no holder check ever sees the
 * request -- so a "gate" there showed padlocks and a connect-wallet flow over
 * content anyone could load directly. Such a creator is not SHOWN as gated
 * (isTokenGated above), and the profile APIs refuse to switch a gate on for
 * them (gateUnenforceableReason). The platform's demo profiles are never
 * gateable either. Enforcement does not read this (see gateConfigured).
 */
export function gateEnforceable(creator) {
  if (!creator) return false;
  if (creator.seed === true || creator.demo === true) return false;
  const srcs = [
    ...(Array.isArray(creator.gallery) ? creator.gallery.map((item) => item && item.src) : []),
    creator.video,
  ];
  return !srcs.some((src) => typeof src === 'string' && src !== '' && !src.startsWith('/api/media/'));
}

/** Refusal text for turning a gate on that could not be enforced, or null. */
export function gateUnenforceableReason(creator) {
  if (gateEnforceable(creator)) return null;
  return creator && (creator.seed === true || creator.demo === true)
    ? "Nothing was saved -- demo profiles can't be token-gated."
    : "Nothing was saved -- this profile has media served as public site files, which a token gate can't hold back. Only uploaded media can be gated.";
}

/**
 * For the profile APIs: does this save switch on (or change) a gate that
 * could not be enforced? Only when the request itself sets `locked` or
 * `gateTokens` -- an unchanged echo from the panel never blocks an unrelated
 * edit (a moderation save must still go through).
 */
export function refusesUnenforceableGate(existing, patch) {
  if (!('locked' in patch) && !('gateTokens' in patch)) return null;
  const next = { ...existing, ...patch };
  const wantsGate = !!next.locked && sanitizeGateTokens(next.gateTokens) > 0;
  if (!wantsGate) return null;
  const changed = !!next.locked !== !!existing?.locked
    || sanitizeGateTokens(next.gateTokens) !== sanitizeGateTokens(existing?.gateTokens);
  return changed ? gateUnenforceableReason(next) : null;
}

export function gateTokensOf(creator) {
  return sanitizeGateTokens(creator?.gateTokens);
}

/** "2,500,000 $ONLYONE" -- the same phrasing everywhere it's shown. */
export function formatGate(creator) {
  const n = gateTokensOf(creator);
  return n > 0 ? `${n.toLocaleString()} $ONLYONE` : '';
}

/**
 * Whether a viewer gets in. Returns a reason rather than a bare boolean so
 * the caller can say WHY -- "not live yet" and "you don't hold enough" are
 * very different messages to show someone.
 *
 * `heldTokens` is the whole-token balance a SERVER-SIDE verified check
 * returned (number, bigint or decimal string); null means no verified
 * wallet. There is deliberately no code path here that trusts a
 * self-reported number -- callers get it from lib/holder-access.js.
 */
export function tokenGateDecision(creator, heldTokens = null) {
  if (!gateConfigured(creator)) return { allowed: true, reason: 'not_gated' };
  const required = gateTokensOf(creator);
  if (!tokenGateLive()) return { allowed: false, reason: 'not_live', required };
  const held = heldTokens === null || heldTokens === undefined ? null : toWholeTokens(heldTokens);
  if (held === null) return { allowed: false, reason: 'no_wallet', required };
  return held >= BigInt(required)
    ? { allowed: true, reason: 'holds_enough', required, held: held.toString() }
    : { allowed: false, reason: 'holds_too_few', required, held: held.toString() };
}

/**
 * The exact text a fan's wallet signs to prove it holds $ONLYONE. Built by
 * the server from ITS OWN host header and nonce, never from client text, and
 * deliberately different from the owner-login and deposit messages so a
 * signature for one flow can never be replayed into another. It says plainly
 * that nothing moves: wallets show this verbatim.
 */
export function holderProofMessage({ host, nonce }) {
  return [
    `OnlyOne — verify your $ONLYONE holding`,
    ``,
    `Site: ${host}`,
    `Nonce: ${nonce}`,
    ``,
    `Signing this proves you control this wallet so OnlyOne can read its $ONLYONE balance.`,
    `It does not move any funds and does not approve any transaction.`,
  ].join('\n');
}
