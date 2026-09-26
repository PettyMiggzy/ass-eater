import crypto from 'crypto';
import { query, rowToRecord, rowsToRecords, withTransaction } from './db';
import { ageVerificationSecret } from './age-verification';
import { effectiveCreatorStatus, isDemoCreator } from './creator-status';
import { transferWithFee, INSUFFICIENT_BALANCE } from './credits-store';
import { FEES } from './fees';
import { DM_PRICE_FLOOR_CENTS } from './brand';
import { DM_PRICE_MAX_CENTS } from './field-validation';
import { userWriteRestriction } from './user-moderation';
import { sliceText, isWellFormedText } from './unicode-text';

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
 * BLOCKING. Either participant can block the other (setConversationBlocked);
 * a blocked sender is refused with DM_ERRORS.BLOCKED on the locked row,
 * before anything is charged. That is the remedy for unwanted messages,
 * including free creator <-> creator ones -- pricing is not.
 *
 * A creator can also block the anonymous author of a comment on their wall
 * (setWallBlocked). That is a SEPARATE record (the wall_blocks table): it
 * stops the author commenting on that wall and messaging that creator, but it
 * is never reported to the creator on a DM thread, a price quote or a send --
 * wall comments carry no author identity, and a block visible on a named
 * thread would name the author (round-10 social#0). The inbox lists it only as
 * an opaque handle row.
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
  MALFORMED: 'dm_malformed_text',
  SELF: 'dm_self',
  RECIPIENT_NOT_FOUND: 'dm_recipient_not_found',
  RECIPIENT_UNAVAILABLE: 'dm_recipient_unavailable',
  FAN_TO_FAN: 'dm_fan_to_fan',
  NOT_ALLOWED: 'dm_not_allowed',
  SENDER_RESTRICTED: 'dm_sender_restricted',
  PRICE_CHANGED: 'dm_price_changed',
  BLOCKED: 'dm_blocked',
  CONVERSATION_NOT_FOUND: 'dm_conversation_not_found',
  MESSAGE_NOT_FOUND: 'dm_message_not_found',
  INSUFFICIENT_BALANCE,
};

function dmError(code, message) {
  return Object.assign(new Error(message), { code });
}

function pairId(a, b) {
  return [String(a), String(b)].sort().join('__');
}

/**
 * The id of the conversation between two accounts (the sorted user ids joined
 * by '__'). Exported for admin tooling, which looks a thread up by its two
 * participants rather than asking a person to type this format.
 */
export function conversationIdBetween(userA, userB) {
  return pairId(userA, userB);
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
 * null, for a creator PROFILE: the enforcement ladder (30-day suspension,
 * then a permanent ban) is applied to creator profiles. Any account, fans
 * included, can also be restricted at the account level
 * (lib/user-moderation.js userWriteRestriction) -- senderRestriction and
 * resolveDmTerms check both.
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
  // Account-level moderation (any login, fans included -- lib/user-moderation.js).
  const accountRestricted = userWriteRestriction(sender);
  if (accountRestricted) throw dmError(DM_ERRORS.SENDER_RESTRICTED, accountRestricted);
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
    // The sender's own wall block of the recipient is deliberately NOT looked
    // at: a wall block never limits the blocker, and reporting it here would
    // name the anonymous commenter behind it.
    const block = (await blockStateBetween(senderUser.id, recipientUser.id))
      || ((await isWallBlocked(recipientUser.id, senderUser.id)) ? 'them' : null);
    if (block) return { allowed: false, priceCents: 0, code: DM_ERRORS.BLOCKED, reason: blockMessage(block) };
    return { allowed: true, priceCents: terms.priceCents };
  } catch (err) {
    if (err?.code) return { allowed: false, priceCents: 0, code: err.code, reason: err.message };
    throw err;
  }
}

