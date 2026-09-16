const { ethers } = require('hardhat');
const { computePoolId, poolStateSlot, decodeSlot0 } = require('./lib/v4-pool-math');

// Run this the moment $ONLYASS actually deploys (Kekfun.xyz auction closing
// Thursday, or wherever it ends up) -- confirms the address is real before
// anything downstream (server/.env, Vercel, the launchpad deploy) trusts it.
// A pre-computed address shown by a launch platform's own UI is normally
// reliable, but "normally reliable" isn't the same as "confirmed on-chain",
// and this takes ten seconds to run.
//
// Required:
//   ONLYASS_TOKEN_ADDRESS   - the address to check
// Optional, expected name/symbol to assert against (skips the check if unset):
//   ONLYASS_EXPECTED_NAME
//   ONLYASS_EXPECTED_SYMBOL
// Optional, to also look up a specific Uniswap V4 pool (skips if any are unset):
//   ONLYASS_V4_POOL_MANAGER, ONLYASS_V4_CURRENCY0, ONLYASS_V4_CURRENCY1,
//   ONLYASS_V4_TICK_SPACING, ONLYASS_V4_HOOKS, ONLYASS_POOL_FEE
// You'll need Kekfun.xyz's actual fee/tickSpacing/hooks convention for their
// pools to fill these in -- they aren't derivable from the token address alone.

const erc20Abi = ['function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)'];
const poolManagerAbi = ['function extsload(bytes32 slot) view returns (bytes32)'];

async function main() {
  const address = process.env.ONLYASS_TOKEN_ADDRESS;
  if (!address) throw new Error('Set ONLYASS_TOKEN_ADDRESS to the address you want to verify.');

  const provider = ethers.provider;
  const code = await provider.getCode(address);
  if (code === '0x') {
    console.log(`${address} has NO CODE on this network yet -- not deployed here, or you're pointed at the wrong network/RPC.`);
    process.exitCode = 1;
    return;
  }
  console.log(`${address} has contract code (${(code.length - 2) / 2} bytes). Reading ERC20 identity...`);

  const token = new ethers.Contract(address, erc20Abi, provider);
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    token.name(), token.symbol(), token.decimals(), token.totalSupply(),
  ]);
  console.log('name:', name);
  console.log('symbol:', symbol);
  console.log('decimals:', decimals);
  console.log('totalSupply:', ethers.formatUnits(totalSupply, decimals));

  const expectedName = process.env.ONLYASS_EXPECTED_NAME;
  const expectedSymbol = process.env.ONLYASS_EXPECTED_SYMBOL;
  if (expectedName && name !== expectedName) console.warn(`WARNING: name "${name}" does not match expected "${expectedName}"`);
  if (expectedSymbol && symbol !== expectedSymbol) console.warn(`WARNING: symbol "${symbol}" does not match expected "${expectedSymbol}"`);
  if ((!expectedName || name === expectedName) && (!expectedSymbol || symbol === expectedSymbol)) {
    console.log('Identity check passed.');
  }

  const { ONLYASS_V4_POOL_MANAGER, ONLYASS_V4_CURRENCY0, ONLYASS_V4_CURRENCY1, ONLYASS_V4_TICK_SPACING, ONLYASS_V4_HOOKS, ONLYASS_POOL_FEE } = process.env;
  if (ONLYASS_V4_POOL_MANAGER && ONLYASS_V4_CURRENCY0 && ONLYASS_V4_CURRENCY1) {
    console.log('\nChecking the V4 pool...');
    const fee = Number(ONLYASS_POOL_FEE ?? 3000);
    const tickSpacing = Number(ONLYASS_V4_TICK_SPACING ?? 60);
    const hooks = ONLYASS_V4_HOOKS ?? ethers.ZeroAddress;
    const poolId = computePoolId(ONLYASS_V4_CURRENCY0, ONLYASS_V4_CURRENCY1, fee, tickSpacing, hooks);
    const slot = poolStateSlot(poolId);
    const manager = new ethers.Contract(ONLYASS_V4_POOL_MANAGER, poolManagerAbi, provider);
    const data = await manager.extsload(slot);
    const { sqrtPriceX96, tick, lpFee } = decodeSlot0(data);
    if (sqrtPriceX96 === 0n) {
      console.log('Pool exists in storage but sqrtPriceX96 is 0 -- pool not initialized (or the fee/tickSpacing/hooks combination is wrong).');
    } else {
      console.log('poolId:', poolId);
      console.log('sqrtPriceX96:', sqrtPriceX96.toString());
      console.log('tick:', tick, ' lpFee:', lpFee);
      console.log('Pool is live. Set ONLYASS_POOL_VERSION=v4 and the matching ONLYASS_V4_* vars in server/.env to point the price oracle at it.');
    }
  } else {
    console.log('\n(Skipped V4 pool check -- set ONLYASS_V4_POOL_MANAGER/CURRENCY0/CURRENCY1 to also check a specific pool.)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
