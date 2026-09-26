import { encodeFunctionData, parseAbi, type Address } from 'viem';
import { prisma } from '../lib/prisma.js';
import { publicClient, treasuryAccount, treasuryWallet, withTreasuryLock, TOKENS, DECIMALS, HEDGE_STABLE, erc20Abi, envInt, assertStableDecimals, sendTreasuryTx, resolveTreasuryTx, treasurySigningPaused } from '../lib/chain.js';
import { impactBpsOf, hedgeRemaining } from './treasury-hedge-math.js';
import { applyHedge, failHedge, HEDGE_BPS } from '../core/treasury-inflight.js';
import { isStopping } from './process-guards.js';
import { treasuryOutflow } from '../lib/outflow-journal.js';

// Fans can deposit $ONLYONE to burn for VIP (core/vip.ts). That balance is
// booked in fixed USD cents at the price on the day it arrived, but the tokens
// backing it are volatile -- if $ONLYONE drops before the platform does
// anything with them, the treasury is short against a liability it recorded in
// dollars. This worker converts most of each new deposit into the stablecoin
// right away, keeping a slice as intentional token exposure, and caps trade
// size so it doesn't crater its own early, thin liquidity in the process.
//
// No-ops entirely until UNISWAP_V3_ROUTER_ADDRESS / UNISWAP_V3_QUOTER_ADDRESS /
// ONLYONE_POOL are set -- i.e. until $ONLYONE actually has a live market.

// HEDGE_BPS (TREASURY_HEDGE_BPS): % of new $ONLYONE converted to stablecoin;
// the rest stays as treasury exposure. Defined in core/treasury-inflight.ts,
// which also settles a batch for the admin route.
const MAX_IMPACT_BPS = envInt('TREASURY_HEDGE_MAX_IMPACT_BPS', 300, 0, 10_000); // max acceptable price impact per swap
const INTERVAL_MS = envInt('TREASURY_HEDGE_INTERVAL_MS', 300_000, 10_000);
const POOL_FEE = envInt('ONLYONE_POOL_FEE', 3000, 1, 1_000_000); // Uniswap V3 fee tier (hundredths of a bip)
const ROUTER = process.env.UNISWAP_V3_ROUTER_ADDRESS as Address | undefined;
const QUOTER = process.env.UNISWAP_V3_QUOTER_ADDRESS as Address | undefined;
// Outflow caps, env-sourced like the payout worker's (workers/payout-worker.ts
// outflowLimitReason). What this loop sells is sized from Deposit rows, which
// any .env holder can INSERT, and the treasury wallet is also the founder's
// own token bag -- so one swap never sells more than TREASURY_HEDGE_BATCH_MAX_CENTS
// worth (by the quote's stablecoin out), and the rolling 24h total, counted
// in the restart-proof outflow journal (lib/outflow-journal.ts), never more
// than TREASURY_HEDGE_DAILY_MAX_CENTS. No journal, no swap.
//
// The dollar cap alone does not bound what the treasury LOSES, which is
// tokens: its dollar figure comes from the quote of the pool being sold
// into, so with that pool's price depressed (or pushed down on purpose, which
// also moves the spot the impact check compares against) a huge number of
// tokens fits under it. The tokens going IN are capped as well, in whole
// $ONLYONE, per swap and per rolling 24h, in the same journal.
const BATCH_MAX_CENTS = envInt('TREASURY_HEDGE_BATCH_MAX_CENTS', 200_000, 1);
const DAILY_MAX_CENTS = envInt('TREASURY_HEDGE_DAILY_MAX_CENTS', 1_000_000, 1);
const BATCH_MAX_TOKENS = envInt('TREASURY_HEDGE_BATCH_MAX_TOKENS', 5_000_000, 1);    // 0.5% of a 1B supply
const DAILY_MAX_TOKENS = envInt('TREASURY_HEDGE_DAILY_MAX_TOKENS', 20_000_000, 1);   // 2% of a 1B supply

/** Whole tokens (rounded UP, so a sale is never under-counted) in `raw` units of a `decimals` token. */
export function wholeTokensUp(raw: bigint, decimals: number): number {
  const unit = 10n ** BigInt(decimals);
  return Number((raw + unit - 1n) / unit);
}

/**
 * Raw token units a hedge may still sell right now: the smaller of the
 * per-swap cap and what is left of the rolling 24h cap. Throws if the
 * journal is unavailable (the caller then sells nothing).
 */
export function hedgeTokenRoomRaw(journal: { sumSince(kind: 'hedge_tokens'): number }, decimals: number, batchMax = BATCH_MAX_TOKENS, dailyMax = DAILY_MAX_TOKENS): bigint {
  const whole = Math.min(batchMax, dailyMax - journal.sumSince('hedge_tokens'));
  return whole > 0 ? BigInt(whole) * 10n ** BigInt(decimals) : 0n;
}

