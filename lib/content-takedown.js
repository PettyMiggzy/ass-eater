/**
 * Admin takedown of ONE specific item -- a marketplace listing, a direct
 * message, or a wall comment -- optionally attributed to a TAKE IT DOWN
 * request (server-only).
 *
 * The takedown tab used to only record a resolution ("confirm you have
 * already removed it") while giving the admin no way to remove a listing, a
 * DM or a comment: the only per-item removal went through an in-product
 * report, which needs a logged-in reporter (and signups are closed), and a
 * manual ban keeps a sold listing's files serving to its buyers. This is the
 * missing control:
 *
 *   - listing: taken down with takeDownListing -- WITHOUT keepPaid, so a
 *     paid listing's files come down too (mediaDeletedAt; delivery and
 *     /api/media stop serving them). This is a takedown of the content.
 *   - message: removed from its conversation (removeConversationMessage).
 *   - wall comment: deleted (deleteWallPost, as admin).
 *
 * Before anything is removed, a copy of the item (text, author/sender, time;
 * a listing's text and file list) is taken, and for a POSSIBLE MINOR request
 * -- or when the admin asks for it -- the listing's files are QUARANTINED
 * first (lib/media-preservation.js: kept, never served, never deleted) and
 * then moved to evidence/. Every takedown is written to moderation_actions
 * (the audit trail) and, when attributed, onto the request itself
 * (`takedowns` + `history`), which is what lets that request be resolved as
 * 'removed' (lib/ncii-reports-store.js resolveNciiReport requireTakedown).
 */
import { query, withTransaction, rowToRecord } from './db';
import { takeDownListing } from './listings-store';
import { deleteMediaQuietly } from './blob-cleanup';
import { removeConversationMessage, conversationIdBetween } from './messages-store';
import { deleteWallPost } from './wall-store';
import { preserveMedia, movePreservedToEvidence, reportRef } from './media-preservation';
import { snapshotListing, snapshotMessage, snapshotWallPost } from './reports-store';
import {
  recordNciiTakedown,
  preserveMediaForReportTx,
  NCII_REPORT_NOT_FOUND,
  normalizeNciiCategory,
} from './ncii-reports-store';

export const TAKEDOWN_TYPES = ['listing', 'message', 'wall_post'];
export const TAKEDOWN_INVALID = 'takedown_invalid';

const POSITIVE_INT = /^[1-9][0-9]{0,17}$/;

/**
 * Validates the request body into a target, or returns { error }.
 * { type: 'listing', listingId } | { type: 'message', conversationId, messageId }
 * | { type: 'wall_post', postId }
 */
export function parseTakedownTarget(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!TAKEDOWN_TYPES.includes(b.type)) return { error: 'type must be listing, message or wall_post' };
  if (b.type === 'listing') {
    const id = String(b.listingId ?? '').trim();
    if (!POSITIVE_INT.test(id)) return { error: 'Missing listing id' };
    return { target: { type: 'listing', listingId: id } };
  }
  if (b.type === 'wall_post') {
    const id = String(b.postId ?? '').trim();
    if (!POSITIVE_INT.test(id)) return { error: 'Missing comment id' };
    return { target: { type: 'wall_post', postId: id } };
  }
  const { conversationId, messageId } = b;
  if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 300
    || typeof messageId !== 'string' || !messageId || messageId.length > 100) {
    return { error: 'Missing conversation id or message id' };
  }
  return { target: { type: 'message', conversationId, messageId } };
}

/**
 * Takes the target down. `nciiReportId` (optional) must name an existing
 * takedown request; a 'minor' one always quarantines the listing's files, and
 * `preserve: true` does so for any request. Throws NCII_REPORT_NOT_FOUND.
 * Returns { result: 'removed' | 'already_gone', preserved, snapshot, actionId }.
 */
