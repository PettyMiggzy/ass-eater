import { getSessionUser } from '../../../lib/session';
import { setConversationBlocked, unblockByHandle, DM_ERRORS } from '../../../lib/messages-store';
import { AUTHOR_ACCOUNT_GONE } from '../../../lib/author-lock';
import { refuseMalformedText } from '../../../lib/field-validation';

/**
 * POST /api/messages/block { userId, blocked: boolean }
 *   -> 200 { ok: true, conversation }   (projection: blockedByMe / blockedByThem)
 *   -> 404 no such account (block), or no conversation with it (unblock)
 * POST /api/messages/block { blockHandle, blocked: false }
 *   -> 200 { ok: true, blockHandle }    lifts a block-only row the inbox listed
 *      by its opaque handle (/api/messages/conversations never sends that
 *      row's counterpart id, so there is no userId to send)
 *   -> 404 no such block-only row of the caller's
 *
 * Blocks (or unblocks) the other side of the caller's conversation with
 * `userId`. A block needs no prior conversation (lib/messages-store.js
 * setConversationBlocked creates the pair row). While blocked, that account's sends to the caller are refused
 * (403 { code: 'dm_blocked' }) before anything is charged. Participant-only:
 * the conversation id is derived from the caller's own id.
 */
export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });

  const { userId, blocked, blockHandle } = req.body && typeof req.body === 'object' ? req.body : {};
  if (blockHandle !== undefined) {
    if (typeof blockHandle !== 'string' || blockHandle.length > 64) return res.status(400).json({ error: 'Invalid block handle' });
    if (blocked !== false) return res.status(400).json({ error: 'A block handle can only be unblocked.' });
    try {
      return res.status(200).json(await unblockByHandle(user.id, blockHandle));
    } catch (err) {
      if (err.code === DM_ERRORS.CONVERSATION_NOT_FOUND) return res.status(404).json({ error: 'Conversation not found' });
      console.error('[messages/block] unexpected error:', err);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  }
  if ((typeof userId !== 'string' && typeof userId !== 'number') || !String(userId).trim() || String(userId).length > 100) {
    return res.status(400).json({ error: 'Missing userId' });
  }
  if (typeof blocked !== 'boolean') return res.status(400).json({ error: 'blocked must be true or false' });
  if (String(userId) === String(user.id)) return res.status(400).json({ error: 'You cannot block yourself' });

  try {
    const conversation = await setConversationBlocked(user.id, String(userId), blocked);
    return res.status(200).json({ ok: true, conversation });
  } catch (err) {
    // The caller's own account was deleted while this was in flight.
    if (err.code === AUTHOR_ACCOUNT_GONE) return res.status(401).json({ error: 'Your account no longer exists.' });
    if (err.code === DM_ERRORS.CONVERSATION_NOT_FOUND) return res.status(404).json({ error: 'Conversation not found' });
    if (err.code === DM_ERRORS.RECIPIENT_NOT_FOUND) return res.status(404).json({ error: 'That account does not exist.' });
    if (err.code === DM_ERRORS.SELF) return res.status(400).json({ error: 'You cannot block yourself' });
    console.error('[messages/block] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
