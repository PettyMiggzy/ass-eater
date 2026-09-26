import { refuseMalformedText } from '../../../lib/field-validation';
import { getCreatorById } from '../../../lib/creators-store';
import { isPubliclyVisible } from '../../../lib/creator-status';
import { gateTokensOf, tokenGateLive } from '../../../lib/token-gate';
import {
  holderVerificationLive,
  readHolderPass,
  verifiedHolderBalance,
  holderGateState,
} from '../../../lib/holder-access';

/**
 * GET /api/token-gate/status[?creatorId=<id>]
 *
 * 200 {
 *   live,        // the gate can actually be verified (token + server RPC configured)
 *   verified,    // this browser holds a valid oa_holder pass
 *   address,     // checksumless lowercase address of the pass, or null
 *   balance,     // current whole-token balance (server-read, cached ~60s), or null
 *   expiresAt,   // ISO time the pass expires, or null
 *   creator?: { id, gated, required, allowed, reason }   // only with ?creatorId
 * }
 *
 * `reason` is one of not_gated | owner | admin | holds_enough | holds_too_few |
 * no_wallet | not_live | verifier_unavailable. A creator that is not publicly
 * visible answers as if it does not exist (creator: null).
 */
export default async function handler(req, res) {
  // NUL / half an emoji in a query value is a 400, never a 500 from pg (round-11 fix-up).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    const live = holderVerificationLive();
    const pass = live ? readHolderPass(req) : null;
    const held = pass ? await verifiedHolderBalance(req) : null;
    const body = {
      live,
      tokenLive: tokenGateLive(),
      verified: !!pass,
      address: pass ? pass.address : null,
      balance: held === null ? null : held.toString(),
      expiresAt: pass ? new Date(pass.exp).toISOString() : null,
    };

    const rawId = req.query.creatorId;
    if (rawId !== undefined) {
      const id = typeof rawId === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(rawId) ? rawId : null;
      const creator = id ? await getCreatorById(id) : null;
      if (!creator || !isPubliclyVisible(creator)) {
        body.creator = null;
      } else {
        const state = await holderGateState(req, creator);
        body.creator = {
          id: creator.id,
          gated: state.reason !== 'not_gated',
          required: gateTokensOf(creator),
          allowed: state.allowed === true,
          reason: state.reason,
        };
      }
    }
    return res.status(200).json(body);
  } catch (err) {
    console.error('[token-gate/status] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
