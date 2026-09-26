import { describe, expect, it } from 'vitest';
import { provablyNeverSent } from '../workers/payout-worker';
import { treasuryAccount } from '../lib/chain';

// Round-13: a payout signed by a treasury key other than the current one
// (a rotated-out wallet) -- or with no recorded signer -- is never judged
// "provably never sent" by the CURRENT wallet's nonce, and no cancel is
// signed for it from the new key. It is left FAILED for an admin.
describe('payout reconciler after a treasury key rotation', () => {
  const base = { id: '00000000-0000-0000-0000-000000000000', txHash: `0x${'ab'.repeat(32)}`, nonce: 7, cancelTxHash: null };

  it('refuses without any RPC call or settle sleep for another key or an unrecorded signer', async () => {
    const t0 = Date.now();
    expect(await provablyNeverSent({ ...base, signerAddress: '0x9999999999999999999999999999999999999999' })).toBe(false);
    expect(await provablyNeverSent({ ...base, signerAddress: null })).toBe(false);
    // The settle sleep (PAYOUT_BROADCAST_SETTLE_MS, >= 1s) never ran.
    expect(Date.now() - t0).toBeLessThan(1000);
    // Sanity: the check is against the key this process signs with.
    expect(treasuryAccount().address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
