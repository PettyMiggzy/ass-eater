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
 * NOT LIVE YET, and deliberately honest about it. A balance check needs two
 * things that do not exist: a deployed $ONLYONE contract, and a way for a
 * fan to prove they control the address they are claiming (typing an address
 * into a box proves nothing -- anyone can paste a whale's). So
 * tokenGateLive() is false until NEXT_PUBLIC_ONLYONE_TOKEN_ADDRESS is set,
 * and every surface says "unlocks when $ONLYONE launches" rather than
 * offering a button that cannot work. Same pattern as the AgeChecker
 * integration before its credentials existed.
 */

/** Nobody sensibly gates on more than this, and it stops a fat finger from setting an unreachable bar. */
export const MAX_GATE_TOKENS = 1_000_000_000;

export function tokenGateLive() {
  return !!process.env.NEXT_PUBLIC_ONLYONE_TOKEN_ADDRESS;
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
  return !!creator?.locked && sanitizeGateTokens(creator?.gateTokens) > 0;
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
 * `heldTokens` is whatever a verified balance check returned; null means no
 * verified wallet. There is deliberately no code path here that trusts a
 * self-reported number.
 */
export function tokenGateDecision(creator, heldTokens = null) {
  if (!isTokenGated(creator)) return { allowed: true, reason: 'not_gated' };
  if (!tokenGateLive()) return { allowed: false, reason: 'not_live', required: gateTokensOf(creator) };
  if (heldTokens === null) return { allowed: false, reason: 'no_wallet', required: gateTokensOf(creator) };
  const required = gateTokensOf(creator);
  return heldTokens >= required
    ? { allowed: true, reason: 'holds_enough', required, held: heldTokens }
    : { allowed: false, reason: 'holds_too_few', required, held: heldTokens };
}