export async function senderRestriction(user) {
  const accountRestricted = userWriteRestriction(user);
  if (accountRestricted) return accountRestricted;
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
 *
 * The cursor is SEALED (AES-256-GCM under a key derived from the root secret
 * with its own context string), not plain base64. The id half is the pair id
 * '<uidA>__<uidB>', so a readable cursor ending on a block-only row handed
 * the blocker the account id of the wall commenter they blocked -- the one
 * thing projectBlockOnlyConversation exists to withhold (request limit=1 and
 * decode nextBefore). A cursor that does not open (forged, truncated, minted
 * under an older secret) reads as "no cursor": the first page.
 */
function conversationCursorKey() {
  return crypto.createHmac('sha256', String(ageVerificationSecret())).update('oa:conv-cursor:v1').digest();
}

export function encodeConversationCursor(row) {
  if (!row?.cursorAt || !row?.id) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', conversationCursorKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify([row.cursorAt, String(row.id)]), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

function decodeConversationCursor(before) {
  if (typeof before !== 'string' || !before || before.length > 400) return null;
  try {
    const raw = Buffer.from(before, 'base64url');
    if (raw.length < 29) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', conversationCursorKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    const [at, id] = JSON.parse(plain);
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
        -- A row created only to hold a block (setConversationBlocked), with
        -- nothing ever sent in it, is not a thread: listing it would show
        -- the blocked account an empty conversation with whoever blocked it.
        -- It IS listed to the account that made the block, while that block
        -- stands -- the inbox is one place a block can be lifted. Unblocked,
        -- it drops out again. (Wall blocks are not rows here at all; the
        -- conversations endpoint appends them as opaque rows, listWallBlocksFor.)
        and not (data ? 'createdByBlock'
                 and jsonb_array_length(coalesce(data->'messages', '[]'::jsonb)) = 0
                 and not coalesce(data->'blockedBy', '[]'::jsonb) ? $1)
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
    // Per-conversation block (setConversationBlocked). The viewer learns that
    // they blocked the other side, or that the other side blocked them --
    // the send is refused either way, and saying why beats a mystery error.
    blockedByMe: blockedIds(conversation).includes(String(viewerId)),
    blockedByThem: blockedIds(conversation).some((id) => id !== String(viewerId)),
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
  // Refused rather than normalised, so the stored message is exactly the text
  // that was screened: a NUL or half an emoji cannot be stored as jsonb and
  // used to fail the conversation write after the charge, rolling back into a
  // 500 on every retry (round-11 social#1).
  if (!isWellFormedText(trimmed)) {
    throw dmError(DM_ERRORS.MALFORMED, 'Your message contains an invalid character (a control character or half of an emoji). Remove it and try again.');
  }
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    throw dmError(DM_ERRORS.TOO_LONG, `That message is too long (${MAX_MESSAGE_LENGTH} characters maximum).`);
  }
  if (!sender?.id) throw dmError(DM_ERRORS.NOT_ALLOWED, 'Not logged in');
  const fromId = String(sender.id);
  const toId = String(recipientId ?? '');
  if (!toId) throw dmError(DM_ERRORS.RECIPIENT_NOT_FOUND, 'That account does not exist.');
  if (fromId === toId) throw dmError(DM_ERRORS.SELF, 'Cannot message yourself');
  const idemKey = typeof clientMessageId === 'string' && clientMessageId.trim()
    ? sliceText(clientMessageId.trim(), 64)
    : null;

  // A retry of a message that already went through is answered FIRST, before
  // any of the checks below. Those read standing as it is NOW, so a paid
  // message whose response was lost, retried after the creator was suspended
  // (or the sender restricted) in between, used to be refused -- the fan told
  // it failed although it was delivered and charged. The lookup inside the
  // transaction below stays as the race-safe guard.
  if (idemKey) {
    const { rows: prior } = await query('select id, data from conversations where id = $1', [pairId(fromId, toId)]);
    if (prior.length) {
      const existing = rowToRecord(prior[0]);
      const dup = (existing.messages || []).find(
        (m) => m.clientMessageId === idemKey && String(m.senderId) === fromId,
      );
      if (dup) return { conversation: existing, message: dup, chargedCents: 0, duplicate: true };
    }
  }

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

    // A block is checked on the locked row and BEFORE any charge, so a
    // blocked fan is never charged for a message that is refused.
    const blocked = blockedIds(current);
    if (blocked.includes(toId)) throw dmError(DM_ERRORS.BLOCKED, blockMessage('them'));
    if (blocked.includes(fromId)) throw dmError(DM_ERRORS.BLOCKED, blockMessage('me'));
    // The recipient blocked this sender from their wall: refused the same
    // way, and it never mentions the wall (see setWallBlocked).
    if (await isWallBlocked(toId, fromId, client)) throw dmError(DM_ERRORS.BLOCKED, blockMessage('them'));

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

function blockedIds(conversation) {
  return Array.isArray(conversation?.blockedBy) ? conversation.blockedBy.map(String) : [];
}

function blockMessage(who) {
  return who === 'me'
    ? 'You blocked this account. Unblock them to send a message.'
    : "This account isn't accepting messages from you.";
}

/**
 * 'me' when `userId` blocked the other side, 'them' when blocked by them, else
 * null. A legacy block-only row's 'me' is not reported (see isBlockOnlyFor):
 * it may stand for an anonymous wall commenter.
 */
async function blockStateBetween(userId, otherUserId) {
  // Only what the check needs, not the stored messages themselves.
  const { rows } = await query(
    `select id, jsonb_build_object(
              'blockedBy', data->'blockedBy',
              'createdByBlock', data->'createdByBlock',
              'blockKind', data->'blockKind',
              'messages', case when jsonb_array_length(coalesce(data->'messages', '[]'::jsonb)) > 0
                               then '[0]'::jsonb else '[]'::jsonb end) as data
       from conversations where id = $1`,
    [pairId(userId, otherUserId)],
  );
  const row = rows.length ? rowToRecord(rows[0]) : null;
  const ids = blockedIds(row);
  if (ids.includes(String(otherUserId))) return 'them';
  if (ids.includes(String(userId)) && !isBlockOnlyFor(row, userId)) return 'me';
  return null;
}

/**
 * Blocks (or unblocks) the other side of `userId`'s conversation with
 * `otherUserId`. Stored as `blockedBy: [userId...]` on the conversation row;
 * while the recipient has blocked the sender, sendDirectMessage refuses with
 * DM_ERRORS.BLOCKED before any charge, and quoteDmPrice reports it as not
 * allowed. The remedy for unwanted messages -- deliberately not pricing:
 * creator <-> creator stays free. The same block also stops either side
 * commenting on the other's wall (blockBetween, pages/api/wall/post.js).
 *
 * This is a block BY USER ID (pages/api/messages/block.js): the caller already
 * knows who the other account is, so the block is reported back to them on
 * the thread (blockedByMe). Blocking a wall commenter is a different record,
 * setWallBlocked, which never is.
 *
 * A block does NOT need an existing conversation. Blocking an account with no
 * conversation creates the pair row (the same insert-if-missing
 * sendDirectMessage uses), marked `createdByBlock` (and `blockKind: 'dm'`) so
 * an empty one never shows up as a thread in the BLOCKED account's inbox; the
 * blocker still sees it, named, while the block stands, so they can lift it
 * (getConversationsForUser). The other account must exist
 * (RECIPIENT_NOT_FOUND) and must not be the caller (SELF). Unblocking with no
 * conversation throws CONVERSATION_NOT_FOUND. Returns the projection for
 * `userId`.
 */
export async function setConversationBlocked(userId, otherUserId, blocked) {
  const uid = String(userId);
  const other = String(otherUserId ?? '');
  if (!other) throw dmError(DM_ERRORS.RECIPIENT_NOT_FOUND, 'That account does not exist.');
  if (other === uid) throw dmError(DM_ERRORS.SELF, 'You cannot block yourself');
  if (blocked) {
    const { rows: exists } = await query('select 1 from users where id = $1', [other]);
    if (!exists.length) throw dmError(DM_ERRORS.RECIPIENT_NOT_FOUND, 'That account does not exist.');
    const id = pairId(uid, other);
    await query(
      `insert into conversations (id, data) values ($1, $2)
       on conflict (id) do nothing`,
      [id, { id, participantIds: [uid, other], messages: [], senders: [], createdByBlock: true, blockKind: 'dm' }],
    );
  }
  const { rows } = await query(
    `update conversations
        set data = jsonb_set(
              data, '{blockedBy}',
              (select coalesce(jsonb_agg(distinct b), '[]'::jsonb)
                 from jsonb_array_elements_text(
                        coalesce(data->'blockedBy', '[]'::jsonb) || case when $3::boolean then jsonb_build_array($2::text) else '[]'::jsonb end
                      ) as b
                where $3::boolean or b <> $2::text))
      where id = $1
        and data->'participantIds' ? $2
      returning id, data, updated_at`,
    [pairId(uid, other), uid, !!blocked],
  );
  if (!rows.length) throw dmError(DM_ERRORS.CONVERSATION_NOT_FOUND, 'Conversation not found');
  return projectConversation({ ...rowToRecord(rows[0]), updatedAt: rows[0].updated_at }, uid);
}

/**
 * A LEGACY BLOCK-ONLY row, from the blocker's side: created by a block before
 * wall blocks had their own table (createdByBlock with no blockKind), nothing
 * ever sent in it, and `viewerId` is the one who blocked. Such a row may stand
 * for a wall commenter, whose identity the wall never reveals, so it is only
 * ever shown as an opaque handle (round-9 social#0 / dashboard#1). lib/db.js
 * moves these into wall_blocks on the next schema apply, so this is a guard
 * for a row that slips in between, not a live path. A DM block by id
 * (blockKind 'dm') is not block-only: its blocker knows who it is.
 */
export function isBlockOnlyFor(conversation, viewerId) {
  return !!conversation
    && conversation.createdByBlock === true
    && !conversation.blockKind
    && !(Array.isArray(conversation.messages) && conversation.messages.length)
    && blockedIds(conversation).includes(String(viewerId));
}

function blockHandleKey() {
  return crypto.createHmac('sha256', String(ageVerificationSecret())).update('oa:block-handle:v1').digest();
}

/**
 * An opaque, stable handle for a block-only row, per viewer: an HMAC of the
 * viewer and the pair row's id. It names nothing (the pair id is the two
 * account ids), and two creators blocking the same commenter get unrelated
 * handles, so comparing notes links nobody.
 */
export function blockHandleFor(viewerId, conversationId) {
  const mac = crypto.createHmac('sha256', blockHandleKey()).update(`${String(viewerId)}|${String(conversationId)}`).digest('base64url');
  return `blk_${mac.slice(0, 24)}`;
}

/**
 * The inbox projection of a block-only row: the opaque handle as its id, no
 * counterpart id anywhere (not in `id`, not in `participantIds`), no messages.
 * `blockedByThem` is left false -- whether the other side also blocked is
 * none of this view's business. Unblock it with unblockByHandle.
 */
export function projectBlockOnlyConversation(conversation, viewerId) {
  const handle = blockHandleFor(viewerId, conversation.id);
  return {
    id: handle,
    blockHandle: handle,
    blockOnly: true,
    participantIds: [String(viewerId)],
    messages: [],
    hasMore: false,
    lastMessage: null,
    unreadCount: 0,
    blockedByMe: true,
    blockedByThem: false,
    updatedAt: conversation?.updatedAt || null,
  };
}

const BLOCK_HANDLE_RE = /^blk_[A-Za-z0-9_-]{24}$/;

/**
 * Lifts `userId`'s block that `handle` names -- one of their wall blocks, or a
 * legacy block-only row -- resolved here, server side, against that viewer's
 * own blocks: the counterpart's id never travels. Throws
 * CONVERSATION_NOT_FOUND for a handle that names none of them. Returns
 * { ok: true, blockHandle }.
 */
export async function unblockByHandle(userId, handle) {
  const uid = String(userId ?? '');
  if (!uid || typeof handle !== 'string' || !BLOCK_HANDLE_RE.test(handle)) {
    throw dmError(DM_ERRORS.CONVERSATION_NOT_FOUND, 'Conversation not found');
  }
  const want = Buffer.from(handle);
  const same = (h) => {
    const got = Buffer.from(h);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  };
  const { rows: walls } = await query('select author_id from wall_blocks where owner_user_id = $1', [uid]);
  for (const w of walls) {
    if (same(wallBlockHandleFor(uid, w.author_id))) {
      await setWallBlocked(uid, w.author_id, false);
      return { ok: true, blockHandle: handle };
    }
  }
  const { rows } = await query(
    `select id, data from conversations
      where data->'participantIds' ? $1
        and data ? 'createdByBlock'
        and not data ? 'blockKind'
        and jsonb_array_length(coalesce(data->'messages', '[]'::jsonb)) = 0
        and coalesce(data->'blockedBy', '[]'::jsonb) ? $1`,
    [uid],
  );
  for (const row of rows) {
    if (same(blockHandleFor(uid, row.id))) {
      const other = (row.data?.participantIds || []).map(String).find((id) => id !== uid);
      if (!other) break;
      await setConversationBlocked(uid, other, false);
      return { ok: true, blockHandle: handle };
    }
  }
  throw dmError(DM_ERRORS.CONVERSATION_NOT_FOUND, 'Conversation not found');
}

/**
 * The opaque handle of `viewerId`'s wall block of `authorId`: the same HMAC as
 * blockHandleFor, over a key that cannot collide with a conversation id.
 */
export function wallBlockHandleFor(viewerId, authorId) {
  return blockHandleFor(viewerId, `wall:${String(authorId)}`);
}

/**
 * Whether `ownerUserId` has blocked `authorId` from their wall (and from
 * messaging them). `client` to read inside a transaction.
 */
export async function isWallBlocked(ownerUserId, authorId, client = null) {
  const owner = String(ownerUserId ?? '');
  const author = String(authorId ?? '');
  if (!owner || !author || owner === author) return false;
  const run = client ? (t, p) => client.query(t, p) : query;
  const { rows } = await run('select 1 from wall_blocks where owner_user_id = $1 and author_id = $2', [owner, author]);
  return rows.length > 0;
}

/**
 * Blocks (or unblocks) the author of a comment on `ownerUserId`'s wall. A
 * record of its own (wall_blocks), NOT the DM pair row: it stops the author
 * commenting on this wall (pages/api/wall/post.js) and messaging the owner
 * (sendDirectMessage, quoteDmPrice -- refused as "not accepting messages from
 * you"), and nothing else. It never restricts the owner, and it is never
 * reported on a named thread, a quote or a send of the owner's: those know the
 * author's account, and the wall is built never to (round-10 social#0). The
 * owner sees it on the comment (wallBlockFlagsFor) and as an opaque inbox row
 * (listWallBlocksFor), and lifts it from either.
 *
 * Returns { changed } -- whether the call actually changed anything. Blocking
 * throws RECIPIENT_NOT_FOUND for an account that no longer exists.
 */
export async function setWallBlocked(ownerUserId, authorId, blocked) {
  const owner = String(ownerUserId ?? '');
  const author = String(authorId ?? '');
  if (!author) throw dmError(DM_ERRORS.RECIPIENT_NOT_FOUND, 'That account does not exist.');
  if (owner === author) throw dmError(DM_ERRORS.SELF, 'You cannot block yourself');
  if (blocked) {
    const { rowCount } = await query(
      `insert into wall_blocks (owner_user_id, author_id)
         select $1, $2 where exists (select 1 from users where id = $2)
       on conflict do nothing`,
      [owner, author],
    );
    if (!rowCount) {
      const { rows } = await query('select 1 from users where id = $1', [author]);
      if (!rows.length) throw dmError(DM_ERRORS.RECIPIENT_NOT_FOUND, 'That account does not exist.');
    }
    return { changed: rowCount > 0 };
  }
  const { rowCount } = await query('delete from wall_blocks where owner_user_id = $1 and author_id = $2', [owner, author]);
  return { changed: rowCount > 0 };
}

/** Which of `authorIds` `ownerUserId` has wall-blocked, as a Set of string ids. */
export async function wallBlockedAuthors(ownerUserId, authorIds) {
  const owner = String(ownerUserId ?? '');
  const ids = [...new Set((authorIds || []).map((a) => String(a ?? '')).filter((a) => a && a !== owner))];
  if (!owner || !ids.length) return new Set();
  const { rows } = await query(
    'select author_id from wall_blocks where owner_user_id = $1 and author_id = any($2::text[])',
    [owner, ids],
  );
  return new Set(rows.map((r) => String(r.author_id)));
}

/**
 * `viewerId`'s wall blocks as opaque inbox rows (newest first, at most
 * `limit`): the same shape as projectBlockOnlyConversation, with a handle in
 * place of any id. The inbox is where a block whose comment has since been
 * deleted can still be lifted.
 */
export async function listWallBlocksFor(viewerId, { limit = 200 } = {}) {
  const uid = String(viewerId ?? '');
  if (!uid) return [];
  const { rows } = await query(
    `select author_id, created_at from wall_blocks where owner_user_id = $1
      order by created_at desc limit $2`,
    [uid, Math.min(Math.max(Number(limit) || 200, 1), 500)],
  );
  return rows.map((r) => {
    const handle = wallBlockHandleFor(uid, r.author_id);
    return {
      id: handle,
      blockHandle: handle,
      blockOnly: true,
      wallBlock: true,
      participantIds: [uid],
      messages: [],
      hasMore: false,
      lastMessage: null,
      unreadCount: 0,
      blockedByMe: true,
      blockedByThem: false,
      updatedAt: r.created_at,
    };
  });
}

/**
 * Block state between two accounts, from `userId`'s side: 'me' when userId
 * blocked the other account, 'them' when the other account blocked userId,
 * null otherwise. A DM block lives on the conversation row, but it is the
 * remedy for an abusive account everywhere that account can reach the
 * blocker -- the wall (pages/api/wall/post.js) reads it too. Wall blocks are
 * not included (isWallBlocked).
 */
export async function blockBetween(userId, otherUserId) {
  const uid = String(userId ?? '');
  const other = String(otherUserId ?? '');
  if (!uid || !other || uid === other) return null;
  return blockStateBetween(uid, other);
}

/**
 * Which of `otherUserIds` `userId` has blocked (they are in `blockedBy` on the
 * pair row), as a Set of string ids. One query for a whole page of accounts --
 * the wall owner's view of their wall asks this for every commenter on a page
 * (lib/wall-store.js wallBlockFlagsFor). Only blocks MADE BY `userId` count; a
 * block the other side made is not this viewer's to lift.
 */
export async function accountsBlockedBy(userId, otherUserIds) {
  const uid = String(userId ?? '');
  const others = [...new Set((otherUserIds || []).map((o) => String(o ?? '')).filter((o) => o && o !== uid))];
  if (!uid || !others.length) return new Set();
  const { rows } = await query(
    `select data->'participantIds' as p from conversations
      where id = any($1::text[])
        and coalesce(data->'blockedBy', '[]'::jsonb) ? $2`,
    [others.map((o) => pairId(uid, o)), uid],
  );
  const blocked = new Set();
  for (const row of rows) {
    for (const id of Array.isArray(row.p) ? row.p.map(String) : []) if (id !== uid) blocked.add(id);
  }
  return blocked;
}

/** One stored message of a conversation `userId` takes part in, or null. */
export async function findConversationMessage(userId, otherUserId, messageId) {
  const uid = String(userId);
  const { rows } = await query(
    `select id, data from conversations where id = $1 and data->'participantIds' ? $2`,
    [pairId(uid, otherUserId), uid],
  );
  if (!rows.length) return null;
  const conversation = rowToRecord(rows[0]);
  const message = (conversation.messages || []).find((m) => m && m.id === messageId) || null;
  return message ? { conversationId: conversation.id, participantIds: conversation.participantIds || [], message } : null;
}

/**
 * Moderation: removes one message from a conversation (a reported DM), under
 * a row lock. Returns the removed message, or null when it is already gone.
 *
 * `beforeRemove(client, message)`, when given, runs inside the same
 * transaction BEFORE the message is dropped -- the evidence copy for a
 * possible-minor / non-consensual report is written there, so a failed copy
 * rolls back and leaves the message in place rather than losing it.
 */
export async function removeConversationMessage(conversationId, messageId, { beforeRemove } = {}) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('select id, data from conversations where id = $1 for update', [String(conversationId)]);
    if (!rows.length) return null;
    const current = rowToRecord(rows[0]);
    const all = Array.isArray(current.messages) ? current.messages : [];
    const gone = all.find((m) => m && m.id === messageId);
    if (!gone) return null;
    if (typeof beforeRemove === 'function') await beforeRemove(client, gone);
    await client.query(
      `update conversations set data = jsonb_set(data, '{messages}', $2::jsonb) where id = $1`,
      [String(conversationId), JSON.stringify(all.filter((m) => !m || m.id !== messageId))],
    );
    return gone;
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
    text: sliceText(trimmed, MAX_MESSAGE_LENGTH),
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
