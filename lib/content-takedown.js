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
import crypto from 'crypto';
import { query, withTransaction, rowToRecord } from './db';
import { ageVerificationSecret } from './age-verification';
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
  adminTakedownEntryView,
} from './ncii-reports-store';

export const TAKEDOWN_TYPES = ['listing', 'message', 'wall_post'];
export const TAKEDOWN_INVALID = 'takedown_invalid';

const POSITIVE_INT = /^[1-9][0-9]{0,17}$/;

/*
 * SEALED CONVERSATION REFERENCES (round-20 social#0). A DM conversation id is
 * its two participants' ids joined ("<a>__<b>"), so for a thread in which one
 * participant's account is deleted, handing the raw id to the admin panel
 * re-identifies the purged account -- round 19 nulled the participant in the
 * lookup but kept returning the id. For such a thread the admin lookups now
 * return an opaque reference instead ("ref." + AES-256-GCM under a key derived
 * from the root secret with its own context string), and everything that
 * takes a conversation id from the panel -- the thread lookup and the
 * takedown -- opens it server-side. A thread whose participants all still
 * exist keeps its plain id (nothing to hide, and old links keep working).
 * A reference that does not open (forged, or minted under an older secret) is
 * refused as a bad id.
 */
const CONVERSATION_REF_PREFIX = 'ref.';
function conversationRefKey() {
  return crypto.createHmac('sha256', String(ageVerificationSecret())).update('oa:admin-conversation-ref:v1').digest();
}
export function sealConversationRef(conversationId) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', conversationRefKey(), iv);
  const body = Buffer.concat([cipher.update(String(conversationId), 'utf8'), cipher.final()]);
  return CONVERSATION_REF_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}
