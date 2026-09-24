import { query, rowToRecord, rowsToRecords, withTransaction } from './db';
import { effectiveCreatorStatus } from './creator-status';
import { transferWithFee, INSUFFICIENT_BALANCE } from './credits-store';
import { FEES } from './fees';
import { DM_PRICE_FLOOR_CENTS } from './brand';
import { DM_PRICE_MAX_CENTS } from './field-validation';

/**
 * Direct messages.
 *
 * Who may message whom, and what it costs (the founder's decisions, see
 * MEMORY.md "messaging a creator is never free"):
 *
 *   fan     -> creator  paid: max(DM_FLOOR_CENTS, creator.dmPriceCents)
 *                       credits, the creator earns it less the standard 10%
 *                       platform fee. Charged in the SAME transaction that
 *                       stores the message, so a fan can never pay for a
 *                       message that was not delivered, or the reverse.
 *   creator -> fan      free, but only a reply: into a conversation the fan
 *                       has written in, or to a fan who has bought from them.
 *                       No cold messaging strangers.
 *   fan     -> fan      refused.
 *   creator -> creator  free.
 *
 * "Creator" above means an APPROVED creator: an account whose creator
 * profile is pending (or a seed/demo profile) sends as a fan -- pays to
 * message a creator and cannot message fans.
 *
 * A suspended or banned creator cannot send at all (Terms section 7: they
 * "can't post"). The recipient's creator profile must be live (active, not a
 * seed/demo account) for a fan to pay it.
 *
 * Storage is still one jsonb row per pair, appended inside the database. It
 * is bounded now: the row keeps the most recent MAX_STORED_MESSAGES, and
 * nothing returns a whole history -- the inbox gets summaries and a thread is
 * paginated. That unbounded row, returned in full on every inbox load, is how
 * one account could flood a creator's inbox past the response-size limit
 * until it stopped loading at all.
 */

export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_STORED_MESSAGES = 500;
export const THREAD_PAGE_SIZE = 50;
export const SUMMARY_MESSAGES = 10;
// The floor Terms section 5 and /token quote (lib/brand.js) and the ceiling
// the profile editors accept (lib/field-validation.js) -- imported, not
// retyped, so the price a fan is charged can never drift from the one they
// were told or the one a creator was allowed to set.
export const DM_FLOOR_CENTS = DM_PRICE_FLOOR_CENTS;
export const DM_MAX_CENTS = DM_PRICE_MAX_CENTS;

export const DM_ERRORS = {
  EMPTY: 'dm_empty',
  TOO_LONG: 'dm_too_long',
  SELF: 'dm_self',
  RECIPIENT_NOT_FOUND: 'dm_recipient_not_found',
  RECIPIENT_UNAVAILABLE: 'dm_recipient_unavailable',
  FAN_TO_FAN: 'dm_fan_to_fan',
  NOT_ALLOWED: 'dm_not_allowed',
  SENDER_RESTRICTED: 'dm_sender_restricted',
  INSUFFICIENT_BALANCE,
};

function dmError(code, message) {
  return Object.assign(new Error(message), { code });
}

function pairId(a, b) {
  return [String(a), String(b)].sort().join('__');
}

/** What a fan pays to message this creator, in cents. */
export function dmPriceCentsFor(creator) {
  const price = Number(creator?.dmPriceCents);
  if (!Number.isInteger(price) || price < DM_FLOOR_CENTS) return DM_FLOOR_CENTS;
  return Math.min(price, DM_MAX_CENTS);
}

function isCreatorAccount(user) {
  return !!user && user.role === 'creator' && !!user.creatorId;
}

async function loadCreator(creatorId, client = null) {
  const run = client ? (t, p) => client.query(t, p) : query;
  const { rows } = await run('select id, data from creators where id = $1', [String(creatorId)]);
  return rows.length ? rowToRecord(rows[0]) : null;
}

/**
 * Why this account may not post anything right now (DMs, wall comments), or
 * null. Only a creator account can be restricted: the enforcement ladder
 * (30-day suspension, then a permanent ban) is applied to creator profiles.
 * Pending creators are NOT restricted -- they need to be able to talk to
 * people while they finish their profile.
 */
export function restrictionMessageFor(creator) {
  const status = effectiveCreatorStatus(creator);
  if (status === 'banned') {
    return 'This account has been permanently banned and can no longer post or send messages.';
  }
  if (status === 'suspended') {
    const until = creator.suspendedUntil ? new Date(creator.suspendedUntil) : null;
    return until && !Number.isNaN(until.getTime())
      ? `This account is suspended until ${until.toLocaleDateString()} and can't post or send messages until then.`
      : "This account is suspended and can't post or send messages right now.";
  }
  return null;
}

