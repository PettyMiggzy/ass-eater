import { requireAdminKey } from '../../../lib/admin-auth';
import { refuseCrossSite } from '../../../lib/same-origin';
import { refuseMalformedText } from '../../../lib/field-validation';
import { installHouseRoster, removeHouseRoster, getHouseRosterStatus } from '../../../lib/house-roster';

// Each call stops well before the platform's duration limit and reports
// { done: false }; the admin panel calls again until done (lib/house-roster.js
// is resumable and never duplicates anything).
export const config = { maxDuration: 60 };
const TIME_BUDGET_MS = 40_000;

/**
 * The AI house model roster (lib/house-roster.js), admin-key gated.
 *
 *   GET                              -> 200 { status }
 *   POST { action: 'install' }       -> 200 { ok, done, uploaded, status }
 *      A house sale is 100% platform revenue and pays no user, so there is no
 *      payee to configure; a legacy `payeeEmail` field is ignored.
 *   POST { action: 'remove' }        -> 200 { ok, hiddenCreators, unlistedListings, status }
 *      Hides the models and takes their listings off sale. Deletes nothing:
 *      orders, listings and files all stay, and buyers keep their downloads.
 *
 * `status` = { models: [{ slug, name, creatorId, hidden, status,
 * listings, activeListings, images, expectedImages }], installed, complete,
 * hidden, imagesDeployed }.
 *
 * Errors: 400/404/409/500/503 { error, code } with codes from
 * lib/house-roster.js HOUSE_ERRORS (plus 'house_handle_taken'); anything
 * unexpected is a generic 500.
 */
export default async function handler(req, res) {
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (req.method === 'POST' && refuseCrossSite(req, res)) return;
  if (!requireAdminKey(req, res)) return;
  res.setHeader('Cache-Control', 'private, no-store');

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ status: await getHouseRosterStatus() });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const action = body.action === undefined ? 'install' : body.action;
    if (action === 'remove') {
      const out = await removeHouseRoster();
      return res.status(200).json({ ok: true, ...out, status: await getHouseRosterStatus() });
    }
    if (action !== 'install') return res.status(400).json({ error: 'Unknown action' });
    const out = await installHouseRoster({ timeBudgetMs: TIME_BUDGET_MS });
    return res.status(200).json({ ok: true, ...out });
  } catch (err) {
    if (err && typeof err.code === 'string' && err.code.startsWith('house_') && Number.isInteger(err.status)) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error('[admin/house-roster] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