export async function takeDownContent(target, { nciiReportId = null, preserve = false, by = 'admin' } = {}) {
  let ncii = null;
  if (nciiReportId !== null && nciiReportId !== undefined && nciiReportId !== '') {
    const { rows } = await query('select id, data from ncii_reports where id = $1', [String(nciiReportId)]);
    if (!rows.length) throw Object.assign(new Error('Report not found'), { code: NCII_REPORT_NOT_FOUND });
    ncii = { id: String(rows[0].id), category: normalizeNciiCategory(rows[0].data?.category) };
  }
  const quarantine = !!preserve || ncii?.category === 'minor';

  let result = 'already_gone';
  let snapshot = null;
  let preserved = [];

  if (target.type === 'listing') {
    // ONE transaction, reading the listing under its file and row locks
    // (lib/listings-store.js takeDownListing): the files preserved are exactly
    // the ones on the row the takedown then removes. The preservation used to
    // come from an unlocked read committed on its own, so a file the seller
    // finalized in between was deleted by the takedown instead of kept --
    // for a POSSIBLE MINOR request, exactly the material 18 U.S.C. 2258A
    // requires be preserved (round-8 media#1). The request row is locked
    // first, as preserveMediaForReportTx does, so the order stays report ->
    // files -> listing rows.
    const out = await withTransaction(async (client) => {
      if (quarantine && ncii) {
        const { rows } = await client.query('select id from ncii_reports where id = $1 for update', [ncii.id]);
        if (!rows.length) throw Object.assign(new Error('Report not found'), { code: NCII_REPORT_NOT_FOUND });
      }
      return takeDownListing(target.listingId, {
        client,
        preserve: quarantine
          ? (c, items) => (ncii
            ? preserveMediaForReportTx(c, ncii.id, items, { reason: `takedown #${ncii.id}: listing ${target.listingId}` })
            : preserveMedia(items, { reportId: null, reason: `admin takedown: listing ${target.listingId}`, preservedBy: by, client: c }))
          : null,
      });
    });
    if (out.listing) snapshot = snapshotListing(out.listing);
    preserved = out.preserved;
    // Only when THIS call deleted the files: a listing an earlier takedown
    // already emptied comes back with removed: null (alreadyRemoved), so a
    // mistyped id cannot count as the takedown a request is resolved on
    // (round-11 media#0).
    if (out.removed) result = 'removed';
    // After the commit; deleteMediaQuietly re-checks preservation and skips
    // the quarantined files.
    if (out.files.length) await deleteMediaQuietly(out.files);
  } else if (target.type === 'message') {
    const gone = await removeConversationMessage(target.conversationId, target.messageId, {
      // Copied inside the removal's own transaction, before the message is
      // dropped: a failed copy leaves the message in place.
      beforeRemove: async (client, m) => {
        const { rows } = await client.query('select data from conversations where id = $1', [target.conversationId]);
        snapshot = await snapshotMessage(m, { conversationId: target.conversationId, participantIds: rows[0]?.data?.participantIds }, client);
      },
    });
    if (gone) result = 'removed';
  } else if (target.type === 'wall_post') {
    const { rows } = await query('select data from wall_posts where id = $1', [target.postId]);
    if (rows.length) {
      snapshot = await snapshotWallPost(rows[0].data);
      try {
        await deleteWallPost(target.postId, 'admin', { isWallOwner: true });
        result = 'removed';
      } catch (err) {
        if (err.message !== 'Comment not found') throw err;
      }
    }
  } else {
    throw Object.assign(new Error('Unknown target type'), { code: TAKEDOWN_INVALID });
  }

  const entry = {
    type: target.type,
    target,
    result,
    preserved: preserved.length,
    snapshot,
    by,
  };
  const actionId = await withTransaction(async (client) => {
    const { rows } = await client.query(
      'insert into moderation_actions (data) values ($1) returning id',
      [{ action: 'content_takedown', ...entry, nciiReportId: ncii?.id || null, at: new Date().toISOString() }],
    );
    if (ncii) await recordNciiTakedown(ncii.id, { ...entry, actionId: String(rows[0].id) }, client);
    return String(rows[0].id);
  });
  if (preserved.length) await movePreservedToEvidence({ limit: Math.min(preserved.length, 200) });
  return { result, preserved: preserved.length, snapshot, actionId, reportRef: ncii ? reportRef('ncii', ncii.id) : null };
}

