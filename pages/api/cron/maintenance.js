import crypto from 'crypto';
import { sweepOrphanedMedia, blobConfigured, pendingDeletionCounts } from '../../../lib/media';
import { movePreservedToEvidence } from '../../../lib/media-preservation';
import { deliverStandingPushes } from '../../../lib/standing-outbox';

/**
 * GET /api/cron/maintenance -- the scheduled job (vercel.json "crons").
 * Header `Authorization: Bearer <CRON_SECRET>` -- the header Vercel Cron
 * sends when CRON_SECRET is set on the project. Not the admin key: a cron
 * secret can be rotated on its own, and this route can do nothing an admin
 * could not.
 *   -> 200 { ok, media, evidence, standing, outstanding }
 *   -> 401 wrong/missing secret; 503 CRON_SECRET not configured (refuses to run open)
 *
 * Runs the retries that must not depend on someone happening to upload a
 * file or open /admin:
 *   - the orphan/deletion sweep (lib/media.js) -- failed TAKE IT DOWN
 *     deletions are retried here, against a 48-hour legal clock;
 *   - moving preserved evidence into the evidence/ prefix
 *     (lib/media-preservation.js);
 *   - undelivered site -> server/ standing pushes (lib/standing-outbox.js).
 * Each step is independent: one failing does not stop the others.
 *
 * proxy.js must let /api/cron/ through the geoblock and preview gate (the
 * cron request comes from Vercel, with no age cookie and often no geo
 * headers); the Bearer secret is what protects it.
 */
export const config = { maxDuration: 60 };

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.authorization;
  if (!secret || typeof header !== 'string') return false;
  const a = crypto.createHash('sha256').update(header).digest();
  const b = crypto.createHash('sha256').update(`Bearer ${secret}`).digest();
  return crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.CRON_SECRET) return res.status(503).json({ error: 'CRON_SECRET is not configured.' });
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const out = { ok: true };
  if (blobConfigured()) {
    try {
      out.media = await sweepOrphanedMedia({ limit: 300, timeBudgetMs: 30 * 1000 });
    } catch (err) {
      out.ok = false;
      console.error('[cron/maintenance] media sweep failed:', err);
    }
    try {
      out.evidence = await movePreservedToEvidence({ limit: 100 });
    } catch (err) {
      out.ok = false;
      console.error('[cron/maintenance] evidence move failed:', err);
    }
  }
  try {
    out.standing = await deliverStandingPushes({ limit: 100 });
  } catch (err) {
    out.ok = false;
    console.error('[cron/maintenance] standing delivery failed:', err);
  }
  try {
    out.outstanding = await pendingDeletionCounts();
  } catch {
    // informational
  }
  return res.status(200).json(out);
}
