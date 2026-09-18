import { publicClient } from './chain';
import { redis } from './redis';
import { parseAbi, type Address } from 'viem';
import { computePoolId, poolStateSlot, decodeSlot0 } from './v4-pool-state';

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
  const [sqrtP] = await publicClient.readContract({ address: process.env.ONLYASS_POOL as Address, abi: univ3Abi, functionName: 'slot0' });
  const dec0 = Number(process.env.ONLYASS_POOL_TOKEN0_DECIMALS), dec1 = Number(process.env.ONLYASS_POOL_TOKEN1_DECIMALS);
  const priceInQuote = priceFromSqrtX96(sqrtP, dec0, dec1, process.env.ONLYASS_IS_TOKEN0 === 'true');
  const quoteUsd = process.env.ONLYASS_POOL_QUOTE === 'WETH' ? await ethUsd() : 1;
  return priceInQuote * quoteUsd;
}

/**
 * V4: there's no per-pool contract -- state lives packed in the singleton
 * PoolManager, read via extsload(). Robinhood Chain's launch platforms
 * (pools.trade, Bags.fm's graduation, and reportedly Kekfun.xyz) land tokens
 * here, not in V3 pools, so this is very likely the real path once $ONLYASS
 * is live. See lib/v4-pool-state.ts for the storage-layout math, ported
 * directly from v4-core's StateLibrary.sol.
 */
async function assUsdV4(): Promise<number> {
  const currency0 = process.env.ONLYASS_V4_CURRENCY0 as Address;
  const currency1 = process.env.ONLYASS_V4_CURRENCY1 as Address;
  const fee = Number(process.env.ONLYASS_POOL_FEE ?? 3000);
  const tickSpacing = Number(process.env.ONLYASS_V4_TICK_SPACING ?? 60);
  const hooks = (process.env.ONLYASS_V4_HOOKS as Address) ?? '0x0000000000000000000000000000000000000000';

  const poolId = computePoolId(currency0, currency1, fee, tickSpacing, hooks);
  const slot = poolStateSlot(poolId) as `0x${string}`;
  const data = await publicClient.readContract({ address: process.env.ONLYASS_V4_POOL_MANAGER as Address, abi: poolManagerAbi, functionName: 'extsload', args: [slot] });
  const { sqrtPriceX96 } = decodeSlot0(data);

  const dec0 = Number(process.env.ONLYASS_POOL_TOKEN0_DECIMALS), dec1 = Number(process.env.ONLYASS_POOL_TOKEN1_DECIMALS);
  const priceInQuote = priceFromSqrtX96(sqrtPriceX96, dec0, dec1, process.env.ONLYASS_IS_TOKEN0 === 'true');
  // Native ETH is currency address 0x0 in V4 (Bitquery's docs confirm this for pools.trade) -- treat that the same as a WETH quote.
  const quoteIsEth = process.env.ONLYASS_POOL_QUOTE === 'WETH' || (process.env.ONLYASS_IS_TOKEN0 === 'true' ? currency1 : currency0) === '0x0000000000000000000000000000000000000000';
  const quoteUsd = quoteIsEth ? await ethUsd() : 1;
  return priceInQuote * quoteUsd;
}

/** Your token's spot price. Pre-launch: set ONLYASS_PRICE_OVERRIDE. Defaults to V4 -- confirmed as Kekfun.xyz's (and every other Robinhood Chain launch platform's) actual pool type. Set ONLYASS_POOL_VERSION=v3 only if you know for certain the real pool isn't V4. */
async function assUsd(): Promise<number> {
  if (process.env.ONLYASS_PRICE_OVERRIDE) return Number(process.env.ONLYASS_PRICE_OVERRIDE);
  return process.env.ONLYASS_POOL_VERSION === 'v3' ? assUsdV3() : assUsdV4();
}

export async function getUsdPrice(asset: 'USDG' | 'ETH' | 'ONLYASS'): Promise<number> {
  if (asset === 'USDG') return 1;
  const cached = await redis.get(`px:${asset}`);
  if (cached) return Number(cached);
  const px = asset === 'ETH' ? await ethUsd() : await assUsd();
  if (!Number.isFinite(px) || px <= 0) throw new Error('bad_price');
  await redis.set(`px:${asset}`, px, 'EX', 30);
  return px;
}

export const rawToUsdCents = (raw: bigint, decimals: number, px: number) =>
  BigInt(Math.floor((Number(raw) / 10 ** decimals) * px * 100));