/** The audit trail, newest first (admin only). */
export async function listModerationActions({ nciiReportId = null, limit = 200 } = {}) {
  const { rows } = await query(
    `select id, data, created_at from moderation_actions
      where ($1::text is null or data->>'nciiReportId' = $1::text)
      order by id desc limit $2`,
    [nciiReportId === null || nciiReportId === undefined ? null : String(nciiReportId), Math.max(1, Math.min(Number(limit) || 200, 1000))],
  );
  return rows.map((r) => ({ id: String(r.id), ...r.data, createdAt: r.created_at }));
}

/*
 * ADMIN LOOKUPS for the takedown control. A DM takedown needs a conversation
 * id and a message id, and a wall-comment takedown a comment id -- none of
 * which any admin screen used to show: message ids live only in the two
 * participants' inboxes, conversation ids are an internal format, and comment
 * ids are rendered nowhere. Without these, the only ways to "resolve" a
 * TAKE IT DOWN request about a DM were a ban or a false "already gone".
 * Admin only (the route takes the admin key): results carry login
 * identifiers so the admin can match a report's free-text description.
 */

const LOOKUP_ID = /^[^\s]{1,100}$/;

async function accountsById(ids) {
  const list = [...new Set(ids.filter((v) => v !== null && v !== undefined && v !== '').map(String))];
  if (!list.length) return new Map();
  const { rows } = await query(
    `select u.id, u.data->>'email' as login, u.data->>'role' as role, u.data->>'creatorId' as creator_id,
            c.data->>'name' as creator_name, c.data->>'handle' as creator_handle
       from users u
       left join creators c on c.id::text = u.data->>'creatorId'
      where u.id::text = any($1::text[])`,
    [list],
  );
  return new Map(rows.map((r) => [String(r.id), {
    userId: String(r.id),
    login: r.login || null,
    role: r.role || null,
    creatorId: r.creator_id || null,
    creatorName: r.creator_name || null,
    creatorHandle: r.creator_handle || null,
  }]));
}

function accountOrGone(map, id) {
  return map.get(String(id)) || { userId: String(id), login: null, role: null, creatorId: null, deleted: true };
}

/**
 * Resolves the account a lookup is about: { userId } | { login } (matched the
 * way sign-in matches it: trimmed, case-insensitive) | { creatorId } (the
 * login account that owns that creator profile). Returns the account or null.
 */
export async function resolveLookupAccount({ userId, login, creatorId } = {}) {
  let rows;
  if (typeof userId === 'string' && LOOKUP_ID.test(userId.trim())) {
    ({ rows } = await query('select id from users where id::text = $1', [userId.trim()]));
  } else if (typeof login === 'string' && login.trim() && login.length <= 320) {
    ({ rows } = await query(`select id from users where lower(btrim(data->>'email')) = $1`, [login.trim().toLowerCase()]));
  } else if (typeof creatorId === 'string' && POSITIVE_INT.test(creatorId.trim())) {
    ({ rows } = await query(`select id from users where data->>'creatorId' = $1`, [creatorId.trim()]));
  } else {
    return null;
  }
  if (!rows.length) return null;
  return (await accountsById([rows[0].id])).get(String(rows[0].id)) || null;
}

/**
 * A creator's wall comments, newest first, with their ids and authors.
 * { creatorId, before? (a comment id), limit? } ->
 * { posts: [{ id, text, createdAt, authorName, author: {userId, login, ...} }], hasMore, nextBefore }
 */
