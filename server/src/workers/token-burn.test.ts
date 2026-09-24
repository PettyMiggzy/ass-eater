import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, pad } from 'viem';

process.env.ONLYONE_TOKEN_ADDRESS = '0x2c34ED86552076715272056D021cEab6080F1Ab5';
const { tokensSentToDead } = await import('./token-burn.js');

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const log = (address: string, to: string, value: bigint) => ({
  address, data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  topics: [TRANSFER, pad('0x1111111111111111111111111111111111111111'), pad(to as `0x${string}`)] as `0x${string}`[],
});

describe('tokensSentToDead', () => {
  it('records the $ONLYONE that reached the dead address, not the stablecoin spent', () => {
    const usdg = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
    const logs = [
      log(usdg, '0x2222222222222222222222222222222222222222', 50_000_000n),          // the $50 input
      log(process.env.ONLYONE_TOKEN_ADDRESS!, DEAD, 123_456n * 10n ** 18n),            // what was destroyed
      log(process.env.ONLYONE_TOKEN_ADDRESS!, '0x3333333333333333333333333333333333333333', 5n), // not a burn
    ];
    expect(tokensSentToDead(logs)).toBe(123_456n * 10n ** 18n);
  });
});
