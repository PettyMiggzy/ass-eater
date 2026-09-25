import { requireAdminKey } from '../../../lib/admin-auth';

/**
 * GET /api/admin/alerts-status -- header x-admin-key.
 *   -> 200 { ok: true, nciiWebhookConfigured: boolean }
 *
 * Whether a new TAKE IT DOWN filing alerts anyone out of band
 * (NCII_ALERT_WEBHOOK_URL, lib/alerts.js). Without it a filing only shows up
 * when someone happens to open the admin panel, while a federal 48-hour clock
 * runs -- so the panel shows a banner until it is set. Only the boolean
 * leaves the server, never the URL (a webhook URL is a credential).
 */
export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdminKey(req, res)) return;
  const url = String(process.env.NCII_ALERT_WEBHOOK_URL || '').trim();
  return res.status(200).json({ ok: true, nciiWebhookConfigured: url.length > 0 });
}