/** The conversation id a panel-supplied id or sealed reference names, or null when a reference does not open. */
export function openConversationRef(value) {
  if (typeof value !== 'string' || !value) return null;
  if (!value.startsWith(CONVERSATION_REF_PREFIX)) return value;
  if (value.length > 800) return null;
  try {
    const raw = Buffer.from(value.slice(CONVERSATION_REF_PREFIX.length), 'base64url');
    if (raw.length < 29) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', conversationRefKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const id = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    return id && id.length <= 300 ? id : null;
  } catch {
    return null;
  }
}
// The id the panel is given for a conversation: sealed when any participant's
// account is gone.
function panelConversationId(id, participantIds, people) {
  const gone = (participantIds || []).some((p) => p == null || !people.has(String(p)));
  return gone ? sealConversationRef(id) : String(id);
}

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
  const { messageId } = b;
  // The panel sends back whatever id the lookup gave it: a plain id, or a
  // sealed reference for a thread with a deleted participant.
  const conversationId = typeof b.conversationId === 'string' && b.conversationId.length <= 800 ? openConversationRef(b.conversationId) : null;
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
    // requires be preserved (round-8 media#1).
    //
    // The audit row and the request's `takedowns` entry are written in this
    // SAME transaction (round-15 media#0 / social#0), as for DMs and wall
    // comments. They used to go in a second transaction after the blob
    // deletes, so a function killed or a connection dropped in between left
    // the listing removed with no record of who removed it -- and a retry
    // only answers 'already_gone', which cannot resolve the request.
    //
    // Whenever the takedown is attributed, the request row is locked FIRST
    // (not only when quarantining), so recordNciiTakedown's UPDATE never takes
    // the report lock after the file and listing locks: the order stays
    // report -> files -> listing rows, as preserveMediaForReportTx and the
    // message/wall branch take it.
    const out = await withTransaction(async (client) => {
      if (ncii) {
        const { rows } = await client.query('select id from ncii_reports where id = $1 for update', [ncii.id]);
        if (!rows.length) throw Object.assign(new Error('Report not found'), { code: NCII_REPORT_NOT_FOUND });
      }
      const done = await takeDownListing(target.listingId, {
        client,
        preserve: quarantine
          ? (c, items) => (ncii
            ? preserveMediaForReportTx(c, ncii.id, items, { reason: `takedown #${ncii.id}: listing ${target.listingId}` })
            : preserveMedia(items, { reportId: null, reason: `admin takedown: listing ${target.listingId}`, preservedBy: by, client: c }))
          : null,
      });
      // Only when THIS call deleted the files: a listing an earlier takedown
      // already emptied comes back with removed: null (alreadyRemoved), so a
      // mistyped id cannot count as the takedown a request is resolved on
      // (round-11 media#0).
      const txResult = done.removed ? 'removed' : 'already_gone';
      const txSnapshot = done.listing ? snapshotListing(done.listing) : null;
      const actionId = await recordTakedownAction(client, {
        target, result: txResult, preserved: done.preserved || [], snapshot: txSnapshot, by, ncii,
      });
      return { ...done, result: txResult, snapshot: txSnapshot, actionId };
    });
    snapshot = out.snapshot;
    preserved = out.preserved || [];
    result = out.result;
    // After the commit; deleteMediaQuietly re-checks preservation and skips
    // the quarantined files. A failure here leaves the files recorded as
    // delete_pending for the orphan sweep -- the takedown and its record are
    // already committed.
    if (out.files.length) await deleteMediaQuietly(out.files);
    if (preserved.length) await movePreservedToEvidence({ limit: Math.min(preserved.length, 200) });
    return { result, preserved: preserved.length, snapshot, actionId: out.actionId, reportRef: ncii ? reportRef('ncii', ncii.id) : null };
  } else if (target.type === 'message' || target.type === 'wall_post') {
    // ONE transaction: the copy is written to moderation_actions (and onto the
    // request) in the same commit that removes the item, so the item is never
    // gone without its copy. The copy used to be kept only in memory and
    // written by a SECOND transaction after the removal had committed -- a
    // connection error or a killed function in between lost the only record
    // of a DM or comment named in a TAKE IT DOWN request (round-14 media#0).
    // The request row is locked first (report -> item), as for listings.
    const actionId = await withTransaction(async (client) => {
      if (ncii) {
        const { rows } = await client.query('select id from ncii_reports where id = $1 for update', [ncii.id]);
        if (!rows.length) throw Object.assign(new Error('Report not found'), { code: NCII_REPORT_NOT_FOUND });
      }
      if (target.type === 'message') {
        const gone = await removeConversationMessage(target.conversationId, target.messageId, {
          client,
          // The copy lists a participant whose account is gone as null
          // (snapshotMessage, round-20 media#0 / social#0): the stored
          // conversation row still names them.
          beforeRemove: async (c, m) => {
            const { rows } = await c.query('select data from conversations where id = $1', [target.conversationId]);
            snapshot = await snapshotMessage(m, { conversationId: target.conversationId, participantIds: rows[0]?.data?.participantIds }, c);
          },
        });
        if (gone) result = 'removed';
      } else {
        // The reports on this comment are locked BEFORE the wall_posts row
        // (round-17 media#0 / social#1): ncii_reports -> reports -> wall_posts,
        // the order deleteWallPost and reports-resolve's in-product removal
        // take. Locking wall_posts first here, then the reports inside
        // deleteWallPost, inverted it, so a takedown racing a Remove Content
        // on a report of the same comment deadlocked.
        await client.query(
          `select 1 from reports where data->>'targetType' = 'wall_post' and data->>'targetId' = $1 order by id for update`,
          [String(target.postId)],
        );
        const { rows } = await client.query('select data from wall_posts where id = $1 for update', [target.postId]);
        if (rows.length) {
          snapshot = await snapshotWallPost(rows[0].data, client);
          await deleteWallPost(target.postId, 'admin', { isWallOwner: true, client });
          result = 'removed';
        }
      }
      return recordTakedownAction(client, { target, result, preserved, snapshot, by, ncii });
    });
    return { result, preserved: 0, snapshot, actionId, reportRef: ncii ? reportRef('ncii', ncii.id) : null };
  }
  throw Object.assign(new Error('Unknown target type'), { code: TAKEDOWN_INVALID });
}

/**
 * Writes one takedown to moderation_actions and, when attributed, onto the
 * request (`takedowns` + `history`), on the caller's transaction. Returns the
 * action id.
 */
async function recordTakedownAction(client, { target, result, preserved, snapshot, by, ncii }) {
  const entry = {
    type: target.type,
    target,
    result,
    preserved: preserved.length,
    snapshot,
    by,
  };
  const { rows } = await client.query(
    'insert into moderation_actions (data) values ($1) returning id',
    [{ action: 'content_takedown', ...entry, nciiReportId: ncii?.id || null, at: new Date().toISOString() }],
  );
  if (ncii) await recordNciiTakedown(ncii.id, { ...entry, actionId: String(rows[0].id) }, client);
  return String(rows[0].id);
}

