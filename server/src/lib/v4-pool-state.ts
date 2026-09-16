import { AbiCoder, keccak256, concat, zeroPadValue, toBeHex } from 'ethers';

// Uniswap V4 has no per-pool contract to call slot0() on -- pool state lives
// packed into the singleton PoolManager's storage, read via extsload(). This
// mirrors v4-core's StateLibrary.sol exactly (verified against the real
// source, not reconstructed from memory): POOLS_SLOT = 6, pool state slot =
// keccak256(poolId ++ POOLS_SLOT), and the packed word's lowest 160 bits are
// sqrtPriceX96, next 24 tick (sign-extended), next 24 protocolFee, next 24 lpFee.
// Robinhood Chain's launch platforms (pools.trade, Bags.fm's graduation) both
// land tokens in V4 pools, not V3 -- this is the read path for that case.

const POOLS_SLOT = 6n;

/** PoolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks)) -- see v4-core's PoolId.toId(). */
export function computePoolId(currency0: string, currency1: string, fee: number, tickSpacing: number, hooks: string): string {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [currency0, currency1, fee, tickSpacing, hooks],
  );
  return keccak256(encoded);
}

/** The extsload() slot holding a pool's packed Slot0 word, per StateLibrary._getPoolStateSlot. */
export function poolStateSlot(poolId: string): string {
  const slotConst = zeroPadValue(toBeHex(POOLS_SLOT), 32);
  return keccak256(concat([poolId, slotConst]));
}

/** Unpacks the extsload'd word exactly as StateLibrary.getSlot0's assembly does. */
export function decodeSlot0(data: string): { sqrtPriceX96: bigint; tick: number; protocolFee: number; lpFee: number } {
  const word = BigInt(data);
  const sqrtPriceX96 = word & ((1n << 160n) - 1n);
  let tick = (word >> 160n) & 0xffffffn;
  if (tick & 0x800000n) tick -= 0x1000000n; // sign-extend the 24-bit two's-complement tick
  const protocolFee = Number((word >> 184n) & 0xffffffn);
  const lpFee = Number((word >> 208n) & 0xffffffn);
  return { sqrtPriceX96, tick: Number(tick), protocolFee, lpFee };
}