const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
]);
const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)',
]);
const univ3Abi = parseAbi(['function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)']);

/** Same math as lib/price.ts's assUsd(), but in the pool's own quote token (not necessarily USD). */
async function spotPrice(): Promise<number> {
  const [sqrtP] = await publicClient.readContract({ address: process.env.ONLYONE_POOL as Address, abi: univ3Abi, functionName: 'slot0' });
  const dec0 = Number(process.env.ONLYONE_POOL_TOKEN0_DECIMALS), dec1 = Number(process.env.ONLYONE_POOL_TOKEN1_DECIMALS);
  const ratio = (Number(sqrtP) / 2 ** 96) ** 2 * 10 ** (dec0 - dec1);
  return process.env.ONLYONE_IS_TOKEN0 === 'true' ? ratio : 1 / ratio;
}

/** Quote the trade and shrink it until price impact vs spot is under the cap. Returns null if even a small slice is too much for the pool right now. */
async function sizeSwap(desiredRaw: bigint, spot: number): Promise<{ amountIn: bigint; amountOut: bigint; amountOutMin: bigint; impactBps: number } | null> {
  let amountIn = desiredRaw;
  for (let i = 0; i < 5 && amountIn > 0n; i++) {
    const { result } = await publicClient.simulateContract({
      address: QUOTER!, abi: quoterAbi, functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: TOKENS.ONLYONE.address, tokenOut: HEDGE_STABLE.address, amountIn, fee: POOL_FEE, sqrtPriceLimitX96: 0n }],
    });
    const [amountOut] = result as unknown as [bigint, bigint, number, bigint];
    const impactBps = impactBpsOf(amountIn, amountOut, spot, DECIMALS.ONLYONE, HEDGE_STABLE.decimals);
    if (impactBps <= MAX_IMPACT_BPS) return { amountIn, amountOut, amountOutMin: (amountOut * 99n) / 100n, impactBps };
    amountIn = amountIn / 2n; // pool's thin at this size -- try half, re-quote against it
  }
  return null;
}

/**
 * Settles a swap a previous cycle left PENDING (signed, persisted, maybe
 * broadcast). True when nothing is in flight any more. A receipt wait that
 * timed out used to leave nothing recorded at all, so the next cycle sold
 * the same deposits' tokens again.
 */
