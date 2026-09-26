import { requireAdminKey } from '../../../lib/admin-auth';
import { listPendingStandingPushes, deliverStandingPushes, bridgeConfigured } from '../../../lib/standing-outbox';

/**
 * Undelivered site -> server/ standing messages (lib/standing-outbox.js).
 * Header x-admin-key.
 *
 * GET  -> 200 { ok, configured, pending: [{ uid, status, role, standingAt, suspendedUntil,
 *                attempts, nextAttemptAt, lastError, needsServerAdmin, queuedAt }] }
 * POST -> 200 { ok, sent, failed, remaining, pending }   retries every queued push now
 *
 * A row here is a ban, suspension, reinstatement or deletion server/ has not
 * confirmed yet -- that account may still be renewing subscriptions or taking
 * payouts there. Rows retry by themselves (backoff up to 6 hours, plus the
 * daily cron); a row stuck with lastError 'http_404' usually means the
 * server/ droplet runs code without the /auth/bridge/status route and needs
 * a redeploy.
 *
 * A row with needsServerAdmin true (lastError 'ban_needs_server_admin' or
 * 'suspension_needs_server_admin') is a reinstatement server/ received and
 * refused: that account was banned or suspended by a server/ admin, and the
 * site may only lift restrictions the site applied. It stays restricted on
 * server/ (payouts frozen; after a ban, listings down) until someone runs
 * POST /admin/users/:id/status {"status":"ACTIVE"} there; the row then clears
 * on its next retry (every 6 hours, or a POST here).
 */
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdminKey(req, res)) return;
  try {
    if (req.method === 'POST') {
      const pendingBefore = await listPendingStandingPushes(500);
      const out = await deliverStandingPushes({ uids: pendingBefore.map((p) => p.uid), limit: 500 });
      return res.status(200).json({ ok: true, configured: bridgeConfigured(), ...out, pending: await listPendingStandingPushes() });
    }
    return res.status(200).json({ ok: true, configured: bridgeConfigured(), pending: await listPendingStandingPushes() });
  } catch (err) {
    console.error('[admin/standing-pushes] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