export async function senderRestriction(user) {
  if (!user?.creatorId) return null;
  const creator = await loadCreator(user.creatorId);
  return creator ? restrictionMessageFor(creator) : null;
}

export async function getConversations() {
  const { rows } = await query('select id, data from conversations order by id');
  return rowsToRecords(rows);
}

export async function getConversationBetween(userA, userB) {
  const { rows } = await query(
    'select id, data, updated_at from conversations where id = $1',
    [pairId(userA, userB)],
  );
  return rows.length ? { ...rowToRecord(rows[0]), updatedAt: rows[0].updated_at } : null;
}

/**
 * A page of the user's conversations, most recently active first. `before`
 * is the opaque `cursor` of the last row of the previous page.
 *
 * The cursor is (updated_at at full microsecond precision, id), compared as
 * a row value. A plain `updated_at < <JS Date>` cursor lost rows: a JS Date
 * truncates timestamptz to milliseconds, and two conversations sharing a
 * timestamp had no tiebreaker, so rows fell between pages.
 */
export function encodeConversationCursor(row) {
  if (!row?.cursorAt || !row?.id) return null;
  return Buffer.from(JSON.stringify([row.cursorAt, String(row.id)])).toString('base64url');
}

function decodeConversationCursor(before) {
  if (typeof before !== 'string' || !before || before.length > 300) return null;
  try {
    const [at, id] = JSON.parse(Buffer.from(before, 'base64url').toString('utf8'));
    if (typeof at !== 'string' || typeof id !== 'string' || Number.isNaN(new Date(at).getTime())) return null;
    return { at, id };
  } catch {
    return null;
  }
}

export async function getConversationsForUser(userId, { limit = 50, before = null } = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const cursor = decodeConversationCursor(before);
  const { rows } = await query(
    `select id, data, updated_at,
            to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
       from conversations
      where data->'participantIds' ? $1
        and ($3::timestamptz is null or (updated_at, id) < ($3::timestamptz, $4::text))
      order by updated_at desc, id desc
      limit $2`,
    [String(userId), pageSize, cursor?.at ?? null, cursor?.id ?? null],
  );
  return rows.map((row) => ({ ...rowToRecord(row), updatedAt: row.updated_at, cursorAt: row.cursor_at }));
}

function lastReadAtFor(conversation, userId) {
  const at = conversation?.lastReadAt?.[String(userId)];
  return at ? new Date(at).getTime() : 0;
}

function unreadCountFor(conversation, userId) {
  const since = lastReadAtFor(conversation, userId);
  return (conversation?.messages || []).filter(
    (m) => String(m.senderId) !== String(userId) && new Date(m.createdAt).getTime() > since,
  ).length;
}

function publicMessage(m) {
  return {
    id: m.id,
    senderId: m.senderId,
    text: m.text,
    createdAt: m.createdAt,
    ...(m.priceCents ? { priceCents: m.priceCents } : {}),
  };
}

/**
 * The shape every endpoint returns: never the whole stored history.
 * `messages` is the last `limit` messages (oldest first), optionally only
 * those before the message id `before`; `hasMore` says whether older ones
 * exist in storage.
 */
export function projectConversation(conversation, viewerId, { limit = THREAD_PAGE_SIZE, before = null } = {}) {
  const all = conversation?.messages || [];
  let end = all.length;
  if (before) {
    const idx = all.findIndex((m) => m.id === before);
    if (idx >= 0) end = idx;
  }
  const size = Math.min(Math.max(Number(limit) || THREAD_PAGE_SIZE, 1), 200);
  const start = Math.max(0, end - size);
  const last = all[all.length - 1] || null;
  return {
    id: conversation?.id || null,
    participantIds: conversation?.participantIds || [],
    messages: all.slice(start, end).map(publicMessage),
    hasMore: start > 0,
    lastMessage: last ? publicMessage(last) : null,
    unreadCount: unreadCountFor(conversation, viewerId),
    updatedAt: conversation?.updatedAt || null,
  };
}

/** Records that `userId` has read the thread up to now (drives unreadCount). */
export async function markConversationRead(userId, otherUserId) {
  await query(
    `update conversations
        set data = jsonb_set(
              data, '{lastReadAt}',
              coalesce(data->'lastReadAt', '{}'::jsonb) || jsonb_build_object($2::text, $3::text))
      where id = $1`,
    [pairId(userId, otherUserId), String(userId), new Date().toISOString()],
  );
}

