import { query, rowToRecord, rowsToRecords } from './db';

/**
 * The pre-launch notify-me list: people who want to hear when OnlyOne opens,
 * split by whether they are coming as a fan or as a creator.
 *
 * This is a MARKETING list, which makes it a different kind of data from
 * everything else stored here. Nobody on it has an account, nobody has
 * agreed to the Terms, and the only thing they consented to is being told
 * when the site launches. So:
 *   - the only field collected is an email address and which side they're on,
 *   - a signup is idempotent (signing up twice is not two people),
 *   - and removeFromWaitlist() exists and is wired to the admin panel,
 *     because "take me off this list" has to be answerable by a person.
 * Do not grow this table into a shadow user record.
 */

export const WAITLIST_ROLES = ['fan', 'creator'];

/**
 * Must stay identical to the expression behind waitlist_email_idx in
 * lib/db.js -- see the comment there. Trim then lowercase, nothing else:
 * no plus-address stripping, no dot-folding. Those are provider-specific
 * guesses, and folding two addresses a provider treats as different would
 * silently drop one person off the list.
 */
export function normalizeWaitlistEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Deliberately loose. The only thing that actually proves an address works
// is sending to it, and a stricter pattern's failure mode is rejecting a
// real person who then never comes back -- far worse here than storing one
// address that bounces.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidWaitlistEmail(email) {
  const value = normalizeWaitlistEmail(email);
  return value.length >= 6 && value.length <= 254 && EMAIL_RE.test(value);
}

export function normalizeWaitlistRole(role) {
  const value = String(role || '').trim().toLowerCase();
  return WAITLIST_ROLES.includes(value) ? value : null;
}

/**
 * Add an address, or fold the signup into the existing row if it is already
 * there.
 *
 * Roles are a UNION rather than an overwrite, which is the one part of this
 * worth being deliberate about: somebody who signs up as a fan and later as
 * a creator is interested in both, and taking the newer value would throw
 * away whichever signal arrived first. The creator signal in particular is
 * the harder one to get and the one worth not losing.
 *
 * The first `source` wins, matching how a creator referral is attributed
 * (lib/referral.js) -- the page that actually did the work of convincing
 * someone is the one they first signed up from, not the last one they
 * happened to be on.
 */
export async function addToWaitlist({ email, role, source, state, country }) {
  const normalized = normalizeWaitlistEmail(email);
  if (!isValidWaitlistEmail(normalized)) throw new Error('A valid email address is required');

  const normalizedRole = normalizeWaitlistRole(role);
  if (!normalizedRole) throw new Error('Tell us whether you are joining as a fan or a creator');

  const now = new Date().toISOString();
  const entry = {
    email: normalized,
    roles: [normalizedRole],
    source: String(source || '').slice(0, 120) || 'unknown',
    // Whichever US state the visitor is in, when Vercel's edge told us. This
    // is here for one specific job: 27 states are geoblocked right now, and
    // when one of them is unblocked the people who signed up from it are
    // exactly who should hear about it first.
    state: String(state || '').slice(0, 8) || null,
    country: String(country || '').slice(0, 8) || null,
    createdAt: now,
    updatedAt: now,
  };

  const { rows } = await query(
    `insert into waitlist (data)
     values ($1::jsonb)
     on conflict (lower(btrim(data->>'email')))
     do update set data = jsonb_set(
            waitlist.data,
            '{roles}',
            (select coalesce(jsonb_agg(distinct r), '[]'::jsonb)
               from jsonb_array_elements_text(
                      coalesce(waitlist.data->'roles', '[]'::jsonb)
                      || coalesce(excluded.data->'roles', '[]'::jsonb)
                    ) as r)
          ) || jsonb_build_object('updatedAt', excluded.data->>'updatedAt')
     returning id, data`,
    [JSON.stringify(entry)],
  );
  return rowToRecord(rows[0]);
}

export async function getWaitlist() {
  const { rows } = await query('select id, data from waitlist order by created_at desc, id desc');
  return rowsToRecords(rows);
}

export async function getWaitlistCounts() {
  const { rows } = await query(
    `select count(*)::int as total,
            count(*) filter (where data->'roles' ? 'fan')::int as fans,
            count(*) filter (where data->'roles' ? 'creator')::int as creators
       from waitlist`,
  );
  return rows[0] || { total: 0, fans: 0, creators: 0 };
}

export async function removeFromWaitlist(id) {
  const { rows } = await query('delete from waitlist where id = $1 returning id, data', [id]);
  if (!rows.length) throw new Error('Not on the list');
  return rowToRecord(rows[0]);
}
