import { query, rowToRecord, rowsToRecords, withTransaction } from './db';
import { effectiveCreatorStatus, isDemoCreator } from './creator-status';
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
 * "Creator" above means an APPROVED creator, on BOTH ends: an account whose
 * creator profile is pending, suspended, banned or seed/demo sends as a fan
 * (pays to message a creator, cannot message fans) and is messaged as a fan
 * (an approved creator may only reply to them -- a creator-role account the
 * platform itself treats as a fan is not a free cold-message target).
 * resolveDmTerms() is the one place these roles and the price are worked
 * out; the send and the price quoted before a send (quoteDmPrice) both use
 * it, so the quote and the charge cannot diverge.
 *
 * PRICE CONFIRMATION. A paid send must carry `expectedPriceCents`, the price
 * the fan was shown. If it differs from the price now (the creator changed it
 * while the chat was open), the send is refused with PRICE_CHANGED and the
 * current price, and nothing is charged -- the same rule marketplace checkout
 * applies. A missing expected price counts as a mismatch.
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
  PRICE_CHANGED: 'dm_price_changed',
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

/** An approved creator profile: live, and not one of the platform's own demo/seed profiles. */
function isApprovedCreator(creator) {
  return !!creator && !isDemoCreator(creator) && effectiveCreatorStatus(creator) === 'active';
}

/**
 * Who the two sides are and what a message from `sender` to `recipient` (both
 * full user records) costs. Does NOT look at the conversation, so the
 * "creator may only reply to a fan" check is left to the send (flagged as
 * `replyOnly`).
 *
 * Returns { priceCents, replyOnly, senderIsCreator, recipientIsCreator,
 * recipientCreator } or throws a DM_ERRORS error for a send that can never be
 * allowed (restricted sender, fan -> fan, a creator who isn't taking
 * messages).
 */
async function resolveDmTerms(sender, recipient, client = null) {
  let senderCreator = null;
  if (sender?.creatorId) {
    senderCreator = await loadCreator(sender.creatorId, client);
    const restricted = senderCreator ? restrictionMessageFor(senderCreator) : null;
    if (restricted) throw dmError(DM_ERRORS.SENDER_RESTRICTED, restricted);
  }
  // A creator ACCOUNT is not the same as a creator: every account that ticks
  // "creator" at signup gets a creatorId straight away, with a pending
  // profile. Treating that as a creator made creator<->creator (free) the
  // price of messaging anyone for anyone willing to tick a box.
  const senderIsCreator = isCreatorAccount(sender) && isApprovedCreator(senderCreator);

  const recipientCreator = isCreatorAccount(recipient) ? await loadCreator(recipient.creatorId, client) : null;
  const recipientIsCreator = isCreatorAccount(recipient) && isApprovedCreator(recipientCreator);

  if (senderIsCreator) {
    // creator -> creator is free; creator -> anyone else (a fan, or a creator
    // account that is not approved) is free but only as a reply.
    return { priceCents: 0, replyOnly: !recipientIsCreator, senderIsCreator, recipientIsCreator, recipientCreator };
  }
  if (isCreatorAccount(recipient)) {
    // Fan (or unapproved creator account) -> creator account: the paid
    // direction, and only to a creator who is actually live.
    if (!recipientIsCreator) {
      throw dmError(DM_ERRORS.RECIPIENT_UNAVAILABLE, "This creator isn't accepting messages right now.");
    }
    return { priceCents: dmPriceCentsFor(recipientCreator), replyOnly: false, senderIsCreator, recipientIsCreator, recipientCreator };
  }
  if (sender?.creatorId) {
    throw dmError(DM_ERRORS.NOT_ALLOWED, 'You can message fans once your creator profile is approved.');
  }
  throw dmError(DM_ERRORS.FAN_TO_FAN, 'Messages can only be sent to creators.');
}

/**
 * What `senderUser` would pay to message `recipientUser` right now, using the
 * exact rules the send applies. Returns
 *   { allowed: true, priceCents }           priceCents is 0 when free
 *   { allowed: false, priceCents: 0, code, reason }
 * A creator's reply to a fan is reported allowed; whether that particular
 * fan has written in is only known to the send.
 */
export async function quoteDmPrice(senderUser, recipientUser) {
  if (!senderUser?.id || !recipientUser?.id || String(senderUser.id) === String(recipientUser.id)) {
    return { allowed: false, priceCents: 0, code: DM_ERRORS.NOT_ALLOWED, reason: 'You cannot message this account.' };
  }
  try {
    const terms = await resolveDmTerms(senderUser, recipientUser);
    return { allowed: true, priceCents: terms.priceCents };
  } catch (err) {
    if (err?.code) return { allowed: false, priceCents: 0, code: err.code, reason: err.message };
    throw err;
  }
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
  // A `before` id that is no longer stored (the row keeps only the newest
  // MAX_STORED_MESSAGES, so paging back while new messages arrive can age it
  // out) returns an EMPTY page flagged `stale`, never the newest page again:
  // the client prepends what it gets, so the newest page came back as
  // duplicates in front of the thread with a "load older" that repeated it.
  let stale = false;
  if (before) {
    const idx = all.findIndex((m) => m.id === before);
    if (idx >= 0) end = idx;
    else {
      end = 0;
      stale = true;
    }
  }
  const size = Math.min(Math.max(Number(limit) || THREAD_PAGE_SIZE, 1), 200);
  const start = Math.max(0, end - size);
  const last = all[all.length - 1] || null;
  return {
    id: conversation?.id || null,
    participantIds: conversation?.participantIds || [],
    messages: all.slice(start, end).map(publicMessage),
    hasMore: start > 0,
    ...(stale ? { stale: true } : {}),
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
export async function sendDirectMessage({ sender, recipientId, text, clientMessageId = null, expectedPriceCents = undefined }) {
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

  // Roles and price, from the records as they stand right now -- never from
  // anything the client sent. See resolveDmTerms.
  const { priceCents, replyOnly, recipientCreator } = await resolveDmTerms(sender, recipient);

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

    if (replyOnly) {
      const allowed = await creatorMayMessageFan(client, current, sender.creatorId, toId);
      if (!allowed) {
        throw dmError(DM_ERRORS.NOT_ALLOWED, 'You can message fans who have written to you or bought from you.');
      }
    }

    // The fan agreed to a price; charge that price or nothing. Checked after
    // the idempotency lookup, so a retry of a message that already went
    // through returns it rather than tripping over a price changed since.
    if (priceCents > 0 && Number(expectedPriceCents) !== priceCents) {
      throw Object.assign(
        dmError(DM_ERRORS.PRICE_CHANGED, `This creator's message price is now ${priceCents} credits. Confirm the new price to send.`),
        { currentPriceCents: priceCents },
      );
    }

    if (priceCents > 0) {
      await transferWithFee({
        fromUserId: fromId,
        toUserId: toId,
        cents: priceCents,
        feeBps: FEES.DEFAULT_BPS,
        type: 'dm',
        meta: { conversationId: id, messageId: message.id, creatorId: String(recipientCreator?.id ?? recipient.creatorId) },
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
