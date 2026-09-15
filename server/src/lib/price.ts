import { publicClient } from './chain';
import { redis } from './redis';
import { parseAbi, type Address } from 'viem';

const chainlinkAbi = parseAbi(['function latestRoundData() view returns (uint80,int256 answer,uint256,uint256 updatedAt,uint80)']);
const univ3Abi = parseAbi(['function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)']);

async function ethUsd(): Promise<number> {
  const [, answer, , updatedAt] = await publicClient.readContract({ address: process.env.CHAINLINK_ETH_USD as Address, abi: chainlinkAbi, functionName: 'latestRoundData' });
  if (Date.now() / 1000 - Number(updatedAt) > 3600) throw new Error('stale_oracle');
  return Number(answer) / 1e8;
}

/** Your token: Uniswap V3 pool spot price. Pre-launch: set ONLYASS_PRICE_OVERRIDE. */
async function assUsd(): Promise<number> {
  if (process.env.ONLYASS_PRICE_OVERRIDE) return Number(process.env.ONLYASS_PRICE_OVERRIDE);
  const [sqrtP] = await publicClient.readContract({ address: process.env.ONLYASS_POOL as Address, abi: univ3Abi, functionName: 'slot0' });
  const dec0 = Number(process.env.ONLYASS_POOL_TOKEN0_DECIMALS), dec1 = Number(process.env.ONLYASS_POOL_TOKEN1_DECIMALS);
  const ratio = (Number(sqrtP) / 2 ** 96) ** 2 * 10 ** (dec0 - dec1);          // token1 per token0
  const assIsToken0 = process.env.ONLYASS_IS_TOKEN0 === 'true';
  const priceInQuote = assIsToken0 ? ratio : 1 / ratio;
  const quoteUsd = process.env.ONLYASS_POOL_QUOTE === 'WETH' ? await ethUsd() : 1;
  return priceInQuote * quoteUsd;
}

export async function getUsdPrice(asset: 'USDC' | 'ETH' | 'ONLYASS'): Promise<number> {
  if (asset === 'USDC') return 1;
  const cached = await redis.get(`px:${asset}`);
  if (cached) return Number(cached);
  const px = asset === 'ETH' ? await ethUsd() : await assUsd();
  if (!Number.isFinite(px) || px <= 0) throw new Error('bad_price');
  await redis.set(`px:${asset}`, px, 'EX', 30);
  return px;
}

export const rawToUsdCents = (raw: bigint, decimals: number, px: number) =>
  BigInt(Math.floor((Number(raw) / 10 ** decimals) * px * 100));
