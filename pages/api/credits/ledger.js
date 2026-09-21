import { getVerifiedSessionUserId } from '../../../lib/session';
import { getLedgerForUser } from '../../../lib/credits-store';

// A logged-in user's own recent credit activity -- deposits, marketplace
// charges, sales earned, payout reservations. Every one of these is already
// written to credit_ledger by lib/credits-store.js; this is the first place
// any of it is ever read back for the person it happened to, rather than
// sitting in Postgres unused.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in to see your activity' });

  const entries = await getLedgerForUser(uid, 50);
  return res.status(200).json({
    entries: entries.map((e) => ({
      id: e.id,
      type: e.type,
      amountCents: Number(e.amount_cents),
      meta: e.meta,
      createdAt: e.created_at,
    })),
  });
}