/**
 * Whether a creator may message this fan: the fan has written in their
 * conversation, or has bought from them.
 */
async function creatorMayMessageFan(client, conversation, creatorId, fanId) {
  const senders = conversation?.senders || [];
  if (senders.map(String).includes(String(fanId))) return true;
  if ((conversation?.messages || []).some((m) => String(m.senderId) === String(fanId))) return true;
  const { rows } = await client.query(
    `select 1 from orders where data->>'buyerId' = $1 and data->>'creatorId' = $2 limit 1`,
    [String(fanId), String(creatorId)],
  );
  return rows.length > 0;
}

/**
 * Sends one message, enforcing every rule in the header comment.
 *
 * `sender` is the full user record of the logged-in sender. `clientMessageId`
 * (optional, <= 64 chars) makes a retry idempotent: the same id from the
 * same sender in the same conversation returns the stored message and
 * charges nothing the second time.
 *
 * Returns { conversation (raw record), message, chargedCents, duplicate }.
 * Throws an Error with a DM_ERRORS `.code` for every refusal.
 */
export async function sendDirectMessage({ sender, recipientId, text, clientMessageId = null }) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) throw dmError(DM_ERRORS.EMPTY, 'Message cannot be empty');
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    throw dmError(DM_ERRORS.TOO_LONG, `That message is too long (${MAX_MESSAGE_LENGTH} characters maximum).`);
  }
  if (!sender?.id) throw dmError(DM_ERRORS.NOT_ALLOWED, 'Not logged in');
  const fromId = String(sender.id);
  const toId = String(recipientId ?? '');
  if (!toId) throw dmError(DM_ERRORS.RECIPIENT_NOT_FOUND, 'That account does not exist.');
  if (fromId === toId) throw dmError(DM_ERRORS.SELF, 'Cannot message yourself');
  const idemKey = typeof clientMessageId === 'string' && clientMessageId.trim()
    ? clientMessageId.trim().slice(0, 64)
    : null;

  const { rows: recipientRows } = await query('select id, data from users where id = $1', [toId]);
  if (!recipientRows.length) throw dmError(DM_ERRORS.RECIPIENT_NOT_FOUND, 'That account does not exist.');
  const recipient = rowToRecord(recipientRows[0]);

  const recipientIsCreator = isCreatorAccount(recipient);

  // A creator ACCOUNT is not the same as a creator: every account that ticks
  // "creator" at signup gets a creatorId straight away, with a pending
  // profile. Treating that as a creator here made creator<->creator (free)
  // the price of messaging anyone for anyone willing to tick a box, which
  // undoes the paid-DM rule entirely. Only an approved (effective status
  // 'active'), non-seed/demo creator profile gets creator privileges when
  // SENDING; anyone else is priced and permissioned exactly like a fan.
  let senderCreator = null;
  if (sender.creatorId) {
    senderCreator = await loadCreator(sender.creatorId);
    const restricted = senderCreator ? restrictionMessageFor(senderCreator) : null;
    if (restricted) throw dmError(DM_ERRORS.SENDER_RESTRICTED, restricted);
  }
  const senderIsCreator = isCreatorAccount(sender)
    && !!senderCreator
    && senderCreator.seed !== true
    && senderCreator.demo !== true
    && effectiveCreatorStatus(senderCreator) === 'active';

  if (!senderIsCreator && !recipientIsCreator) {
    if (sender.creatorId) {
      throw dmError(DM_ERRORS.NOT_ALLOWED, 'You can message fans once your creator profile is approved.');
    }
    throw dmError(DM_ERRORS.FAN_TO_FAN, 'Messages can only be sent to creators.');
  }

  // Fan -> creator is the paid direction. Priced off the creator record as
  // it stands right now, never off anything the client sent.
  let priceCents = 0;
  let recipientCreator = null;
  if (!senderIsCreator && recipientIsCreator) {
    recipientCreator = await loadCreator(recipient.creatorId);
    if (!recipientCreator || recipientCreator.seed === true || recipientCreator.demo === true
      || effectiveCreatorStatus(recipientCreator) !== 'active') {
      throw dmError(DM_ERRORS.RECIPIENT_UNAVAILABLE, "This creator isn't accepting messages right now.");
    }
    priceCents = dmPriceCentsFor(recipientCreator);
  }

  const id = pairId(fromId, toId);
  const now = new Date().toISOString();
  const message = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    senderId: fromId,
    text: trimmed,
    createdAt: now,
    ...(idemKey ? { clientMessageId: idemKey } : {}),
    ...(priceCents ? { priceCents } : {}),
  };

  return withTransaction(async (client) => {
    // Create the row if this is the first message, then lock it: every
    // check below (idempotency, "has the fan written here") and the append
    // itself happen against a row nobody else can change underneath.
    await client.query(
      `insert into conversations (id, data) values ($1, $2)
       on conflict (id) do nothing`,
      [id, { id, participantIds: [fromId, toId], messages: [], senders: [] }],
    );
    const { rows } = await client.query('select id, data from conversations where id = $1 for update', [id]);
    const current = rowToRecord(rows[0]);

    if (idemKey) {
      const dup = (current.messages || []).find(
        (m) => m.clientMessageId === idemKey && String(m.senderId) === fromId,
      );
      if (dup) return { conversation: current, message: dup, chargedCents: 0, duplicate: true };
    }

    if (senderIsCreator && !recipientIsCreator) {
      const allowed = await creatorMayMessageFan(client, current, sender.creatorId, toId);
      if (!allowed) {
        throw dmError(DM_ERRORS.NOT_ALLOWED, 'You can message fans who have written to you or bought from you.');
      }
    }

    if (priceCents > 0) {
      await transferWithFee({
        fromUserId: fromId,
        toUserId: toId,
        cents: priceCents,
        feeBps: FEES.DEFAULT_BPS,
        type: 'dm',
        meta: { conversationId: id, messageId: message.id, creatorId: String(recipient.creatorId) },
      }, client);
    }

    const { rows: updated } = await client.query(
      `update conversations
          set data = jsonb_set(
                jsonb_set(
                  jsonb_set(
                    data,
                    '{messages}',
                    coalesce((
                      select jsonb_agg(m order by ord)
                        from jsonb_array_elements(coalesce(data->'messages', '[]'::jsonb) || $2::jsonb)
                             with ordinality as t(m, ord)
                       where ord > jsonb_array_length(coalesce(data->'messages', '[]'::jsonb)) + 1 - $3::int
                    ), '[]'::jsonb)
                  ),
                  '{senders}',
                  (select coalesce(jsonb_agg(distinct s), '[]'::jsonb)
                     from jsonb_array_elements_text(coalesce(data->'senders', '[]'::jsonb) || jsonb_build_array($4::text)) as s)
                ),
                '{lastReadAt}',
                coalesce(data->'lastReadAt', '{}'::jsonb) || jsonb_build_object($4::text, $5::text)
              ),
              updated_at = now()
        where id = $1
        returning id, data`,
      [id, JSON.stringify([message]), MAX_STORED_MESSAGES, fromId, now],
    );
    return { conversation: rowToRecord(updated[0]), message, chargedCents: priceCents, duplicate: false };
  });
}

