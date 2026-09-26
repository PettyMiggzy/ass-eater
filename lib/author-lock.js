/**
 * Serialising an author's write with the deletion of their account
 * (round-20 social#1). Server-only.
 *
 * Deleting an account (lib/users-store.js deleteFanAccount, creator deletion
 * in lib/creators-store.js) locks the account's users row FOR UPDATE, purges
 * what it wrote part-way through the transaction (purgeUserContent) and
 * deletes the row at the end. A wall comment, a report or a sender-named
 * notification whose route checked the session just BEFORE the deletion
 * began, but inserted AFTER the purge's DELETE/UPDATE statements had run, was
 * never removed or anonymised -- the comment stayed public under the deleted
 * account's name, contradicting Privacy section 7.
 *
 * lockAuthorRow takes the author's users row FOR KEY SHARE on the writing
 * transaction, FIRST (users before conversations, reports and wall_posts --
 * the purge's own order, so there is no lock inversion). KEY SHARE conflicts
 * with the deletion's FOR UPDATE and DELETE, so the write waits for a
 * deletion in progress and, once it commits, finds no row: the write is
 * refused with AUTHOR_ACCOUNT_GONE and nothing is inserted. Paid DMs already
 * do the same (lib/messages-store.js sendDirectMessage).
 */
export const AUTHOR_ACCOUNT_GONE = 'author_account_gone';

export async function lockAuthorRow(client, userId) {
  if (userId === null || userId === undefined || userId === '') return;
  const { rows } = await client.query('select 1 from users where id = $1 for key share', [String(userId)]);
  if (!rows.length) {
    throw Object.assign(new Error('This account no longer exists.'), { code: AUTHOR_ACCOUNT_GONE });
  }
}