/**
 * The audit trail, newest first (admin only), as the admin API returns it:
 * without a DM takedown's conversation id (lib/ncii-reports-store.js
 * adminTakedownEntryView) and with a copy's participant whose account has
 * since been deleted read as null. The stored rows are unchanged -- they are
 * the audit record.
 */
export async function listModerationActions({ nciiReportId = null, limit = 200 } = {}) {
  const { rows } = await query(
    `select id, data, created_at from moderation_actions
      where ($1::text is null or data->>'nciiReportId' = $1::text)
      order by id desc limit $2`,
    [nciiReportId === null || nciiReportId === undefined ? null : String(nciiReportId), Math.max(1, Math.min(Number(limit) || 200, 1000))],
  );
  const actions = rows.map((r) => ({ id: String(r.id), ...r.data, createdAt: r.created_at }));
  const ids = new Set();
  for (const a of actions) {
    if (Array.isArray(a.snapshot?.participantIds)) for (const p of a.snapshot.participantIds) if (p != null) ids.add(String(p));
  }
  let live = new Set();
  if (ids.size) {
    const { rows: people } = await query('select id from users where id = any($1::text[])', [[...ids]]);
    live = new Set(people.map((u) => String(u.id)));
  }
  return actions.map((a) => {
    const view = adminTakedownEntryView(a);
    if (Array.isArray(view.snapshot?.participantIds)) {
      view.snapshot = { ...view.snapshot, participantIds: view.snapshot.participantIds.map((p) => (p != null && live.has(String(p)) ? String(p) : null)) };
    }
    return view;
  });
}

/** The takedown result as the admin API returns it: the copy without the conversation id. */
export function adminTakedownResultView(out) {
  if (!out || typeof out !== 'object') return out;
  return { ...out, snapshot: adminTakedownEntryView({ snapshot: out.snapshot }).snapshot ?? out.snapshot };
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

// A deleted account is returned WITHOUT its id (round-19 admin-ui#0): a purged
// account's id is how a deleted reporter was re-identified from a report's
// DM thread, and the admin panel has nothing to do with it -- the thread and
// message ids are what a takedown uses.
function accountOrGone(map, id) {
  return map.get(String(id)) || { userId: null, login: null, role: null, creatorId: null, deleted: true };
}

// A message's senderId, or null when the sender's account is deleted -- the
// same rule as accountOrGone: a purged account's id is never returned
// (round-19 admin-ui#0). `self` is the account the lookup is about (known live).
function liveSenderId(senderId, people, self = null) {
  const id = String(senderId ?? '');
  if (!id) return null;
  return (self != null && id === String(self)) || people.has(id) ? id : null;
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
 *
 * Paged by a KEYSET cursor (round-14 social#1): `cursor` is the `nextCursor`
 * of the previous page -- (updated_at at full microsecond precision, id) --
 * and the next page is the rows strictly after it in (updated_at desc, id
 * desc) order. OFFSET paging re-returned a row and skipped one whenever a
 * conversation got a new message while the admin paged (it jumps to the top
 * and every row after it shifts down). A conversation that moved to the top
 * since page one is on page one, not a later page: reload the first page to
 * see it. `offset` is still accepted (and `nextOffset` still returned) for a
 * client that has not switched yet; `cursor` wins when both are given.
 */
function encodeLookupCursor(r) {
  if (!r?.cursor_at || r.id === undefined || r.id === null) return null;
  return Buffer.from(JSON.stringify([r.cursor_at, String(r.id)]), 'utf8').toString('base64url');
}

function decodeLookupCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor || cursor.length > 600) return null;
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof at !== 'string' || typeof id !== 'string' || !id || id.length > 300 || Number.isNaN(new Date(at).getTime())) return null;
    return { at, id };
  } catch {
    return null;
  }
}

