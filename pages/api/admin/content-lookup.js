import { refuseMalformedText } from '../../../lib/field-validation';
import { requireAdminKey } from '../../../lib/admin-auth';
import { query } from '../../../lib/db';
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
 * GET ?kind=conversations&(userId=<id> | login=<email or username> | creatorId=<id>)[&cursor=<nextCursor>]
 *   -> 200 { ok, account, conversations: [{ id, other, messageCount, lastMessage, updatedAt }], hasMore, nextCursor, nextOffset }
 *   Keyset-paged: pass the previous page's nextCursor. (`offset` still works
 *   for an old client, but can skip a conversation that gets a new message
 *   while paging -- lib/content-takedown.js lookupConversationsFor.)
 *   -> 404 no such account
 * GET ?kind=messages&(conversationId=<id> | userA=<id>&userB=<id>)[&before=<message id>][&limit=N]
 *   -> 200 { ok, conversation: { id, participants: [account], messageCount,
 *            messages: [{ id, senderId, text, createdAt, priceCents? }], hasMore, nextBefore } }
 *   Paged: the newest 100 (limit, at most 100) messages older than `before`,
 *   oldest first within the page; page back with before=nextBefore.
 *   -> 409 { error, code: 'stale_cursor' } when `before` names a message that
 *      is no longer in the thread (taken down, or aged out): reload from the
 *      newest page (no `before`).
 *   -> 404 no such conversation
 * GET ?kind=listings&creatorId=12
 *   -> 200 { ok, listings: [{ id, title, status, kind, priceCents, createdAt, mediaCount }] }
 *   A creator's marketplace listings (every status, newest first, at most 200),
 *   so a specific listing can be taken down without a report or a takedown
 *   request existing (round-9 admin-ui#1). Never a media src.
 * `account` / `author` / `other` / participants are
 *   { userId, login, role, creatorId, creatorName, creatorHandle }, or for a
 *   deleted account { userId: null, login: null, role: null, creatorId: null,
 *   deleted: true } -- never the deleted account's id (round-19 admin-ui#0).
 *   A conversation's own `id` still joins the two participant ids; the panel
 *   must not print it when a participant is deleted. A message's (and a
 *   conversation's lastMessage's) senderId is null when its sender is deleted.
 */
function str(v) {
  return typeof v === 'string' ? v : undefined;
}

export default async function handler(req, res) {
  // NUL / half an emoji in a query value is a 400, never a 500 from pg (round-11 fix-up).
  if (refuseMalformedText(req, res)) return;
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
      const out = await lookupConversationsFor(account.userId, { offset: str(q.offset) || 0, cursor: str(q.cursor) || null });
      return res.status(200).json({ ok: true, account, ...out });
    }
    if (kind === 'messages') {
      const conversation = await lookupConversation({
        conversationId: str(q.conversationId),
        userA: str(q.userA),
        userB: str(q.userB),
        before: str(q.before) || null,
        limit: str(q.limit) || undefined,
      });
      if (!conversation) return res.status(404).json({ error: 'No such conversation' });
      if (conversation.stale) {
        return res.status(409).json({
          error: 'That message is no longer in this conversation (it was taken down or aged out). Reload the conversation from the newest messages.',
          code: 'stale_cursor',
          messageCount: conversation.messageCount,
        });
      }
      return res.status(200).json({ ok: true, conversation });
    }
    if (kind === 'listings') {
      const creatorId = str(q.creatorId);
      if (!creatorId || !/^[1-9][0-9]{0,17}$/.test(creatorId.trim())) return res.status(400).json({ error: 'Pick a creator' });
      const { rows } = await query(
        `select id, data from listings where data->>'creatorId' = $1 order by id desc limit 200`,
        [creatorId.trim()],
      );
      const listings = rows.map((r) => ({
        id: String(r.id),
        title: typeof r.data?.title === 'string' ? r.data.title : null,
        status: r.data?.status ?? null,
        kind: r.data?.kind === 'physical' ? 'physical' : 'digital',
        priceCents: r.data?.priceCents ?? null,
        createdAt: r.data?.createdAt ?? null,
        mediaCount: Array.isArray(r.data?.media) ? r.data.media.length : 0,
      }));
      return res.status(200).json({ ok: true, listings });
    }
    return res.status(400).json({ error: 'kind must be wall, conversations, messages or listings' });
  } catch (err) {
    console.error('[admin/content-lookup] failed:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
