/**
 * The API's reply serializer (index.ts app.setReplySerializer). Fastify's
 * default is JSON.stringify, which THROWS on a BigInt -- and money columns
 * here are BigInt (Deposit.usdCents/feeCents, LedgerEntry.amountCents,
 * Account balances). A route that returned a row without mapping every one
 * of them answered 500 exactly when it had data: /wallet/deposits for any fan
 * with a deposit, /tips/received for any creator who had been tipped. Fixing
 * them one route at a time kept missing the next column, so every reply goes
 * through this instead.
 *
 * A BigInt within Number's safe range becomes a number (cents, block numbers,
 * raw token units under 2^53 -- what every client already expects); anything
 * larger becomes a decimal string rather than silently losing precision.
 */
export function bigintSafeReplacer(_key: string, value: unknown) {
  if (typeof value !== 'bigint') return value;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : value.toString();
}

export function serializeReply(payload: unknown): string {
  return JSON.stringify(payload, bigintSafeReplacer);
}
