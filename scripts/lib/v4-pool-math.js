'use strict';

const { AbiCoder, keccak256, concat, zeroPadValue, toBeHex } = require('ethers');

// CommonJS twin of server/src/lib/v4-pool-state.ts, for the hardhat/scripts
// side (different module system, same math). Keep both in sync if this ever
// changes -- verified against v4-core's real StateLibrary.sol/PoolId.sol
// source, not reconstructed from memory. See that file's header for the
// full explanation of why V4 needs this instead of a plain slot0() call.

const POOLS_SLOT = 6n;

function computePoolId(currency0, currency1, fee, tickSpacing, hooks) {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [currency0, currency1, fee, tickSpacing, hooks],
  );
  return keccak256(encoded);
}

function poolStateSlot(poolId) {
  const slotConst = zeroPadValue(toBeHex(POOLS_SLOT), 32);
  return keccak256(concat([poolId, slotConst]));
}

function decodeSlot0(data) {
  const word = BigInt(data);
  const sqrtPriceX96 = word & ((1n << 160n) - 1n);
  let tick = (word >> 160n) & 0xffffffn;
  if (tick & 0x800000n) tick -= 0x1000000n;
  const protocolFee = Number((word >> 184n) & 0xffffffn);
  const lpFee = Number((word >> 208n) & 0xffffffn);
  return { sqrtPriceX96, tick: Number(tick), protocolFee, lpFee };
}

module.exports = { computePoolId, poolStateSlot, decodeSlot0 };