export async function lookupWallComments({ creatorId, before = null, limit = 50 } = {}) {
  const cid = String(creatorId ?? '').trim();
  if (!POSITIVE_INT.test(cid)) return { posts: [], hasMore: false, nextBefore: null };
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 100);
  const cursor = POSITIVE_INT.test(String(before ?? '')) ? String(before) : null;
  const { rows } = await query(
    `select id, data from wall_posts
      where data->>'creatorId' = $1 and ($2::bigint is null or id < $2::bigint)
      order by id desc limit $3`,
    [cid, cursor, size + 1],
  );
  const page = rows.slice(0, size).map(rowToRecord);
  const people = await accountsById(page.map((p) => p.authorId));
  const hasMore = rows.length > size;
  return {
    posts: page.map((p) => ({
      id: String(p.id),
      text: String(p.text ?? ''),
      createdAt: p.createdAt || null,
      authorName: p.authorName || null,
      author: accountOrGone(people, p.authorId),
    })),
    hasMore,
    nextBefore: hasMore && page.length ? String(page[page.length - 1].id) : null,
  };
}

/**
 * Every conversation an account takes part in, most recent first, as
 * summaries: { id, other: <account>, messageCount, lastMessage, updatedAt }.
 * `offset` pages through them (admin volume is small; a stable id tiebreak).
 */
export async function lookupConversationsFor(userId, { offset = 0, limit = 50 } = {}) {
  const uid = String(userId ?? '');
  if (!uid) return { conversations: [], hasMore: false, nextOffset: null };
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 100);
  const skip = Math.max(Number.parseInt(offset, 10) || 0, 0);
  const { rows } = await query(
    `select id, updated_at, data->'participantIds' as participants,
            jsonb_array_length(coalesce(data->'messages', '[]'::jsonb)) as message_count,
            data->'messages'->-1 as last_message
       from conversations
      where data->'participantIds' ? $1
      order by updated_at desc, id desc
      offset $2 limit $3`,
    [uid, skip, size + 1],
  );
  const page = rows.slice(0, size);
  const otherOf = (r) => (Array.isArray(r.participants) ? r.participants.map(String) : []).find((p) => p !== uid) || null;
  const people = await accountsById(page.map(otherOf));
  const hasMore = rows.length > size;
  return {
    conversations: page.map((r) => {
      const other = otherOf(r);
      const last = r.last_message && typeof r.last_message === 'object' ? r.last_message : null;
      return {
        id: String(r.id),
        other: other ? accountOrGone(people, other) : null,
        messageCount: Number(r.message_count) || 0,
        lastMessage: last ? { id: String(last.id ?? ''), senderId: String(last.senderId ?? ''), text: String(last.text ?? ''), createdAt: last.createdAt || null } : null,
        updatedAt: r.updated_at,
      };
    }),
    hasMore,
    nextOffset: hasMore ? skip + size : null,
  };
}

/**
 * One conversation with every stored message and its id, by conversation id
 * or by its two participants (the id is computed here -- nobody has to know
 * the format). Returns null when there is no such conversation.
 * { conversationId } | { userA, userB } ->
 * { id, participants: [<account>], messages: [{ id, senderId, text, createdAt, priceCents? }] }
 */
export async function lookupConversation({ conversationId, userA, userB } = {}) {
  let id = null;
  if (typeof conversationId === 'string' && conversationId && conversationId.length <= 300) id = conversationId;
  else if (typeof userA === 'string' && typeof userB === 'string' && LOOKUP_ID.test(userA.trim()) && LOOKUP_ID.test(userB.trim())
    && userA.trim() !== userB.trim()) id = conversationIdBetween(userA.trim(), userB.trim());
  if (!id) return null;
  const { rows } = await query('select id, data from conversations where id = $1', [id]);
  if (!rows.length) return null;
  const c = rowToRecord(rows[0]);
  const participantIds = Array.isArray(c.participantIds) ? c.participantIds.map(String) : [];
  const people = await accountsById(participantIds);
  return {
    id: String(c.id),
    participants: participantIds.map((p) => accountOrGone(people, p)),
    messages: (Array.isArray(c.messages) ? c.messages : []).filter((m) => m && m.id).map((m) => ({
      id: String(m.id),
      senderId: String(m.senderId ?? ''),
      text: String(m.text ?? ''),
      createdAt: m.createdAt || null,
      ...(m.priceCents ? { priceCents: Number(m.priceCents) } : {}),
    })),
  };
}
