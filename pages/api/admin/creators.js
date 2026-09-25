import { getCreators } from '../../../lib/creators-store';
import { requireAdminKey } from '../../../lib/admin-auth';
import { query } from '../../../lib/db';

/**
 * GET /api/admin/creators   Header x-admin-key.
 *   -> 200 { creators: [<full creator record>],
 *            accounts: { [creatorId]: { userId, login, createdAt, tosVersion } } }
 *
 * `accounts` maps each creator to the login account that owns it (users whose
 * data.creatorId points at it). A creator with NO entry has no login at all
 * -- an admin-created ("+ Add Model") profile nobody can sign in to, reply
 * from, sell from or be paid through. `login` is the identifier the person
 * signed up with; creators must give a real email address at signup, so it
 * is how an admin reaches an applicant (for example to ask for the photo ID
 * the §2257 record needs before approval).
 *
 * ADMIN-ONLY. Login identifiers never go into public props: this map is
 * kept separate from the creator records precisely so no projection of a
 * creator can carry it by accident.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  try {
    const creators = await getCreators();
    const { rows } = await query(
      `select id, data->>'creatorId' as creator_id, data->>'email' as login,
              data->>'tosVersion' as tos_version, created_at
         from users
        where coalesce(data->>'creatorId', '') <> ''
        order by created_at`,
    );
    const accounts = {};
    for (const r of rows) {
      // One login per creator is the normal shape; if two ever point at the
      // same creator, the oldest (the one that created it) is shown.
      if (accounts[r.creator_id]) continue;
      accounts[r.creator_id] = {
        userId: String(r.id),
        login: typeof r.login === 'string' ? r.login : null,
        createdAt: r.created_at,
        tosVersion: r.tos_version || null,
      };
    }
    return res.status(200).json({ creators, accounts });
  } catch (err) {
    console.error('[admin/creators] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
