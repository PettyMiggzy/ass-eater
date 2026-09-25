import { requireAdminKey } from '../../../lib/admin-auth';
import { query } from '../../../lib/db';
import { consumeAttempt, clientIp } from '../../../lib/rate-limit';
import { normalizeViewerMark, viewerMarkMatches } from '../../../lib/viewer-mark';

const PAGE_SIZE = 1000;
const MAX_LOOKUPS = 20;
const LOOKUP_WINDOW_MS = 10 * 60 * 1000;

/**
 * POST /api/admin/viewer-mark -- which account a leaked screenshot came off.
 * Header x-admin-key. JSON { code } ("A3F9-21C4", with or without the dash,
 * any case, "ONLYONE" prefix allowed)
 *   -> 200 { ok: true, match: { userId, role, creatorId } }
 *   -> 404 { error } no account produces that mark
 *   -> 400 not a mark
 *
 * The creator page and /orders tell signed-in viewers that content carries a
 * mark tied to their account (lib/viewer-mark.js). The mark is derived, not
 * stored, so the only lookup is recomputing it for every account --
 * viewerMarkMatches (constant-time) over each user id, a page at a time.
 * That promise needs a tool the people running the platform can actually
 * use, not a developer script against production. Rate-limited and logged.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdminKey(req, res)) return;

  const { limited, retryAfterSeconds } = consumeAttempt(`viewer-mark:ip:${clientIp(req)}`, {
    limit: MAX_LOOKUPS,
    windowMs: LOOKUP_WINDOW_MS,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many lookups. Try again in a few minutes.' });
  }

  const code = normalizeViewerMark(req.body?.code);
  if (!code) return res.status(400).json({ error: 'Enter the 8-character mark, like A3F9-21C4.' });

  try {
    let lastId = '';
    for (;;) {
      const { rows } = await query(
        `select id::text as id, data->>'role' as role, data->>'creatorId' as creator_id
           from users where id::text > $1 order by id::text limit $2`,
        [lastId, PAGE_SIZE],
      );
      for (const row of rows) {
        if (viewerMarkMatches(code, row.id)) {
          console.info('[admin/viewer-mark] lookup matched', code, row.id);
          return res.status(200).json({ ok: true, match: { userId: row.id, role: row.role || null, creatorId: row.creator_id || null } });
        }
      }
      if (rows.length < PAGE_SIZE) break;
      lastId = rows[rows.length - 1].id;
    }
    console.info('[admin/viewer-mark] lookup found no account', code);
    return res.status(404).json({ error: 'No account produces that mark.' });
  } catch (err) {
    console.error('[admin/viewer-mark] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