export async function settleInFlightHedge(client = publicClient as any): Promise<boolean> {
  const b = await prisma.treasuryHedgeBatch.findFirst({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' } });
  if (!b) return true;
  // Judged against the key that signed it (see token-burn.ts settleInFlightBurn).
  const r = await resolveTreasuryTx(b.txHash as `0x${string}`, b.nonce, client, undefined, b.signerAddress);
  if (r.state === 'success') { await applyHedge(b.id, BigInt(b.onlyOneRawIn)); return true; }
  if (r.state === 'reverted' || r.state === 'dropped') {
    await failHedge(b.id);
    console.error(`treasury-hedge: swap ${b.txHash} ${r.state}; nothing sold`);
    return true;
  }
  // A rotated-out (or unrecorded) signer never resolves here; an admin
  // closes it after checking the explorer (POST /admin/treasury-tx/hedge/<id>/resolve).
  console.warn(`treasury-hedge: swap ${b.txHash} still unsettled; not starting another (admin: POST /admin/treasury-tx/hedge/${b.id}/resolve if it was signed by a rotated-out key)`);
  return false;
}

async function sweep() {
  if (!ROUTER || !QUOTER || !process.env.ONLYONE_POOL) return;
  // The stablecoin side of every quote and impact figure uses HEDGE_STABLE.decimals.
  await assertStableDecimals();
  if (!(await settleInFlightHedge())) return;
  // Settle only while stopping or during a key rotation (see token-burn.ts).
  if (isStopping() || treasurySigningPaused()) return;

  const pending = await prisma.deposit.findMany({ where: { asset: 'ONLYONE', hedgedAt: null }, orderBy: { createdAt: 'asc' } });
  if (!pending.length) return;
  // What is still owed to the hedge: each deposit's target less what earlier
  // swaps already sold for it (Deposit.hedgedRaw). Selling the full target
  // again every cycle is what kept draining the treasury's own tokens when a
  // deposit was bigger than one impact-capped slice.
  let desiredRaw = pending.reduce((s, d) => s + hedgeRemaining(d, HEDGE_BPS), 0n);
  // Never more than the treasury wallet actually holds. This caps the swap at
  // the WHOLE wallet balance, not at the deposit tokens already swept into
  // it: deposits are not tracked per sweep, so a deposit whose tokens are
  // still at the fan's deposit address is hedged out of whatever else the
  // wallet holds -- including the founder's own tokens, since the treasury
  // wallet is also his. Keep hedging off (no ONLYONE_POOL / router) unless
  // that is acceptable, or add per-deposit sweep tracking first.
  const held = await publicClient.readContract({ address: TOKENS.ONLYONE.address, abi: erc20Abi, functionName: 'balanceOf', args: [treasuryAccount().address] });
  if (held < desiredRaw) desiredRaw = held;
  if (desiredRaw <= 0n) return;

  let used: number, tokenRoom: bigint;
  try { used = treasuryOutflow.sumSince('hedge'); tokenRoom = hedgeTokenRoomRaw(treasuryOutflow, DECIMALS.ONLYONE); } catch (e) {
    console.error('treasury-hedge: outflow journal unavailable, not selling', (e as Error).message);
    return;
  }
  const roomCents = Math.min(BATCH_MAX_CENTS, DAILY_MAX_CENTS - used);
  if (roomCents <= 0) { console.warn('treasury-hedge: outflow cap reached (TREASURY_HEDGE_*_MAX_CENTS); retrying later'); return; }
  if (tokenRoom <= 0n) { console.warn('treasury-hedge: token outflow cap reached (TREASURY_HEDGE_*_MAX_TOKENS); retrying later'); return; }
  // Tokens in first: every later step (sizing for impact, scaling to the
  // dollar room) only ever shrinks amountIn, so this bound holds for the swap.
  if (desiredRaw > tokenRoom) desiredRaw = tokenRoom;

  const spot = await spotPrice();
  let sized = await sizeSwap(desiredRaw, spot);
  if (!sized) { console.warn('treasury-hedge: pool too thin for even a small slice, retrying next cycle'); return; }
  // Over the room left: shrink in proportion to the quote and re-quote (a
  // smaller trade gets a slightly better price, so it stays under).
  const outCents = (raw: bigint) => Number((raw * 100n) / 10n ** BigInt(HEDGE_STABLE.decimals));
  if (outCents(sized.amountOut) > roomCents) {
    const scaled = (sized.amountIn * BigInt(roomCents)) / BigInt(Math.max(1, outCents(sized.amountOut)));
    sized = scaled > 0n ? await sizeSwap(scaled, spot) : null;
    if (!sized || outCents(sized.amountOut) > roomCents) { console.warn('treasury-hedge: could not size a swap under the outflow cap; retrying later'); return; }
  }

  if (isStopping() || treasurySigningPaused()) return;
  const allowance = await publicClient.readContract({ address: TOKENS.ONLYONE.address, abi: erc20Abi, functionName: 'allowance', args: [treasuryAccount().address, ROUTER] });
  if (allowance < sized.amountIn) {
    const h = await withTreasuryLock(() => treasuryWallet().writeContract({ address: TOKENS.ONLYONE.address, abi: erc20Abi, functionName: 'approve', args: [ROUTER, sized.amountIn * 10n] }));
    await publicClient.waitForTransactionReceipt({ hash: h });
  }

  const recipient = treasuryAccount().address;
  const data = encodeFunctionData({
    abi: routerAbi, functionName: 'exactInputSingle',
    args: [{ tokenIn: TOKENS.ONLYONE.address, tokenOut: HEDGE_STABLE.address, fee: POOL_FEE, recipient, amountIn: sized.amountIn, amountOutMinimum: sized.amountOutMin, sqrtPriceLimitX96: 0n }],
  });
  // The batch row exists (PENDING, with the hash) before the swap is
  // broadcast, so a timeout or restart leaves something to settle instead
  // of a swap the next cycle cannot see.
  if (isStopping() || treasurySigningPaused()) return;
  const hash = await sendTreasuryTx({ to: ROUTER, data }, async (h, nonce, signer) => {
    // Counted before anything is persisted or broadcast (see above).
    treasuryOutflow.record('hedge', outCents(sized!.amountOut), h);
    treasuryOutflow.record('hedge_tokens', wholeTokensUp(sized!.amountIn, DECIMALS.ONLYONE), h);
    await prisma.treasuryHedgeBatch.create({ data: {
      depositCount: 0, onlyOneRawIn: sized!.amountIn.toString(), usdcRawOut: sized!.amountOut.toString(), priceImpactBps: Math.round(sized!.impactBps), txHash: h, nonce, signerAddress: signer, status: 'PENDING',
    } });
  });
  await publicClient.waitForTransactionReceipt({ hash }).catch(() => null);
  // The uncovered remainder of each deposit is intentional treasury exposure,
  // not a balance owed to anyone -- it just stays in the treasury wallet as-is.
  await settleInFlightHedge();
}

(async function loop() {
  for (;;) {
    try { await sweep(); } catch (e) { console.error('treasury-hedge', e); }
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
})().catch((e) => console.error('treasury-hedge: loop crashed', e));