/**
 * @deprecated Kept for callers/tests that predate paid DMs: appends without
 * any authorization or charge. Every HTTP path goes through
 * sendDirectMessage(); do not wire this to a route.
 */
export async function sendMessage(fromUserId, toUserId, text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Message cannot be empty');
  if (String(fromUserId) === String(toUserId)) throw new Error('Cannot message yourself');

  const id = pairId(fromUserId, toUserId);
  const message = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    senderId: String(fromUserId),
    // Defense in depth only: the HTTP path refuses over-long text outright
    // (sendDirectMessage) rather than silently cutting it.
    text: trimmed.slice(0, MAX_MESSAGE_LENGTH),
    createdAt: new Date().toISOString(),
  };

  return withTransaction(async (client) => {
    await client.query(
      `insert into conversations (id, data) values ($1, $2) on conflict (id) do nothing`,
      [id, { id, participantIds: [String(fromUserId), String(toUserId)], messages: [], senders: [] }],
    );
    const { rows } = await client.query(
      `update conversations
          set data = jsonb_set(
                jsonb_set(
                  data, '{messages}',
                  coalesce((
                    select jsonb_agg(m order by ord)
                      from jsonb_array_elements(coalesce(data->'messages', '[]'::jsonb) || $2::jsonb)
                           with ordinality as t(m, ord)
                     where ord > jsonb_array_length(coalesce(data->'messages', '[]'::jsonb)) + 1 - $3::int
                  ), '[]'::jsonb)
                ),
                '{senders}',
                (select coalesce(jsonb_agg(distinct s), '[]'::jsonb)
                   from jsonb_array_elements_text(coalesce(data->'senders', '[]'::jsonb) || jsonb_build_array($4::text)) as s)
              ),
              updated_at = now()
        where id = $1
        returning id, data`,
      [id, JSON.stringify([message]), MAX_STORED_MESSAGES, String(fromUserId)],
    );
    return rowToRecord(rows[0]);
  });
}
