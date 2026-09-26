import { publicClient, envInt } from './chain.js';
import { redis } from './redis.js';
import { parseAbi, type Address } from 'viem';
import { computePoolId, poolStateSlot, decodeSlot0 } from './v4-pool-state.js';

const chainlinkAbi = parseAbi(['function latestRoundData() view returns (uint80,int256 answer,uint256,uint256 updatedAt,uint80)']);
const univ3Abi = parseAbi(['function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)']);
const poolManagerAbi = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)']);

async function ethUsd(): Promise<number> {
  const [, answer, , updatedAt] = await publicClient.readContract({ address: process.env.CHAINLINK_ETH_USD as Address, abi: chainlinkAbi, functionName: 'latestRoundData' });
  if (Date.now() / 1000 - Number(updatedAt) > 3600) throw new Error('stale_oracle');
  return Number(answer) / 1e8;
}

function priceFromSqrtX96(sqrtP: bigint | number, dec0: number, dec1: number, assIsToken0: boolean): number {
  const ratio = (Number(sqrtP) / 2 ** 96) ** 2 * 10 ** (dec0 - dec1); // token1 per token0
  return assIsToken0 ? ratio : 1 / ratio;
}

/** V3: the pool is its own contract, spot price is just slot0(). */
async function assUsdV3(): Promise<number> {
  const [sqrtP] = await publicClient.readContract({ address: process.env.ONLYONE_POOL as Address, abi: univ3Abi, functionName: 'slot0' });
  const dec0 = Number(process.env.ONLYONE_POOL_TOKEN0_DECIMALS), dec1 = Number(process.env.ONLYONE_POOL_TOKEN1_DECIMALS);
  const priceInQuote = priceFromSqrtX96(sqrtP, dec0, dec1, process.env.ONLYONE_IS_TOKEN0 === 'true');
  const quoteUsd = process.env.ONLYONE_POOL_QUOTE === 'WETH' ? await ethUsd() : 1;
  return priceInQuote * quoteUsd;
}

/**
 * V4: there's no per-pool contract -- state lives packed in the singleton
 * PoolManager, read via extsload(). Robinhood Chain's launch platforms
 * (pools.trade, Bags.fm's graduation, and reportedly Kekfun.xyz) land tokens
 * here, not in V3 pools, so this is very likely the real path once $ONLYONE
 * is live. See lib/v4-pool-state.ts for the storage-layout math, ported
 * directly from v4-core's StateLibrary.sol.
 */
async function assUsdV4(): Promise<number> {
  const currency0 = process.env.ONLYONE_V4_CURRENCY0 as Address;
  const currency1 = process.env.ONLYONE_V4_CURRENCY1 as Address;
  const fee = envInt('ONLYONE_POOL_FEE', 3000, 1, 1_000_000);
  const tickSpacing = envInt('ONLYONE_V4_TICK_SPACING', 60, 1, 32_767);
  const hooks = (process.env.ONLYONE_V4_HOOKS as Address) ?? '0x0000000000000000000000000000000000000000';

  const poolId = computePoolId(currency0, currency1, fee, tickSpacing, hooks);
  const slot = poolStateSlot(poolId) as `0x${string}`;
  const data = await publicClient.readContract({ address: process.env.ONLYONE_V4_POOL_MANAGER as Address, abi: poolManagerAbi, functionName: 'extsload', args: [slot] });
  const { sqrtPriceX96 } = decodeSlot0(data);

  const dec0 = Number(process.env.ONLYONE_POOL_TOKEN0_DECIMALS), dec1 = Number(process.env.ONLYONE_POOL_TOKEN1_DECIMALS);
  const priceInQuote = priceFromSqrtX96(sqrtPriceX96, dec0, dec1, process.env.ONLYONE_IS_TOKEN0 === 'true');
  // Native ETH is currency address 0x0 in V4 (Bitquery's docs confirm this for pools.trade) -- treat that the same as a WETH quote.
  const quoteIsEth = process.env.ONLYONE_POOL_QUOTE === 'WETH' || (process.env.ONLYONE_IS_TOKEN0 === 'true' ? currency1 : currency0) === '0x0000000000000000000000000000000000000000';
  const quoteUsd = quoteIsEth ? await ethUsd() : 1;
  return priceInQuote * quoteUsd;
}

/** Your token's spot price. Pre-launch: set ONLYONE_PRICE_OVERRIDE. Defaults to V4 -- confirmed as Kekfun.xyz's (and every other Robinhood Chain launch platform's) actual pool type. Set ONLYONE_POOL_VERSION=v3 only if you know for certain the real pool isn't V4. */
async function assUsd(): Promise<number> {
  const override = process.env.ONLYONE_PRICE_OVERRIDE?.trim();
  if (override) {
    const px = Number(override);
    // A junk override (e.g. a trailing '# comment' systemd kept) must fail
    // the price, not price every token at NaN.
    if (!Number.isFinite(px) || px <= 0) throw new Error('bad_price_override');
    return px;
  }
  return process.env.ONLYONE_POOL_VERSION === 'v3' ? assUsdV3() : assUsdV4();
}

export async function getUsdPrice(asset: 'STABLE' | 'ETH' | 'ONLYONE'): Promise<number> {
  // Every accepted stablecoin is a dollar by definition -- that is the whole
  // reason they are on the allowlist. No oracle, no staleness window.
  if (asset === 'STABLE') return 1;
  const cached = await redis.get(`px:${asset}`);
  if (cached) return Number(cached);
  const px = asset === 'ETH' ? await ethUsd() : await assUsd();
  if (!Number.isFinite(px) || px <= 0) throw new Error('bad_price');
  await redis.set(`px:${asset}`, px, 'EX', 30);
  return px;
}

/**
 * The price read straight from the oracle/pool, never from the shared Redis
 * cache. For anything that SIGNS with it (the automatic token burn's slippage
 * floor): Redis is reachable by every process on the box with no auth, so a
 * compromised media worker could SET `px:ONLYONE` to an absurd price and
 * drive a swap's minimum-out to ~0 for a sandwich. Display and deposit
 * pricing keep the cached getUsdPrice above.
 */
export async function getFreshUsdPrice(asset: 'STABLE' | 'ETH' | 'ONLYONE'): Promise<number> {
  if (asset === 'STABLE') return 1;
  const px = asset === 'ETH' ? await ethUsd() : await assUsd();
  if (!Number.isFinite(px) || px <= 0) throw new Error('bad_price');
  return px;
}

/**
 * Token units -> whole cents, floored, in integer arithmetic. The float
 * version (Number(raw) / 10**d * px * 100) landed just under the integer for
 * ~6% of exact-cent stablecoin amounts -- 1.15 USDG became 114 cents -- so
 * the ledger gross stopped reconciling with the chain. A dollar stablecoin
 * (px === 1) is exact; any other price is fixed to 8 decimal places first.
 */
const PX_SCALE = 10n ** 8n;
export function rawToUsdCents(raw: bigint, decimals: number, px: number): bigint {
  const unit = 10n ** BigInt(decimals);
  if (px === 1) return (raw * 100n) / unit;
  const pxScaled = BigInt(Math.round(px * 1e8));
  return (raw * pxScaled * 100n) / (unit * PX_SCALE);
}
