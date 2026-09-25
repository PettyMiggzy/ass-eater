import { requireAdminKey } from '../../../lib/admin-auth';
import {
  resolveLookupAccount,
  lookupWallComments,
  lookupConversationsFor,
  lookupConversation,
} from '../../../lib/content-takedown';

/**
 * Finds the ids a specific-item takedown needs (lib/content-takedown.js
 * admin lookups). Admin-key gated; read only. Header x-admin-key.
 *
 * GET ?kind=wall&creatorId=12[&before=<comment id>]
 *   -> 200 { ok, posts: [{ id, text, createdAt, authorName, author }], hasMore, nextBefore }
 * GET ?kind=conversations&(userId=<id> | login=<email or username> | creatorId=<id>)[&offset=N]
 *   -> 200 { ok, account, conversations: [{ id, other, messageCount, lastMessage, updatedAt }], hasMore, nextOffset }
 *   -> 404 no such account
 * GET ?kind=messages&(conversationId=<id> | userA=<id>&userB=<id>)
 *   -> 200 { ok, conversation: { id, participants: [account], messages: [{ id, senderId, text, createdAt, priceCents? }] } }
 *   -> 404 no such conversation
 * `account` / `author` / `other` / participants are
 *   { userId, login, role, creatorId, creatorName, creatorHandle } (or { userId, deleted: true }).
 */
function str(v) {
  return typeof v === 'string' ? v : undefined;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdminKey(req, res)) return;
  res.setHeader('Cache-Control', 'private, no-store');

  const q = req.query || {};
  const kind = str(q.kind);
  try {
    if (kind === 'wall') {
      const creatorId = str(q.creatorId);
      if (!creatorId || !/^[1-9][0-9]{0,17}$/.test(creatorId.trim())) return res.status(400).json({ error: 'Pick a creator' });
      const out = await lookupWallComments({ creatorId: creatorId.trim(), before: str(q.before) || null });
      return res.status(200).json({ ok: true, ...out });
    }
    if (kind === 'conversations') {
      const who = { userId: str(q.userId), login: str(q.login), creatorId: str(q.creatorId) };
      if (!who.userId && !who.login && !who.creatorId) return res.status(400).json({ error: 'Enter a user id, email / username or creator' });
      const account = await resolveLookupAccount(who);
      if (!account) return res.status(404).json({ error: 'No such account' });
      const out = await lookupConversationsFor(account.userId, { offset: str(q.offset) || 0 });
      return res.status(200).json({ ok: true, account, ...out });
    }
    if (kind === 'messages') {
      const conversation = await lookupConversation({
        conversationId: str(q.conversationId),
        userA: str(q.userA),
        userB: str(q.userB),
      });
      if (!conversation) return res.status(404).json({ error: 'No such conversation' });
      return res.status(200).json({ ok: true, conversation });
    }
    return res.status(400).json({ error: 'kind must be wall, conversations or messages' });
  } catch (err) {
    console.error('[admin/content-lookup] failed:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