export async function lookupConversationsFor(userId, { offset = 0, cursor = null, limit = 50 } = {}) {
  const uid = String(userId ?? '');
  if (!uid) return { conversations: [], hasMore: false, nextCursor: null, nextOffset: null };
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 100);
  const after = decodeLookupCursor(cursor);
  const skip = after ? 0 : Math.max(Number.parseInt(offset, 10) || 0, 0);
  const { rows } = await query(
    `select id, updated_at,
            to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at,
            data->'participantIds' as participants,
            jsonb_array_length(coalesce(data->'messages', '[]'::jsonb)) as message_count,
            data->'messages'->-1 as last_message
       from conversations
      where data->'participantIds' ? $1
        and ($4::timestamptz is null or (updated_at, id) < ($4::timestamptz, $5::text))
      order by updated_at desc, id desc
      offset $2 limit $3`,
    [uid, skip, size + 1, after?.at ?? null, after?.id ?? null],
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
        id: panelConversationId(r.id, Array.isArray(r.participants) ? r.participants.map(String) : [], new Map([...people, [uid, true]])),
        other: other ? accountOrGone(people, other) : null,
        messageCount: Number(r.message_count) || 0,
        lastMessage: last ? { id: String(last.id ?? ''), senderId: liveSenderId(last.senderId, people, uid), text: String(last.text ?? ''), createdAt: last.createdAt || null } : null,
        updatedAt: r.updated_at,
      };
    }),
    hasMore,
    nextCursor: hasMore && page.length ? encodeLookupCursor(page[page.length - 1]) : null,
    nextOffset: hasMore ? skip + size : null,
  };
}

/**
 * One conversation, a page of its messages with their ids, by conversation id
 * or by its two participants (the id is computed here -- nobody has to know
 * the format). Returns null when there is no such conversation.
 *
 * Paged, newest page first (round-13 social#0): a thread keeps up to 500
 * messages of up to 2,000 characters, and returning them all in one body
 * could pass the platform's 4.5 MB response limit, leaving the admin unable
 * to find the message id a TAKE IT DOWN takedown needs. `before` is a message
 * id: the page holds the `limit` (default 100, at most 100) messages just
 * older than it, in chronological order. An unknown `before` (the message was
 * taken down, or aged out of the thread, since the page was loaded) is an
 * empty page flagged `stale: true` -- never a silent "nothing older" -- and
 * the route answers 409 { code: 'stale_cursor' } so the panel reloads from
 * the newest page (round-14 social#0 / admin-ui#0).
 * { conversationId } | { userA, userB } [, before, limit] ->
 * { id, participants: [<account>], messageCount,
 *   messages: [{ id, senderId (null for a deleted sender), text, createdAt, priceCents? }], hasMore, nextBefore, stale? }
 */
export const CONVERSATION_LOOKUP_PAGE = 100;

export async function lookupConversation({ conversationId, userA, userB, before = null, limit = CONVERSATION_LOOKUP_PAGE } = {}) {
  let id = null;
  if (typeof conversationId === 'string' && conversationId && conversationId.length <= 800) {
    const opened = openConversationRef(conversationId);
    if (opened && opened.length <= 300) id = opened;
  }
  else if (typeof userA === 'string' && typeof userB === 'string' && LOOKUP_ID.test(userA.trim()) && LOOKUP_ID.test(userB.trim())
    && userA.trim() !== userB.trim()) id = conversationIdBetween(userA.trim(), userB.trim());
  if (!id) return null;
  const { rows } = await query('select id, data from conversations where id = $1', [id]);
  if (!rows.length) return null;
  const c = rowToRecord(rows[0]);
  const participantIds = Array.isArray(c.participantIds) ? c.participantIds.map(String) : [];
  const people = await accountsById(participantIds);
  const all = (Array.isArray(c.messages) ? c.messages : []).filter((m) => m && m.id);
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || CONVERSATION_LOOKUP_PAGE, 1), CONVERSATION_LOOKUP_PAGE);
  let end = all.length;
  let stale = false;
  if (typeof before === 'string' && before) {
    const at = all.findIndex((m) => String(m.id) === before);
    stale = at === -1;
    end = stale ? 0 : at;
  }
  const startAt = Math.max(0, end - size);
  const page = all.slice(startAt, end);
  const hasMore = startAt > 0;
  return {
    id: panelConversationId(c.id, participantIds, people),
    participants: participantIds.map((p) => accountOrGone(people, p)),
    messageCount: all.length,
    messages: page.map((m) => ({
      id: String(m.id),
      senderId: liveSenderId(m.senderId, people),
      text: String(m.text ?? ''),
      createdAt: m.createdAt || null,
      ...(m.priceCents ? { priceCents: Number(m.priceCents) } : {}),
    })),
    hasMore,
    nextBefore: hasMore && page.length ? String(page[0].id) : null,
    ...(stale ? { stale: true } : {}),
  };
}
